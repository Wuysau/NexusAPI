package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type bundleVector struct {
	Passphrase     string          `json:"passphrase"`
	ExpectedTenant string          `json:"expectedTenant"`
	Now            string          `json:"now"`
	Canonical      string          `json:"canonical"`
	Signature      string          `json:"signature"`
	SigningKeyID   string          `json:"signingKeyId"`
	Envelope       json.RawMessage `json:"envelope"`
}

func loadBundleVector(t *testing.T) bundleVector {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "bundle-vector.json"))
	if err != nil {
		t.Fatalf("read bundle vector: %v", err)
	}
	var v bundleVector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decode bundle vector: %v", err)
	}
	return v
}

func vectorKeyring(t *testing.T, v bundleVector) *Keyring {
	t.Helper()
	kr, err := NewKeyring(v.Passphrase, "", 0)
	if err != nil {
		t.Fatalf("keyring: %v", err)
	}
	return kr
}

func testNow(t *testing.T, v bundleVector) time.Time {
	t.Helper()
	ts, err := time.Parse(time.RFC3339Nano, v.Now)
	if err != nil {
		t.Fatalf("parse now: %v", err)
	}
	return ts
}

// Accepting a bundle the real TypeScript signer produced is the cross-language
// proof for the whole snapshot path (canonical JSON + scrypt-derived keyring +
// HMAC + schema checks).
func TestVerifySnapshotResponseAcceptsTypeScriptSignedBundle(t *testing.T) {
	v := loadBundleVector(t)
	got, err := VerifySnapshotResponse(v.Envelope, vectorKeyring(t, v), v.ExpectedTenant, testNow(t, v))
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if got.Canonical != v.Canonical {
		t.Fatalf("canonical mismatch\n got %s\nwant %s", got.Canonical, v.Canonical)
	}
	if got.SigningKeyID != v.SigningKeyID {
		t.Fatalf("key id = %s want %s", got.SigningKeyID, v.SigningKeyID)
	}
	if got.Bundle.SequenceNumber != 7 {
		t.Fatalf("sequence = %d", got.Bundle.SequenceNumber)
	}
	if len(got.Bundle.Channels) != 1 || got.Bundle.Channels[0].CredentialMode != "managed" {
		t.Fatalf("channels not decoded: %+v", got.Bundle.Channels)
	}
	if pv := got.Bundle.LookupPrice("openai", "gpt-4o", "global"); pv == nil || pv.Components[0].Amount != "2.50" {
		t.Fatalf("price lookup failed: %+v", pv)
	}
}

func TestVerifySnapshotResponseRejectsTampering(t *testing.T) {
	v := loadBundleVector(t)
	kr := vectorKeyring(t, v)

	t.Run("mutated payload", func(t *testing.T) {
		var env map[string]any
		if err := json.Unmarshal(v.Envelope, &env); err != nil {
			t.Fatal(err)
		}
		bundle := env["bundle"].(map[string]any)
		bundle["limits"].(map[string]any)["requests_per_minute"] = 999999
		mutated, _ := json.Marshal(env)
		if _, err := VerifySnapshotResponse(mutated, kr, v.ExpectedTenant, testNow(t, v)); err == nil {
			t.Fatal("expected signature failure")
		}
	})

	t.Run("unknown key version", func(t *testing.T) {
		var env map[string]any
		_ = json.Unmarshal(v.Envelope, &env)
		env["signing_key_id"] = "hmac-sha256:v99"
		mutated, _ := json.Marshal(env)
		_, err := VerifySnapshotResponse(mutated, kr, v.ExpectedTenant, testNow(t, v))
		if err == nil || !strings.Contains(err.Error(), "unknown_key_version") {
			t.Fatalf("expected unknown_key_version, got %v", err)
		}
	})

	t.Run("wrong tenant", func(t *testing.T) {
		_, err := VerifySnapshotResponse(v.Envelope, kr, "other-tenant", testNow(t, v))
		if err == nil || !strings.Contains(err.Error(), "tenant mismatch") {
			t.Fatalf("expected tenant mismatch, got %v", err)
		}
	})
}

func TestVerifySnapshotResponseRejectsUnsupportedSchema(t *testing.T) {
	v := loadBundleVector(t)
	kr := vectorKeyring(t, v)

	for _, tc := range []struct {
		name   string
		path   []string
		value  any
		substr string
	}{
		{"bundle v2", []string{"bundle", "schema_version"}, json.Number("2"), "unsupported bundle schema_version"},
		{"nested snapshot v2", []string{"bundle", "snapshot", "schema_version"}, json.Number("2"), "nested snapshot schema"},
		{"wrong kind", []string{"bundle", "kind"}, "other", "wrong bundle kind"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var env map[string]any
			if err := json.Unmarshal(v.Envelope, &env); err != nil {
				t.Fatal(err)
			}
			bundle := env["bundle"].(map[string]any)
			node := bundle
			for _, key := range tc.path[1 : len(tc.path)-1] {
				node = node[key].(map[string]any)
			}
			node[tc.path[len(tc.path)-1]] = tc.value
			// Re-sign so only the schema check can reject it: the test is about
			// version negotiation, not signature strength.
			canonical, err := CanonicalJSON(bundle)
			if err != nil {
				t.Fatal(err)
			}
			keyID, sig := kr.SignHMAC(canonical)
			env["signature"] = sig
			env["signing_key_id"] = keyID
			raw, _ := json.Marshal(env)
			_, err = VerifySnapshotResponse(raw, kr, v.ExpectedTenant, testNow(t, v))
			if err == nil || !strings.Contains(err.Error(), tc.substr) {
				t.Fatalf("expected %q, got %v", tc.substr, err)
			}
		})
	}
}

// Forward compatibility: an unknown *extra* field is tolerated (a newer control
// plane may add fields inside the N/N-1 window), unlike an unknown version.
func TestVerifySnapshotResponseToleratesUnknownFields(t *testing.T) {
	v := loadBundleVector(t)
	kr := vectorKeyring(t, v)

	var env map[string]any
	if err := json.Unmarshal(v.Envelope, &env); err != nil {
		t.Fatal(err)
	}
	bundle := env["bundle"].(map[string]any)
	bundle["future_field"] = map[string]any{"added_in": "v2"}
	// float64 here because these are values the test builds in Go; production
	// only ever canonicalizes json.Number from a decoded response body.
	bundle["snapshot"].(map[string]any)["future_snapshot_field"] = []any{1.0, 2.0, 3.0}
	canonical, err := CanonicalJSON(bundle)
	if err != nil {
		t.Fatal(err)
	}
	keyID, sig := kr.SignHMAC(canonical)
	raw, _ := json.Marshal(map[string]any{"bundle": bundle, "signature": sig, "signing_key_id": keyID})

	if _, err := VerifySnapshotResponse(raw, kr, v.ExpectedTenant, testNow(t, v)); err != nil {
		t.Fatalf("unknown extra fields must be tolerated within the compatibility window: %v", err)
	}
}

// ── Cache behaviour: last-known-good and fail-closed expiry ───────────

type fakeSource struct {
	calls atomic.Int64
	body  atomic.Value // []byte
	err   atomic.Value // error
	delay time.Duration
}

func (f *fakeSource) Fetch(ctx context.Context, tenantID string) ([]byte, error) {
	f.calls.Add(1)
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if e, ok := f.err.Load().(error); ok && e != nil {
		return nil, e
	}
	if b, ok := f.body.Load().([]byte); ok {
		return b, nil
	}
	return nil, errors.New("no body")
}

// testClock is a mutable clock so expiry is exercised deterministically rather
// than depending on wall-clock timing.
type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *testClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func newTestCache(t *testing.T, v bundleVector, src SnapshotSource, maxAge time.Duration, clock *testClock) *SnapshotCache {
	t.Helper()
	if clock == nil {
		clock = &testClock{now: testNow(t, v)}
	}
	cfg := SnapshotConfig{RefreshInterval: time.Second, MaxAge: maxAge, FetchTimeout: time.Second}
	cache := NewSnapshotCache(src, vectorKeyring(t, v), cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	cache.SetClock(clock.Now)
	return cache
}

func TestSnapshotCacheUsesLastKnownGoodWhenControlPlaneDown(t *testing.T) {
	v := loadBundleVector(t)
	clock := &testClock{now: testNow(t, v)}
	src := &fakeSource{}
	src.body.Store([]byte(v.Envelope))
	// MaxAge longer than the signed expiry, so the signed expires_at governs.
	cache := newTestCache(t, v, src, time.Hour, clock)

	if _, err := cache.Get(context.Background(), v.ExpectedTenant); err != nil {
		t.Fatalf("first get: %v", err)
	}
	if src.calls.Load() != 1 {
		t.Fatalf("expected one fetch, got %d", src.calls.Load())
	}

	// Control plane goes away.
	src.err.Store(errors.New("connection refused"))

	// Still inside the signed window: last-known-good is served with no error.
	clock.Advance(2 * time.Minute)
	if _, err := cache.Get(context.Background(), v.ExpectedTenant); err != nil {
		t.Fatalf("last-known-good inside the window must still serve: %v", err)
	}

	// Past the signed expiry: fail closed, but keep the stale state available
	// so the caller can apply the tenant's BYOK policy.
	clock.Advance(10 * time.Minute)
	state, err := cache.Get(context.Background(), v.ExpectedTenant)
	var se *SnapshotError
	if !errors.As(err, &se) || se.Reason != ReasonSnapshotExpired {
		t.Fatalf("expected snapshot_expired, got %v", err)
	}
	if state == nil {
		t.Fatal("stale state must be returned alongside the expiry error")
	}
	if state.Fresh(clock.Now()) {
		t.Fatal("state must not report fresh after expiry")
	}
	if cache.Ready() {
		t.Fatal("an expired snapshot must not report ready")
	}
}

// The gateway's own MaxAge ceiling shortens a bundle whose signed expiry is
// implausibly distant.
func TestSnapshotCacheMaxAgeCeilingApplies(t *testing.T) {
	v := loadBundleVector(t)
	clock := &testClock{now: testNow(t, v)}
	src := &fakeSource{}
	src.body.Store([]byte(v.Envelope))
	cache := newTestCache(t, v, src, 90*time.Second, clock)

	if _, err := cache.Get(context.Background(), v.ExpectedTenant); err != nil {
		t.Fatalf("get: %v", err)
	}
	clock.Advance(89 * time.Second)
	src.err.Store(errors.New("down"))
	if _, err := cache.Get(context.Background(), v.ExpectedTenant); err != nil {
		t.Fatalf("inside MaxAge ceiling: %v", err)
	}
	clock.Advance(5 * time.Second)
	if _, err := cache.Get(context.Background(), v.ExpectedTenant); err == nil {
		t.Fatal("expected expiry once the MaxAge ceiling passed")
	}
}

func TestSnapshotCacheFailClosedWithNoSnapshot(t *testing.T) {
	v := loadBundleVector(t)
	src := &fakeSource{}
	src.err.Store(errors.New("control plane unreachable"))
	cache := newTestCache(t, v, src, time.Hour, nil)

	_, err := cache.Get(context.Background(), v.ExpectedTenant)
	var se *SnapshotError
	if !errors.As(err, &se) || se.Reason != ReasonSnapshotUnavailable {
		t.Fatalf("expected snapshot_unavailable, got %v", err)
	}
	if cache.Ready() {
		t.Fatal("cache must not report ready without a verified snapshot")
	}
}

func TestSnapshotCacheSingleFlightUnderConcurrency(t *testing.T) {
	v := loadBundleVector(t)
	src := &fakeSource{delay: 50 * time.Millisecond}
	src.body.Store([]byte(v.Envelope))
	cache := newTestCache(t, v, src, time.Hour, nil)

	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := cache.Get(context.Background(), v.ExpectedTenant); err != nil {
				t.Errorf("get: %v", err)
			}
		}()
	}
	wg.Wait()

	if got := src.calls.Load(); got != 1 {
		t.Fatalf("expected a single upstream fetch under concurrency, got %d", got)
	}
}

// ── HTTP source: auth header + status handling ────────────────────────

func TestHTTPSnapshotSourceSendsInternalToken(t *testing.T) {
	v := loadBundleVector(t)
	var gotAuth string
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotQuery = r.URL.RawQuery
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write(v.Envelope)
	}))
	defer srv.Close()

	src := &HTTPSnapshotSource{BaseURL: srv.URL, Token: "internal-token", Client: srv.Client()}
	body, err := src.Fetch(context.Background(), "tenant-vector")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if len(body) == 0 {
		t.Fatal("empty body")
	}
	if gotAuth != "Bearer internal-token" {
		t.Fatalf("auth header = %q", gotAuth)
	}
	if !strings.Contains(gotQuery, "tenant_id=tenant-vector") {
		t.Fatalf("query = %q", gotQuery)
	}
}

func TestSnapshotCacheKeepsServingFreshSnapshotWithoutRefetch(t *testing.T) {
	v := loadBundleVector(t)
	src := &fakeSource{}
	src.body.Store([]byte(v.Envelope))
	cache := newTestCache(t, v, src, time.Hour, nil)

	for i := 0; i < 5; i++ {
		if _, err := cache.Get(context.Background(), v.ExpectedTenant); err != nil {
			t.Fatalf("get %d: %v", i, err)
		}
	}
	if n := src.calls.Load(); n != 1 {
		t.Fatalf("fresh snapshot must not be refetched, got %d fetches", n)
	}
}
