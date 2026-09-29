package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Keep the real signed harness bundles, but fetch them through an actual HTTP
// Control Plane boundary. A successful HTTP status does not prove freshness.
func snapshotHTTPFixture(t *testing.T, h *testHarness) *SnapshotCache {
	t.Helper()
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := h.source.Fetch(r.Context(), r.URL.Query().Get("tenant_id"))
		if err != nil {
			http.Error(w, "snapshot unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	}))
	t.Cleanup(cp.Close)
	cache := NewSnapshotCache(&HTTPSnapshotSource{BaseURL: cp.URL, Token: "snapshot-fixture-token", Client: cp.Client()}, h.keyring,
		SnapshotConfig{RefreshInterval: time.Minute, MaxAge: time.Hour, FetchTimeout: time.Second}, discardLogger())
	clock := h.snapshots.now
	cache.SetClock(clock)
	h.snapshots = cache
	h.proxy.snapshots = cache
	h.proxy.now = clock
	h.proxy.authn = NewAuthenticator(cache)
	h.proxy.authn.SetClock(clock)
	return cache
}

func TestExpiredSignedHTTPResponseCannotAuthorizeRequests(t *testing.T) {
	for _, scope := range []string{"platform", "tenant"} {
		for _, endpoint := range []string{"/v1/models", "/v1/chat/completions", "/v1/responses"} {
			t.Run(scope+endpoint, func(t *testing.T) {
				var upstreamCalls atomic.Int64
				opts := harnessOptions{ExpiresIn: time.Hour, PlatformExpiresIn: time.Hour, UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					upstreamCalls.Add(1)
					defaultUpstreamHandler()(w, r)
				}}
				if scope == "platform" {
					opts.PlatformExpiresIn = -time.Minute
				} else {
					opts.ExpiresIn = -time.Minute
				}
				h := newHarness(t, opts)
				snapshotHTTPFixture(t, h)
				gateway := httptest.NewServer(NewHTTPRouter(h.proxy, h.snapshots, h.limiter, h.store, RouteOptions{EnableResponses: true}))
				t.Cleanup(gateway.Close)
				// A stale HTTP cache can keep returning the same valid signature.
				// Repeated successful fetches must never turn it into fresh authority.
				for i := range 2 {
					method, payload := http.MethodPost, string(chatBody(chatBodyOptions{}))
					if endpoint == "/v1/models" {
						method, payload = http.MethodGet, ""
					} else if endpoint == "/v1/responses" {
						payload = `{"model":"gpt-4o","input":"hi"}`
					}
					req, err := http.NewRequest(method, gateway.URL+endpoint, strings.NewReader(payload))
					if err != nil {
						t.Fatal(err)
					}
					req.Header.Set("Authorization", "Bearer "+testAPIKey)
					req.Header.Set("Content-Type", "application/json")
					response, err := gateway.Client().Do(req)
					if err != nil {
						t.Fatal(err)
					}
					_ = readAll(response)
					if response.StatusCode != http.StatusServiceUnavailable {
						t.Errorf("expired signed %s response authorized request %d: status=%d", scope, i+1, response.StatusCode)
					}
				}
				if upstreamCalls.Load() != 0 || h.managed.reserveCount() != 0 || len(h.store.Requests()) != 0 || h.store.OutboxCount(testTenantID) != 0 {
					t.Errorf("expired authority caused billable work: upstream=%d reserves=%d terminal=%d outbox=%d", upstreamCalls.Load(), h.managed.reserveCount(), len(h.store.Requests()), h.store.OutboxCount(testTenantID))
				}
			})
		}
	}
}

func TestBackgroundExpiredHTTPResponsePreservesLastVerifiedSnapshot(t *testing.T) {
	for _, stale := range []bool{false, true} {
		t.Run(map[bool]string{false: "fresh_retained", true: "stale_retained"}[stale], func(t *testing.T) {
			clock := &testClock{now: time.Now()}
			h := newHarness(t, harnessOptions{Clock: clock.Now, ExpiresIn: time.Hour})
			cache := snapshotHTTPFixture(t, h)
			previous, err := cache.Get(context.Background(), testTenantID)
			if err != nil {
				t.Fatal(err)
			}
			if stale {
				clock.Advance(2 * time.Hour)
			}
			var envelope snapshotEnvelope
			h.source.mu.Lock()
			raw := append([]byte(nil), h.source.bundles[testTenantID]...)
			h.source.mu.Unlock()
			if err := json.Unmarshal(raw, &envelope); err != nil {
				t.Fatal(err)
			}
			var replacement GatewayBundle
			if err := json.Unmarshal(envelope.Bundle, &replacement); err != nil {
				t.Fatal(err)
			}
			replacement.ExpiresAt = clock.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
			// Distinguish an actual replacement from retaining the last verified
			// state, even when both copies are already stale.
			replacement.SequenceNumber++
			replacement.Channels = nil
			replacement.Models = nil
			body := signBundleForTest(t, h.keyring, &replacement)
			h.source.mu.Lock()
			h.source.bundles[testTenantID] = body
			h.source.mu.Unlock()
			cache.WarmAll(context.Background())
			if retained := cache.entryFor(testTenantID).state.Load(); retained != previous {
				t.Fatal("expired HTTP success replaced the last verified snapshot")
			}
			got, err := cache.Get(context.Background(), testTenantID)
			if got != previous || (err != nil) != stale {
				t.Fatalf("last-known-good freshness contract changed: retained=%v stale=%v err=%v", got == previous, stale, err)
			}
		})
	}
}

func TestExpiredHTTPReplayPreservesExistingStalePolicyAndRecovers(t *testing.T) {
	for _, tc := range []struct {
		name         string
		mode         string
		allowStale   bool
		usageV2      bool
		staleAllowed bool
	}{
		{"managed_default", "managed", false, false, false},
		{"managed_with_byok_permission", "managed", true, false, false},
		{"byok_default", "byok", false, false, false},
		{"byok_explicit_permission", "byok", true, false, true},
		{"v2_byok_with_permission", "byok", true, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			clock := &testClock{now: time.Now().Truncate(time.Second)}
			var upstreamCalls atomic.Int64
			h := newHarness(t, harnessOptions{Clock: clock.Now, ExpiresIn: time.Minute, PlatformExpiresIn: time.Hour,
				CredentialMode: tc.mode, EnableUsageV2: tc.usageV2, SnapshotLimits: SnapshotLimits{ByokContinueWhenStale: tc.allowStale},
				UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
					upstreamCalls.Add(1)
					defaultUpstreamHandler()(w, r)
				}})
			cache := snapshotHTTPFixture(t, h)
			for _, tenant := range []string{"", testTenantID} {
				if _, err := cache.Get(context.Background(), tenant); err != nil {
					t.Fatal(err)
				}
			}
			previous := cache.entryFor(testTenantID).state.Load()
			clock.Advance(2 * time.Minute)
			response := h.doChat(chatBody(chatBodyOptions{}), nil)
			_ = readAll(response)
			wantStatus, wantCalls := http.StatusServiceUnavailable, int64(0)
			if tc.staleAllowed {
				wantStatus, wantCalls = http.StatusOK, 1
			}
			if response.StatusCode != wantStatus || upstreamCalls.Load() != wantCalls || h.managed.reserveCount() != 0 || len(h.store.Requests()) != int(wantCalls) || h.store.OutboxCount(testTenantID) != int(wantCalls) {
				t.Fatalf("expired replay changed stale policy or spent before admission: status=%d upstream=%d reserves=%d terminal=%d outbox=%d", response.StatusCode, upstreamCalls.Load(), h.managed.reserveCount(), len(h.store.Requests()), h.store.OutboxCount(testTenantID))
			}
			if cache.entryFor(testTenantID).state.Load() != previous {
				t.Fatal("HTTP replay replaced the previously verified stale policy")
			}

			// Replace only the HTTP source, leaving the stale gateway cache in
			// place. Its next request must recover through the real fetch path.
			var envelope snapshotEnvelope
			h.source.mu.Lock()
			raw := append([]byte(nil), h.source.bundles[testTenantID]...)
			h.source.mu.Unlock()
			if err := json.Unmarshal(raw, &envelope); err != nil {
				t.Fatal(err)
			}
			var refreshed GatewayBundle
			if err := json.Unmarshal(envelope.Bundle, &refreshed); err != nil {
				t.Fatal(err)
			}
			refreshed.GeneratedAt = clock.Now().UTC().Format(time.RFC3339Nano)
			refreshed.ExpiresAt = clock.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
			refreshed.SequenceNumber++
			body := signBundleForTest(t, h.keyring, &refreshed)
			h.source.mu.Lock()
			h.source.bundles[testTenantID] = body
			h.source.mu.Unlock()
			recovered := h.doChat(chatBody(chatBodyOptions{}), nil)
			_ = readAll(recovered)
			if recovered.StatusCode != http.StatusOK || upstreamCalls.Load() != wantCalls+1 || len(h.store.Requests()) != int(wantCalls+1) || h.store.OutboxCount(testTenantID) != int(wantCalls+1) {
				t.Fatalf("fresh signed response did not restore one execution: status=%d upstream=%d terminal=%d", recovered.StatusCode, upstreamCalls.Load(), len(h.store.Requests()))
			}
			wantReservations := 0
			if tc.mode == "managed" {
				wantReservations = 1
			}
			if h.managed.reserveCount() != wantReservations {
				t.Fatalf("recovery changed spending mode: reserves=%d", h.managed.reserveCount())
			}
			if next := cache.entryFor(testTenantID).state.Load(); next == previous || !next.Fresh(clock.Now()) {
				t.Fatal("recovery did not publish the fresh verified response")
			}
		})
	}
}
