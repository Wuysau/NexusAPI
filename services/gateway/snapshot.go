package main

// Signed configuration snapshots (ADR-0001, INVARIANT #8).
//
// The gateway never reads the control-plane database for configuration. It
// pulls a signed bundle from the control plane's internal API, verifies the
// HMAC with the shared keyring, and swaps it in atomically. When the control
// plane is unreachable the last-known-good bundle is used until it expires;
// once expired the gateway fails closed (GATEWAY_SPEC "降级").
//
// The bundle carries everything the hot path needs to route without another
// control-plane round trip: catalog version, active price versions, routing
// policies, channels (provider endpoints + credential references, never
// plaintext secrets) and per-tenant limits.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// GatewayBundleSchemaVersion is the schema this build understands. A bundle
// with a higher version is rejected fail-closed rather than partially applied.
const (
	GatewayBundleSchemaVersion   = 1
	GatewaySnapshotSchemaVersion = 1
	GatewayBundleKind            = "gateway_bundle"
	GatewaySnapshotKind          = "gateway_snapshot"
)

// ── Bundle schema ─────────────────────────────────────────────────────

type SnapshotCatalogVersion struct {
	ID       string `json:"id"`
	Version  int    `json:"version"`
	Checksum string `json:"checksum"`
}

type SnapshotPriceComponent struct {
	Kind       string         `json:"kind"`
	Unit       string         `json:"unit"`
	Amount     string         `json:"amount"`
	Conditions map[string]any `json:"conditions"`
}

type SnapshotPriceVersion struct {
	ID            string                   `json:"id"`
	Provider      string                   `json:"provider"`
	ModelID       string                   `json:"model_id"`
	Currency      string                   `json:"currency"`
	Region        string                   `json:"region"`
	ServiceTier   string                   `json:"service_tier"`
	Unit          string                   `json:"unit"`
	EffectiveFrom *string                  `json:"effective_from"`
	EffectiveTo   *string                  `json:"effective_to"`
	Components    []SnapshotPriceComponent `json:"components"`
	// INVARIANT #4 pin: the sale-price and exchange-rate snapshots the gateway
	// persists on request_records so settle can recompute from the frozen rates.
	SalePriceSnapshotID    string `json:"sale_price_snapshot_id,omitempty"`
	ExchangeRateSnapshotID string `json:"exchange_rate_snapshot_id,omitempty"`
}

type SnapshotModelRoute struct {
	ModelID  string  `json:"modelId"`
	Weight   float64 `json:"weight"`
	Priority *int    `json:"priority"`
}

type SnapshotRoutingPolicy struct {
	ID             string               `json:"id"`
	Version        int                  `json:"version"`
	Checksum       string               `json:"checksum"`
	CredentialMode string               `json:"credential_mode"`
	ModelRoutes    []SnapshotModelRoute `json:"model_routes"`
}

// SnapshotPayload is the payload the control plane signs with
// signSnapshot() — the gateway only verifies it, never constructs it.
type SnapshotPayload struct {
	SchemaVersion   int                     `json:"schema_version"`
	Kind            string                  `json:"kind"`
	TenantID        *string                 `json:"tenant_id"`
	SequenceNumber  int64                   `json:"sequence_number"`
	CatalogVersion  *SnapshotCatalogVersion `json:"catalog_version"`
	PriceVersions   []SnapshotPriceVersion  `json:"price_versions"`
	RoutingPolicies []SnapshotRoutingPolicy `json:"routing_policies"`
	GeneratedAt     string                  `json:"generated_at"`
}

// SnapshotChannel is one routable upstream account. It carries a credential
// reference, never the credential itself: the secret is resolved through the
// control plane's Secret Plane at request time and is never persisted here.
type SnapshotChannel struct {
	Transport    string `json:"transport,omitempty"`
	TenantID     string `json:"tenant_id,omitempty"`
	ProjectID    string `json:"project_id,omitempty"`
	ID           string `json:"id"`
	ConnectionID string `json:"connection_id"`
	// ProviderID is the control-plane providers.id, needed for the foreign key
	// on request_records/attempts; Provider is the adapter code.
	ProviderID            string   `json:"provider_id"`
	Provider              string   `json:"provider"`
	Protocol              string   `json:"protocol,omitempty"`
	BaseURL               string   `json:"base_url"`
	AuthScheme            string   `json:"auth_scheme"`
	Models                []string `json:"models"`
	Region                string   `json:"region"`
	DataResidency         string   `json:"data_residency"`
	CredentialMode        string   `json:"credential_mode"` // managed | byok
	CredentialRef         string   `json:"credential_ref"`
	CredentialVersion     int64    `json:"credential_version,omitempty"`
	CredentialFingerprint string   `json:"credential_fingerprint"`
	Weight                int      `json:"weight"`
	Priority              int      `json:"priority"`
	Capabilities          []string `json:"capabilities"`
	Enabled               bool     `json:"enabled"`
}

// SnapshotModel is one published model plus the aliases that resolve to it.
// Without this the gateway could not honour an alias or enforce a model licence
// without calling the control plane on the hot path.
type SnapshotModel struct {
	ID              string   `json:"id"`
	Provider        string   `json:"provider"`
	Aliases         []string `json:"aliases"`
	Capabilities    []string `json:"capabilities"`
	ContextWindow   int      `json:"context_window"`
	MaxOutputTokens int      `json:"max_output_tokens"`
	// License is the provider's model licence identifier; an empty value means
	// "not cleared for routing" and the model is hard-filtered out.
	License string `json:"license"`
	Status  string `json:"status"`
}

// SnapshotKey is one downstream key in the signed key directory.
//
// The gateway verifies downstream keys LOCALLY against this directory rather
// than calling the control plane per request. That is what INVARIANT #8 means
// by "the data plane does not depend on the control plane being available":
// with a per-request verify call, a control-plane outage would take the gateway
// down with it, and the p95 overhead target could not be met. Revocation
// propagates through the next signed snapshot (bounded by the refresh interval),
// so the only cost is a short, explicit revocation window.
//
// Only the sha256 of the key is carried. The plaintext key never leaves the
// caller's Authorization header.
type SnapshotKey struct {
	KeyID string `json:"key_id"`
	// TenantID binds the key to its tenant: the platform key directory spans
	// tenants, and this is what makes the presented key resolve to exactly one.
	TenantID          string   `json:"tenant_id"`
	HashSHA256        string   `json:"hash_sha256"`
	Scopes            []string `json:"scopes"`
	Enabled           bool     `json:"enabled"`
	ExpiresAt         *string  `json:"expires_at"`
	RevokedAt         *string  `json:"revoked_at"`
	Fingerprint       string   `json:"fingerprint"`
	OrganizationID    string   `json:"organization_id"`
	ProjectID         string   `json:"project_id"`
	ProjectName       string   `json:"project_name"`
	KeyKind           string   `json:"key_kind"`
	PrincipalID       *string  `json:"principal_id"`
	AttributionStatus string   `json:"attribution_status"`
	ConnectionID      string   `json:"connection_id"`
	ExecutionMode     string   `json:"execution_mode"`
	// EnforcementEpoch is bumped by the control plane whenever key state
	// changes, so a stale directory is recognisable in telemetry.
	RevocationEpoch int64 `json:"revocation_epoch"`
}

// SnapshotLimits are per-tenant caps that may only tighten the system caps.
type SnapshotLimits struct {
	RequestsPerMinute     int  `json:"requests_per_minute"`
	TokensPerMinute       int  `json:"tokens_per_minute"`
	MaxConcurrent         int  `json:"max_concurrent"`
	ByokContinueWhenStale bool `json:"byok_continue_when_stale"`
}

// GatewayBundle is the signed unit the gateway consumes.
type GatewayBundle struct {
	SchemaVersion   int               `json:"schema_version"`
	Kind            string            `json:"kind"`
	TenantID        *string           `json:"tenant_id"`
	SequenceNumber  int64             `json:"sequence_number"`
	GeneratedAt     string            `json:"generated_at"`
	ExpiresAt       string            `json:"expires_at"`
	Snapshot        SnapshotPayload   `json:"snapshot"`
	Channels        []SnapshotChannel `json:"channels"`
	Models          []SnapshotModel   `json:"models"`
	Keys            []SnapshotKey     `json:"keys"`
	RevocationEpoch int64             `json:"revocation_epoch"`
	Limits          SnapshotLimits    `json:"limits"`
}

// ResolveModel maps a client-supplied model name (id or alias) to the published
// model. Exact id wins over an alias so a provider can never shadow a canonical
// id with an alias entry.
func (b *GatewayBundle) ResolveModel(requested string) (*SnapshotModel, bool) {
	for i := range b.Models {
		if b.Models[i].ID == requested {
			return &b.Models[i], true
		}
	}
	for i := range b.Models {
		for _, alias := range b.Models[i].Aliases {
			if alias == requested {
				return &b.Models[i], true
			}
		}
	}
	return nil, false
}

// KeyByHash indexes the signed key directory by the sha256 of the presented
// key. Built once per snapshot swap, read-only afterwards.
func (b *GatewayBundle) KeyByHash(hashHex string) *SnapshotKey {
	for i := range b.Keys {
		if b.Keys[i].HashSHA256 == hashHex {
			return &b.Keys[i]
		}
	}
	return nil
}

// ── Errors ────────────────────────────────────────────────────────────

// SnapshotError carries a stable, log-safe reason. It never embeds response
// bodies or key material.
type SnapshotError struct {
	Reason string
	Err    error
}

func (e *SnapshotError) Error() string {
	if e.Err != nil {
		return "snapshot: " + e.Reason + ": " + e.Err.Error()
	}
	return "snapshot: " + e.Reason
}

func (e *SnapshotError) Unwrap() error { return e.Err }

const (
	ReasonSnapshotUnavailable = "snapshot_unavailable"
	ReasonSnapshotExpired     = "snapshot_expired"
	ReasonSnapshotRejected    = "snapshot_rejected"
)

// ── Source ────────────────────────────────────────────────────────────

// SnapshotSource fetches the raw signed bundle response body for a tenant.
type SnapshotSource interface {
	Fetch(ctx context.Context, tenantID string) ([]byte, error)
}

// HTTPSnapshotSource calls the control plane's internal snapshot endpoint.
type HTTPSnapshotSource struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

func (s *HTTPSnapshotSource) Fetch(ctx context.Context, tenantID string) ([]byte, error) {
	url := s.BaseURL + "/api/internal/gateway/snapshot"
	if tenantID != "" {
		url += "?tenant_id=" + tenantID
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+s.Token)
	req.Header.Set("Accept", "application/json")
	resp, err := s.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	// Bounded read: a snapshot is configuration, not a payload stream.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("snapshot http %d", resp.StatusCode)
	}
	return body, nil
}

// ── Verification ──────────────────────────────────────────────────────

// VerifiedBundle is the result of signature + schema validation.
type VerifiedBundle struct {
	Bundle       *GatewayBundle
	Signature    string
	SigningKeyID string
	Canonical    string
	ReceivedAt   time.Time
	ExpiresAt    time.Time
}

type snapshotEnvelope struct {
	Bundle       json.RawMessage `json:"bundle"`
	Signature    string          `json:"signature"`
	SigningKeyID string          `json:"signing_key_id"`
}

// VerifySnapshotResponse validates the signed envelope. `expectedTenant` is the
// tenant the bundle was requested for; a bundle for a different tenant is
// rejected even though the signature is valid (defence in depth against a
// confused-deputy replay).
func VerifySnapshotResponse(body []byte, keyring *Keyring, expectedTenant string, now time.Time) (*VerifiedBundle, error) {
	var env snapshotEnvelope
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.UseNumber()
	if err := dec.Decode(&env); err != nil {
		return nil, &SnapshotError{Reason: ReasonSnapshotRejected, Err: errors.New("malformed envelope")}
	}
	if len(env.Bundle) == 0 {
		return nil, &SnapshotError{Reason: ReasonSnapshotRejected, Err: errors.New("bundle missing")}
	}

	// Canonicalize the bundle exactly as the signer did, then verify HMAC.
	bundleValue := decodeWithNumbers(env.Bundle)
	canonical, err := CanonicalJSON(bundleValue)
	if err != nil {
		return nil, &SnapshotError{Reason: ReasonSnapshotRejected, Err: err}
	}
	if err := keyring.VerifyHMAC(env.SigningKeyID, canonical, env.Signature); err != nil {
		return nil, &SnapshotError{Reason: ReasonSnapshotRejected, Err: err}
	}

	var bundle GatewayBundle
	if err := json.Unmarshal(env.Bundle, &bundle); err != nil {
		return nil, &SnapshotError{Reason: ReasonSnapshotRejected, Err: errors.New("bundle decode failed")}
	}

	if bundle.Kind != GatewayBundleKind {
		return nil, &SnapshotError{Reason: ReasonSnapshotRejected, Err: fmt.Errorf("wrong bundle kind %q", bundle.Kind)}
	}
	if bundle.SchemaVersion != GatewayBundleSchemaVersion {
		// N/N-1: a bundle the gateway does not understand is refused, never
		// partially applied.
		return nil, &SnapshotError{
			Reason: ReasonSnapshotRejected,
			Err:    fmt.Errorf("unsupported bundle schema_version %d", bundle.SchemaVersion),
		}
	}
	if bundle.Snapshot.Kind != GatewaySnapshotKind || bundle.Snapshot.SchemaVersion != GatewaySnapshotSchemaVersion {
		return nil, &SnapshotError{Reason: ReasonSnapshotRejected, Err: errors.New("nested snapshot schema mismatch")}
	}
	if tenantIDOf(bundle.TenantID) != expectedTenant {
		return nil, &SnapshotError{Reason: ReasonSnapshotRejected, Err: errors.New("tenant mismatch")}
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, bundle.ExpiresAt)
	if err != nil {
		return nil, &SnapshotError{Reason: ReasonSnapshotRejected, Err: errors.New("expires_at missing or malformed")}
	}

	return &VerifiedBundle{
		Bundle:       &bundle,
		Signature:    env.Signature,
		SigningKeyID: env.SigningKeyID,
		Canonical:    canonical,
		ReceivedAt:   now,
		ExpiresAt:    expiresAt,
	}, nil
}

func tenantIDOf(id *string) string {
	if id == nil {
		return ""
	}
	return *id
}

func decodeWithNumbers(raw []byte) any {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return nil
	}
	return value
}

// ── Cache ─────────────────────────────────────────────────────────────

// SnapshotState is an immutable snapshot generation plus its freshness window.
type SnapshotState struct {
	Verified *VerifiedBundle
	// EffectiveExpiry is min(signed expires_at, receivedAt + MaxAge). The
	// gateway's own ceiling keeps a bundle with an absurdly distant expiry from
	// being trusted indefinitely.
	EffectiveExpiry time.Time
	FetchedAt       time.Time
}

// Fresh reports whether the snapshot may still be used.
func (s *SnapshotState) Fresh(now time.Time) bool {
	return now.Before(s.EffectiveExpiry)
}

type snapshotEntry struct {
	state     atomic.Pointer[SnapshotState]
	refreshMu sync.Mutex
}

// SnapshotCache keeps per-tenant last-known-good bundles with single-flight
// refresh. Reads are lock-free; only refresh serialises.
type SnapshotCache struct {
	source  SnapshotSource
	keyring *Keyring
	cfg     SnapshotConfig
	logger  *slog.Logger

	// now is injectable so expiry behaviour is deterministic under test.
	now func() time.Time

	mu      sync.Mutex
	entries map[string]*snapshotEntry
}

func NewSnapshotCache(source SnapshotSource, keyring *Keyring, cfg SnapshotConfig, logger *slog.Logger) *SnapshotCache {
	if logger == nil {
		logger = slog.Default()
	}
	return &SnapshotCache{
		source:  source,
		keyring: keyring,
		cfg:     cfg,
		logger:  logger,
		now:     time.Now,
		entries: make(map[string]*snapshotEntry),
	}
}

// SetClock overrides the cache clock. Test-only.
func (c *SnapshotCache) SetClock(now func() time.Time) { c.now = now }

func (c *SnapshotCache) entryFor(tenantID string) *snapshotEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[tenantID]
	if !ok {
		e = &snapshotEntry{}
		c.entries[tenantID] = e
	}
	return e
}

// Get returns the best available snapshot for a tenant.
//
// Return contract:
//   - (state, nil)          fresh snapshot, safe to serve
//   - (state, SnapshotError) stale (expired) snapshot retained for diagnostics;
//     the caller decides managed-vs-BYOK, defaulting to fail-closed
//   - (nil, SnapshotError)  nothing usable
func (c *SnapshotCache) Get(ctx context.Context, tenantID string) (*SnapshotState, error) {
	e := c.entryFor(tenantID)
	now := c.now()
	if st := e.state.Load(); st != nil && st.Fresh(now) {
		return st, nil
	}

	e.refreshMu.Lock()
	defer e.refreshMu.Unlock()

	now = c.now()
	stale := e.state.Load()
	if stale != nil && stale.Fresh(now) {
		return stale, nil
	}

	fresh, err := c.fetchAndVerify(ctx, tenantID, now)
	if err == nil {
		e.state.Store(fresh)
		return fresh, nil
	}
	c.logger.Warn("snapshot refresh failed", "tenant", tenantID, "reason", err.Error())

	if stale != nil {
		return stale, &SnapshotError{Reason: ReasonSnapshotExpired, Err: err}
	}
	return nil, &SnapshotError{Reason: ReasonSnapshotUnavailable, Err: err}
}

func (c *SnapshotCache) fetchAndVerify(ctx context.Context, tenantID string, now time.Time) (*SnapshotState, error) {
	fetchCtx, cancel := context.WithTimeout(ctx, c.cfg.FetchTimeout)
	defer cancel()
	body, err := c.source.Fetch(fetchCtx, tenantID)
	if err != nil {
		return nil, err
	}
	verified, err := VerifySnapshotResponse(body, c.keyring, tenantID, now)
	if err != nil {
		return nil, err
	}
	effective := verified.ExpiresAt
	if ceiling := now.Add(c.cfg.MaxAge); ceiling.Before(effective) {
		effective = ceiling
	}
	c.logger.Info("snapshot swapped",
		"tenant", tenantID,
		"sequence", verified.Bundle.SequenceNumber,
		"signing_key_id", verified.SigningKeyID,
		"expires_at", verified.ExpiresAt.UTC().Format(time.RFC3339),
	)
	return &SnapshotState{Verified: verified, EffectiveExpiry: effective, FetchedAt: now}, nil
}

// Ready reports whether at least one tenant scope has a usable snapshot.
func (c *SnapshotCache) Ready() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	for _, e := range c.entries {
		if st := e.state.Load(); st != nil && st.Fresh(now) {
			return true
		}
	}
	return false
}

// KnownTenants lists the tenant scopes the cache has seen, so the background
// refresher can keep them warm. The platform scope is always included.
func (c *SnapshotCache) KnownTenants() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, 0, len(c.entries)+1)
	out = append(out, "")
	for tenant := range c.entries {
		if tenant != "" {
			out = append(out, tenant)
		}
	}
	return out
}

// WarmAll refreshes every known scope. Errors are logged, not returned: the
// background refresher must not stop on one bad scope.
func (c *SnapshotCache) WarmAll(ctx context.Context) {
	for _, tenant := range c.KnownTenants() {
		e := c.entryFor(tenant)
		e.refreshMu.Lock()
		fresh, err := c.fetchAndVerify(ctx, tenant, c.now())
		if err == nil {
			e.state.Store(fresh)
		} else {
			// Keep the last verified state and its original expiry. Background
			// polls must fetch even before expiry so key changes take effect
			// within RefreshInterval without adding I/O to authenticated traffic.
			c.logger.Warn("snapshot refresh failed", "tenant", tenant, "reason", err.Error())
		}
		e.refreshMu.Unlock()
	}
}

// RunRefresher keeps known scopes warm until ctx is cancelled. It is a single
// goroutine that exits with the process (no leaked tickers).
func (c *SnapshotCache) RunRefresher(ctx context.Context) {
	ticker := time.NewTicker(c.cfg.RefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.WarmAll(ctx)
		}
	}
}

// LookupPrice returns the active price version for provider+model, preferring a
// region match. Prices come only from the signed snapshot — never from
// src/lib/catalog.ts or any hard-coded table (INVARIANTS #4/#5).
func (b *GatewayBundle) LookupPrice(provider, modelID, region string) *SnapshotPriceVersion {
	var fallback *SnapshotPriceVersion
	for i := range b.Snapshot.PriceVersions {
		pv := &b.Snapshot.PriceVersions[i]
		if pv.Provider != provider || pv.ModelID != modelID {
			continue
		}
		if region != "" && pv.Region == region {
			return pv
		}
		if fallback == nil || pv.Region == "global" {
			fallback = pv
		}
	}
	return fallback
}

// ChannelByCredentialRef finds the channel a health/circuit report refers to.
func (b *GatewayBundle) ChannelByID(id string) *SnapshotChannel {
	for i := range b.Channels {
		if b.Channels[i].ID == id {
			return &b.Channels[i]
		}
	}
	return nil
}

// LimitsFor merges the system caps with the tenant's snapshot caps. Tenant caps
// may only tighten, never relax.
func (b *GatewayBundle) LimitsFor(system Limits) Limits {
	merged := system
	if v := b.Limits.RequestsPerMinute; v > 0 && v < merged.RequestsPerMinute {
		merged.RequestsPerMinute = v
	}
	if v := b.Limits.TokensPerMinute; v > 0 && v < merged.TokensPerMinute {
		merged.TokensPerMinute = v
	}
	if v := b.Limits.MaxConcurrent; v > 0 && v < merged.MaxConcurrent {
		merged.MaxConcurrent = v
	}
	return merged
}
