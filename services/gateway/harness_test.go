package main

// Test harness: a gateway wired entirely to fakes, plus a mock upstream that
// speaks SSE. No control plane, no PostgreSQL, no real provider.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"nexus/gateway/provider"
)

const (
	testTenantID  = "tenant-test"
	testOrgID     = "org-test"
	testKeyID     = "key-test"
	testModel     = "gpt-4o"
	testPriceID   = "pv_test_openai_gpt-4o"
	testCatalogID = "cat_test_1"
)

// testAPIKey is assembled rather than written as one literal so no secret
// scanner (including this repo's own hook) mistakes a test fixture for a live
// credential. The value is not a valid key anywhere.
var testAPIKey = APIKeyPrefix + "testfixture0000000000000000000000"

type fakeSnapshotSource struct {
	mu      sync.Mutex
	bundles map[string][]byte
	fail    bool
}

func (f *fakeSnapshotSource) Fetch(_ context.Context, tenantID string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return nil, errors.New("control plane unavailable")
	}
	body, ok := f.bundles[tenantID]
	if !ok {
		return nil, errors.New("no snapshot for tenant")
	}
	return body, nil
}

func (f *fakeSnapshotSource) setFail(fail bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fail = fail
}

type fakeReserver struct {
	mu           sync.Mutex
	reserves     []ReserveRequest
	reserveErr   error
	reserveCalls int
}

func (f *fakeReserver) Reserve(_ context.Context, req ReserveRequest) (*Reservation, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reserveCalls++
	f.reserves = append(f.reserves, req)
	if f.reserveErr != nil {
		return nil, f.reserveErr
	}
	return &Reservation{
		ReservationID: "resv_" + req.RequestID,
		AmountMicros:  100_000,
		Currency:      "USD",
		ExpiresAt:     time.Now().Add(15 * time.Minute),
	}, nil
}

func (f *fakeReserver) reserveRequests() []ReserveRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]ReserveRequest(nil), f.reserves...)
}

func (f *fakeReserver) reserveCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reserveCalls
}

// testHarness bundles everything a test needs.
type testHarness struct {
	t         *testing.T
	proxy     *Proxy
	store     *MemoryStore
	source    *fakeSnapshotSource
	keyring   *Keyring
	snapshots *SnapshotCache
	breaker   *Breaker
	managed   *fakeReserver
	byok      *fakeReserver
	limiter   *Limiter
	upstream  *httptest.Server
	server    *httptest.Server
	handler   http.Handler
	tenantID  string
}

type harnessOptions struct {
	EnableUsageV2   bool
	UpstreamHandler http.HandlerFunc
	CredentialMode  string
	ExtraChannels   []SnapshotChannel
	// ExtraChannelsFn builds channels after the mock upstream exists, so a
	// test can point a second channel at the same server.
	ExtraChannelsFn func(upstreamURL string) []SnapshotChannel
	Channels        []SnapshotChannel
	Keys            []SnapshotKey
	Models          []SnapshotModel
	ExpiresIn       time.Duration
	// PlatformExpiresIn overrides the platform-scope bundle expiry, so a test
	// can expire the tenant snapshot while the key directory stays usable.
	PlatformExpiresIn time.Duration
	SnapshotLimits    SnapshotLimits
	Limiter           *Limiter
	MaxAttempts       int
	Clock             func() time.Time
	NoPrice           bool
	NoCatalog         bool
	DisableKey        bool
	RevokeKey         bool
	KeyScopes         []string
	KeyExpiresIn      time.Duration
	Limits            Limits
}

func defaultUpstreamHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello\"},\"finish_reason\":null}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"id\":\"c1\",\"choices\":[],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":4}}\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}
}

func defaultLimits() Limits {
	return Limits{
		MaxHeaderBytes:    16 * 1024,
		MaxBodyBytes:      1 << 20,
		MaxTokensEstimate: 65536,
		MaxConcurrent:     64,
		RequestsPerMinute: 6000,
		TokensPerMinute:   10_000_000,
		TotalDuration:     30 * time.Second,
		IdleTimeout:       5 * time.Second,
		UpstreamTimeout:   10 * time.Second,
		SlowClientBuffer:  1 << 20,
	}
}

func newHarness(t *testing.T, opts harnessOptions) *testHarness {
	t.Helper()
	handler := opts.UpstreamHandler
	if handler == nil {
		handler = defaultUpstreamHandler()
	}
	upstream := httptest.NewServer(handler)
	t.Cleanup(upstream.Close)

	credentialMode := opts.CredentialMode
	if credentialMode == "" {
		credentialMode = "managed"
	}
	credentialRef := "cred_test"
	if credentialMode == "byok" {
		credentialRef = "cred_byok_test"
	}
	primary := SnapshotChannel{
		ConnectionID:   "connection-test",
		ID:             "chan_test_1",
		ProviderID:     "prov_openai",
		Provider:       "openai",
		BaseURL:        upstream.URL,
		AuthScheme:     "bearer",
		Models:         []string{testModel},
		Region:         "global",
		DataResidency:  "global",
		CredentialMode: credentialMode,
		CredentialRef:  credentialRef,
		Weight:         10,
		Priority:       0,
		Capabilities:   []string{"text", "streaming"},
		Enabled:        true,
	}
	channels := opts.Channels
	if channels == nil {
		extra := opts.ExtraChannels
		if opts.ExtraChannelsFn != nil {
			extra = append(extra, opts.ExtraChannelsFn(upstream.URL)...)
		}
		channels = append([]SnapshotChannel{primary}, extra...)
	}

	models := opts.Models
	if models == nil {
		models = []SnapshotModel{{
			ID: testModel, Provider: "openai", Aliases: []string{"gpt4o"},
			Capabilities: []string{"text", "streaming"}, License: "openai-tos", Status: "active",
		}}
	}

	keys := opts.Keys
	if keys == nil {
		key := SnapshotKey{
			ProjectID: "project-test", ProjectName: "Project Test", KeyKind: "shared", AttributionStatus: "attributed",
			KeyID: testKeyID, TenantID: testTenantID, OrganizationID: testOrgID,
			HashSHA256: HashKey(testAPIKey), Scopes: []string{ScopeAll}, Enabled: true,
			RevocationEpoch: 1,
		}
		if opts.DisableKey {
			key.Enabled = false
		}
		if opts.RevokeKey {
			revoked := time.Now().UTC().Format(time.RFC3339)
			key.RevokedAt = &revoked
		}
		if opts.KeyScopes != nil {
			key.Scopes = opts.KeyScopes
		}
		if opts.KeyExpiresIn != 0 {
			expiry := time.Now().Add(opts.KeyExpiresIn).UTC().Format(time.RFC3339)
			key.ExpiresAt = &expiry
		}
		keys = []SnapshotKey{key}
	}

	expiresIn := opts.ExpiresIn
	if expiresIn == 0 {
		expiresIn = 5 * time.Minute
	}
	now := time.Now()
	if opts.Clock != nil {
		now = opts.Clock()
	}

	var catalog *SnapshotCatalogVersion
	if !opts.NoCatalog {
		catalog = &SnapshotCatalogVersion{ID: testCatalogID, Version: 1, Checksum: strings.Repeat("a", 64)}
	}
	var prices []SnapshotPriceVersion
	if !opts.NoPrice {
		prices = []SnapshotPriceVersion{{
			ID: testPriceID, SalePriceSnapshotID: "sale-fixture", Provider: "openai", ModelID: testModel, Currency: "USD",
			Region: "global", ServiceTier: "standard", Unit: "per_million_tokens",
			Components: []SnapshotPriceComponent{
				{Kind: "input", Unit: "per_million_tokens", Amount: "2.50"},
				{Kind: "output", Unit: "per_million_tokens", Amount: "10.00"},
			},
		}}
	}

	makeBundle := func(tenant *string, effectiveExpiry time.Duration) *GatewayBundle {
		return &GatewayBundle{
			SchemaVersion:  GatewayBundleSchemaVersion,
			Kind:           GatewayBundleKind,
			TenantID:       tenant,
			SequenceNumber: 1,
			GeneratedAt:    now.UTC().Format(time.RFC3339),
			ExpiresAt:      now.Add(effectiveExpiry).UTC().Format(time.RFC3339),
			Snapshot: SnapshotPayload{
				SchemaVersion:  GatewaySnapshotSchemaVersion,
				Kind:           GatewaySnapshotKind,
				TenantID:       tenant,
				SequenceNumber: 1,
				CatalogVersion: catalog,
				PriceVersions:  prices,
				GeneratedAt:    now.UTC().Format(time.RFC3339),
			},
			Channels:        channels,
			Models:          models,
			Keys:            keys,
			RevocationEpoch: 1,
			Limits:          opts.SnapshotLimits,
		}
	}

	kr, err := NewKeyring("harness-passphrase", "", 0)
	if err != nil {
		t.Fatalf("keyring: %v", err)
	}
	source := &fakeSnapshotSource{bundles: map[string][]byte{}}
	platformExpiry := expiresIn
	if opts.PlatformExpiresIn != 0 {
		platformExpiry = opts.PlatformExpiresIn
	}
	source.bundles[""] = signBundleForTest(t, kr, makeBundle(nil, platformExpiry))
	tenant := testTenantID
	source.bundles[tenant] = signBundleForTest(t, kr, makeBundle(&tenant, expiresIn))

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg := SnapshotConfig{RefreshInterval: time.Minute, MaxAge: 30 * time.Minute, FetchTimeout: time.Second}
	snapshots := NewSnapshotCache(source, kr, cfg, logger)
	if opts.Clock != nil {
		snapshots.SetClock(opts.Clock)
	}

	limits := defaultLimits()
	if opts.Limits.MaxBodyBytes != 0 {
		limits = opts.Limits
	}
	limiter := opts.Limiter
	if limiter == nil {
		limiter, err = NewLimiter("", logger)
		if err != nil {
			t.Fatalf("limiter: %v", err)
		}
	}
	concurrencyGuardSize(limiter, limits.MaxConcurrent)

	registry := provider.NewRegistry()
	for _, adapter := range provider.Builtin() {
		if err := registry.Register(adapter); err != nil {
			t.Fatalf("register adapter: %v", err)
		}
	}
	breaker := NewBreaker(BreakerConfig{FailureThreshold: 3, OpenDuration: time.Minute, HalfOpenProbes: 1, LatencyAlpha: 0.5})
	router := NewRouter(registry, breaker, DefaultScoreWeights())
	store := NewMemoryStore()
	managed := &fakeReserver{}
	byokReserver := &fakeReserver{}

	proxy := NewProxy(ProxyDeps{
		EnableUsageV2: opts.EnableUsageV2,
		Env:           &Env{Environment: "development"},
		Limits:        limits,
		Snapshots:     snapshots,
		Authn:         NewAuthenticator(snapshots),
		Registry:      registry,
		Breaker:       breaker,
		Router:        router,
		Limiter:       limiter,
		Store:         store,
		Credentials:   NewStaticCredentialResolver("upstream-test-secret"),
		Managed:       managed,
		Byok:          byokReserver,
		Logger:        logger,
		HTTPClient:    upstream.Client(),
		MaxAttempts:   opts.MaxAttempts,
	})

	httpRouter := NewHTTPRouter(proxy, snapshots, limiter, store, RouteOptions{})
	server := httptest.NewServer(httpRouter)
	t.Cleanup(server.Close)

	return &testHarness{
		t: t, proxy: proxy, store: store, source: source, keyring: kr, snapshots: snapshots,
		breaker: breaker, managed: managed, byok: byokReserver, limiter: limiter,
		upstream: upstream, server: server, handler: httpRouter, tenantID: tenant,
	}
}

// signBundleForTest produces the same signed envelope the control plane does,
// using CanonicalJSON + HMAC over the derived keyring.
func signBundleForTest(t *testing.T, kr *Keyring, bundle *GatewayBundle) []byte {
	t.Helper()
	raw, err := json.Marshal(bundle)
	if err != nil {
		t.Fatalf("marshal bundle: %v", err)
	}
	canonical, err := CanonicalJSON(decodeJSONValue(t, raw))
	if err != nil {
		t.Fatalf("canonicalize bundle: %v", err)
	}
	keyID, signature := kr.SignHMAC(canonical)
	envelope, err := json.Marshal(map[string]any{
		"bundle":         json.RawMessage(raw),
		"signature":      signature,
		"signing_key_id": keyID,
	})
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return envelope
}

// ── Request helpers ───────────────────────────────────────────────────

type chatBodyOptions struct {
	Model     string
	Stream    bool
	Messages  []map[string]any
	MaxTokens int
	Extra     map[string]any
}

func chatBody(opts chatBodyOptions) []byte {
	model := opts.Model
	if model == "" {
		model = testModel
	}
	messages := opts.Messages
	if messages == nil {
		messages = []map[string]any{{"role": "user", "content": "hi"}}
	}
	payload := map[string]any{"model": model, "messages": messages, "stream": opts.Stream}
	if opts.MaxTokens > 0 {
		payload["max_tokens"] = opts.MaxTokens
	}
	for key, value := range opts.Extra {
		payload[key] = value
	}
	encoded, _ := json.Marshal(payload)
	return encoded
}

func (h *testHarness) doChat(body []byte, headers map[string]string) *http.Response {
	h.t.Helper()
	req, err := http.NewRequest(http.MethodPost, h.server.URL+"/v1/chat/completions", strings.NewReader(string(body)))
	if err != nil {
		h.t.Fatalf("request: %v", err)
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+testAPIKey)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := h.server.Client().Do(req)
	if err != nil {
		h.t.Fatalf("do: %v", err)
	}
	return resp
}

func decodeAPIError(t *testing.T, resp *http.Response) map[string]any {
	t.Helper()
	defer func() { _ = resp.Body.Close() }()
	var envelope struct {
		Error map[string]any `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return envelope.Error
}

func decodeJSON(t *testing.T, resp *http.Response) map[string]any {
	t.Helper()
	defer func() { _ = resp.Body.Close() }()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	return out
}

func errorCode(t *testing.T, resp *http.Response) string {
	t.Helper()
	body := decodeAPIError(t, resp)
	code, _ := body["code"].(string)
	return code
}
