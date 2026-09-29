package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestLegacyBYOKExplicitIdempotencySurvivesCacheLoss(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		t.Run(fmtBool(streaming), func(t *testing.T) {
			var calls atomic.Int32
			h := newHarness(t, harnessOptions{CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				defaultUpstreamHandler()(w, r)
			}})
			headers := map[string]string{"Idempotency-Key": "legacy-explicit-operation"}
			first := h.doChat(chatBody(chatBodyOptions{Stream: streaming}), headers)
			body := readAll(first)
			if first.StatusCode != http.StatusOK {
				t.Fatalf("first=%d %s", first.StatusCode, body)
			}
			h.proxy.idempotency = newIdempotencyCache(time.Minute, 100)
			second := h.doChat(chatBody(chatBodyOptions{Stream: streaming}), headers)
			body = readAll(second)
			if second.StatusCode != http.StatusConflict || !strings.Contains(body, CodeIdempotencyConflict) || calls.Load() != 1 {
				t.Fatalf("duplicate dispatched after cache loss: status=%d calls=%d body=%s", second.StatusCode, calls.Load(), body)
			}
			records := h.store.Requests()
			if len(records) != 1 || records[0].EventV2 != nil || records[0].Event.SchemaVersion != 1 || h.store.OutboxCount(testTenantID) != 1 {
				t.Fatal("claim changed v1 usage or duplicated terminal accounting")
			}
		})
	}
}

// Deliberately exposes only Store, with no optional pre-dispatch claim method.
type legacyStoreOnly struct{ Store }

func TestLegacyBYOKExplicitIdempotencyRequiresDurableStorage(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run(map[bool]string{false: "unhealthy-store", true: "missing-claim-interface"}[missing], func(t *testing.T) {
			var calls atomic.Int32
			h := newHarness(t, harnessOptions{CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				defaultUpstreamHandler()(w, r)
			}})
			if missing {
				h.proxy.store = &legacyStoreOnly{Store: h.store}
			} else {
				h.store.SetHealthy(false)
			}
			response := h.doChat(chatBody(chatBodyOptions{}), map[string]string{"Idempotency-Key": "requires-durable-claim"})
			body := readAll(response)
			if response.StatusCode != http.StatusServiceUnavailable || calls.Load() != 0 || len(h.store.Requests()) != 0 {
				t.Fatalf("unsafe explicit-key dispatch: status=%d calls=%d body=%s", response.StatusCode, calls.Load(), body)
			}
		})
	}
}

func TestLegacyBYOKWithoutKeyKeepsDegradedDispatch(t *testing.T) {
	var calls atomic.Int32
	h := newHarness(t, harnessOptions{CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		defaultUpstreamHandler()(w, r)
	}})
	h.proxy.store = &legacyStoreOnly{Store: h.store}
	h.store.SetHealthy(false)
	h.store.FailNext()
	response := h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(response)
	if calls.Load() != 1 || response.StatusCode != http.StatusInternalServerError || h.store.OutboxCount(testTenantID) != 0 {
		t.Fatalf("no-key BYOK degradation changed: status=%d upstream=%d", response.StatusCode, calls.Load())
	}
}

func TestLegacyBYOKIndependentProxiesCompeteForOneClaim(t *testing.T) {
	var upstreamCalls atomic.Int32
	opts := harnessOptions{CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		defaultUpstreamHandler()(w, r)
	}}
	a, b := newHarness(t, opts), newHarness(t, opts)
	b.proxy.store = a.store
	start := make(chan struct{})
	statuses := make(chan int, 8)
	var wait sync.WaitGroup
	for i := range 8 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			h := []*testHarness{a, b}[i%2]
			response := h.doChat(chatBody(chatBodyOptions{}), map[string]string{"Idempotency-Key": "cross-process-operation"})
			_ = readAll(response)
			statuses <- response.StatusCode
		}()
	}
	close(start)
	wait.Wait()
	close(statuses)
	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[http.StatusOK] != 1 || counts[http.StatusConflict] != 7 || upstreamCalls.Load() != 1 || a.store.OutboxCount(testTenantID) != 1 {
		t.Fatalf("concurrent duplicate escaped durable claim: statuses=%v upstream=%d", counts, upstreamCalls.Load())
	}
}

type uncertainLegacyClaimStore struct {
	*MemoryStore
	commit bool
}

func (s *uncertainLegacyClaimStore) ClaimLegacyBYOK(ctx context.Context, claim *LegacyBYOKClaim) error {
	if s.commit {
		if err := s.MemoryStore.ClaimLegacyBYOK(ctx, claim); err != nil {
			return err
		}
	}
	return errors.New("synthetic private database detail must stay internal")
}

func TestLegacyBYOKClaimFailureNeverDispatches(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(map[bool]string{false: "failed-before-commit", true: "lost-commit-acknowledgment"}[committed], func(t *testing.T) {
			var calls atomic.Int32
			h := newHarness(t, harnessOptions{CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				defaultUpstreamHandler()(w, r)
			}})
			h.proxy.store = &uncertainLegacyClaimStore{MemoryStore: h.store, commit: committed}
			headers := map[string]string{"Idempotency-Key": "uncertain-operation"}
			response := h.doChat(chatBody(chatBodyOptions{}), headers)
			body := readAll(response)
			if response.StatusCode != 503 || calls.Load() != 0 || strings.Contains(body, "synthetic private") {
				t.Fatalf("claim failure dispatched or leaked detail: %d %s upstream=%d", response.StatusCode, body, calls.Load())
			}
			h.proxy.store = h.store
			h.proxy.idempotency = newIdempotencyCache(time.Minute, 100)
			response = h.doChat(chatBody(chatBodyOptions{}), headers)
			_ = readAll(response)
			if committed {
				if response.StatusCode != 409 || calls.Load() != 0 || h.store.OutboxCount(testTenantID) != 0 {
					t.Fatal("uncertain commit was reclaimed or converted into invented usage")
				}
			} else if response.StatusCode != 200 || calls.Load() != 1 {
				t.Fatal("uncommitted claim prevented a safe retry")
			}
		})
	}
}

func TestLegacyBYOKTerminalFailureKeepsClaim(t *testing.T) {
	var calls atomic.Int32
	h := newHarness(t, harnessOptions{CredentialMode: "byok", UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		defaultUpstreamHandler()(w, r)
	}})
	h.store.FailNext()
	headers := map[string]string{"Idempotency-Key": "failed-terminal-operation"}
	response := h.doChat(chatBody(chatBodyOptions{}), headers)
	_ = readAll(response)
	if response.StatusCode != 500 || calls.Load() != 1 || len(h.store.Requests()) != 0 || h.store.OutboxCount(testTenantID) != 0 {
		t.Fatal("failed terminal published partial usage or never exercised upstream")
	}
	h.proxy.idempotency = newIdempotencyCache(time.Minute, 100)
	response = h.doChat(chatBody(chatBodyOptions{}), headers)
	_ = readAll(response)
	if response.StatusCode != 409 || calls.Load() != 1 {
		t.Fatal("failed terminal released durable operation ownership")
	}
}

func legacyClaimFixture(t *testing.T) (*LegacyBYOKClaim, *TerminalRecord) {
	t.Helper()
	h := newHarness(t, harnessOptions{CredentialMode: "byok"})
	response := h.doChat(chatBody(chatBodyOptions{}), map[string]string{"Idempotency-Key": "legacy-claim-fixture"})
	body := readAll(response)
	if response.StatusCode != 200 || len(h.store.Requests()) != 1 {
		t.Fatalf("fixture=%d %s", response.StatusCode, body)
	}
	r := h.store.Requests()[0]
	c := *h.store.legacyClaims[r.RequestID]
	return &c, copyCaptureFixture(t, r)
}

func TestLegacyBYOKTerminalMustMatchDurableClaim(t *testing.T) {
	claim, terminal := legacyClaimFixture(t)
	for _, tc := range []struct {
		name   string
		mutate func(*TerminalRecord)
	}{
		{"tenant", func(r *TerminalRecord) { r.TenantID = "another-tenant"; r.Event.TenantID = r.TenantID }},
		{"organization", func(r *TerminalRecord) { r.OrganizationID = "another-organization" }},
		{"api key", func(r *TerminalRecord) { r.DownstreamKeyID = "another-api-key" }},
		{"requested model", func(r *TerminalRecord) { r.RequestModel = "another-model" }},
		{"idempotency key", func(r *TerminalRecord) { r.IdempotencyKey = "another-key" }},
		{"started at", func(r *TerminalRecord) { r.StartedAt = r.StartedAt.Add(time.Second) }},
		{"trace", func(r *TerminalRecord) { r.TraceID = "another-trace" }},
		{"managed mode", func(r *TerminalRecord) { r.ChannelKind = "platform" }},
		{"charge", func(r *TerminalRecord) { r.ChargeAmount = 1 }},
		{"charge currency", func(r *TerminalRecord) { r.ChargeCurrency = "EUR" }},
		{"reservation", func(r *TerminalRecord) { r.ReservationAmount = 1 }},
		{"released reservation", func(r *TerminalRecord) { r.ReservationReleased = true }},
		{"reservation expiry", func(r *TerminalRecord) { r.ReservationExpiresAt = &r.StartedAt }},
		{"v2 attribution", func(r *TerminalRecord) { r.AttributionContext = &RequestAttributionContext{} }},
		{"v2 event", func(r *TerminalRecord) { r.EventV2 = &UsageEventV2{} }},
		{"claim marker removed", func(r *TerminalRecord) { r.LegacyBYOKClaimed = false }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := NewMemoryStore()
			if err := store.ClaimLegacyBYOK(context.Background(), claim); err != nil {
				t.Fatal(err)
			}
			r := copyCaptureFixture(t, terminal)
			tc.mutate(r)
			if err := store.PersistTerminal(context.Background(), r); !errors.Is(err, ErrReservationConflict) {
				t.Fatalf("tampered %s replaced claim: %v", tc.name, err)
			}
			if len(store.Requests()) != 0 || store.OutboxCount(claim.TenantID) != 0 {
				t.Fatal("rejected terminal changed accounting")
			}
		})
	}
	if err := NewMemoryStore().PersistTerminal(context.Background(), terminal); !errors.Is(err, ErrReservationConflict) {
		t.Fatalf("missing claim was silently inserted: %v", err)
	}
}

func TestLegacyBYOKClaimsShareV2AndTerminalUniqueness(t *testing.T) {
	claim, terminal := legacyClaimFixture(t)
	frozen, _ := captureIdentityFixture(t)
	store := NewMemoryStore()
	if err := store.ClaimLegacyBYOK(context.Background(), claim); err != nil {
		t.Fatal(err)
	}
	other := *claim
	other.RequestID = newRandomID()
	if err := store.ClaimLegacyBYOK(context.Background(), &other); !errors.Is(err, ErrDuplicateRequest) {
		t.Fatalf("second request reused explicit key: %v", err)
	}
	other.TenantID, other.OrganizationID = "tenant-b", "org-b"
	if err := store.ClaimLegacyBYOK(context.Background(), &other); err != nil {
		t.Fatalf("different tenant could not use same key: %v", err)
	}
	frozen.RequestID, frozen.IdempotencyKey = newRandomID(), claim.IdempotencyKey
	if err := store.CaptureRequest(context.Background(), frozen); !errors.Is(err, ErrDuplicateRequest) {
		t.Fatalf("v2 request reused legacy claim key: %v", err)
	}
	frozen.RequestID, frozen.IdempotencyKey = claim.RequestID, "different-key"
	if err := store.CaptureRequest(context.Background(), frozen); !errors.Is(err, ErrStoreUnavailable) {
		t.Fatalf("v2 request reused legacy global id: %v", err)
	}
	// Neither changes to the caller's claim object nor retrying terminal
	// persistence may replace the original operation identity.
	claim.IdempotencyKey = "mutated-input"
	if err := store.PersistTerminal(context.Background(), terminal); err != nil {
		t.Fatalf("valid claim terminal rejected: %v", err)
	}
	if err := store.PersistTerminal(context.Background(), terminal); !errors.Is(err, ErrReservationConflict) {
		t.Fatalf("terminal replay accepted: %v", err)
	}
}

type legacyFailPrimaryTransport struct {
	base        http.RoundTripper
	primaryHost string
	failed      atomic.Int32
}

func (t *legacyFailPrimaryTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Host == t.primaryHost {
		t.failed.Add(1)
		return nil, errors.New("fixture failed before connection assignment")
	}
	return t.base.RoundTrip(r)
}

func TestLegacyBYOKSafeFallbackKeepsExecutionMode(t *testing.T) {
	for _, fallbackMode := range []string{"byok", "managed"} {
		t.Run(fallbackMode, func(t *testing.T) {
			var fallbackCalls atomic.Int32
			fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fallbackCalls.Add(1)
				defaultUpstreamHandler()(w, r)
			}))
			t.Cleanup(fallback.Close)
			h := newHarness(t, harnessOptions{CredentialMode: "byok", MaxAttempts: 2, ExtraChannels: []SnapshotChannel{{
				ID: "fallback", ProviderID: "prov_openai", Provider: "openai", BaseURL: fallback.URL,
				AuthScheme: "bearer", Models: []string{testModel}, Region: "global", DataResidency: "global",
				CredentialMode: fallbackMode, CredentialRef: "fallback-credential", Priority: 1,
				Capabilities: []string{"text", "streaming"}, Enabled: true,
			}}})
			primary, _ := url.Parse(h.upstream.URL)
			transport := &legacyFailPrimaryTransport{base: h.upstream.Client().Transport, primaryHost: primary.Host}
			if transport.base == nil {
				transport.base = http.DefaultTransport
			}
			h.proxy.httpClient = &http.Client{Transport: transport}
			response := h.doChat(chatBody(chatBodyOptions{}), map[string]string{"Idempotency-Key": "fallback-operation"})
			body := readAll(response)
			if transport.failed.Load() != 1 || h.managed.reserveCount() != 0 {
				t.Fatal("fixture did not start in unreserved BYOK mode")
			}
			if fallbackMode == "managed" {
				if fallbackCalls.Load() != 0 || response.StatusCode == 200 {
					t.Fatalf("BYOK crossed into managed execution: status=%d calls=%d", response.StatusCode, fallbackCalls.Load())
				}
			} else {
				if response.StatusCode != 200 || fallbackCalls.Load() != 1 {
					t.Fatalf("safe BYOK fallback failed: %d %s", response.StatusCode, body)
				}
				r := h.store.Requests()[0]
				if r.ProviderCredentialID != "fallback-credential" || len(r.Attempts) != 2 || r.Attempts[1].ChannelID != "fallback" || !r.LegacyBYOKClaimed {
					t.Fatalf("fallback terminal lost actual execution: %+v", r)
				}
			}
		})
	}
}
