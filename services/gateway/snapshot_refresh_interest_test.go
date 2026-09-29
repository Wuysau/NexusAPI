package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Use signed snapshots over real HTTP so interest is derived from an accepted
// platform generation, never from an unverified candidate or a fixture map.
type refreshInterestFixture struct {
	h     *testHarness
	cache *SnapshotCache
	clock *testClock
	mu    sync.Mutex
	calls map[string]int
	fails map[string]bool
}

func newRefreshInterestFixture(t *testing.T, opts harnessOptions) *refreshInterestFixture {
	t.Helper()
	clock := &testClock{now: time.Now().UTC().Truncate(time.Second)}
	opts.Clock = clock.Now
	if opts.ExpiresIn == 0 {
		opts.ExpiresIn = time.Hour
	}
	h := newHarness(t, opts)
	f := &refreshInterestFixture{h: h, clock: clock, calls: make(map[string]int), fails: make(map[string]bool)}
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tenant := r.URL.Query().Get("tenant_id")
		f.mu.Lock()
		f.calls[tenant]++
		fail := f.fails[tenant]
		f.mu.Unlock()
		if fail {
			http.Error(w, "snapshot unavailable", http.StatusServiceUnavailable)
			return
		}
		raw, err := h.source.Fetch(r.Context(), tenant)
		if err != nil {
			http.Error(w, "snapshot unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	}))
	t.Cleanup(cp.Close)
	f.cache = NewSnapshotCache(&HTTPSnapshotSource{BaseURL: cp.URL, Token: "interest-fixture-token", Client: cp.Client()}, h.keyring,
		SnapshotConfig{RefreshInterval: time.Minute, MaxAge: time.Hour, FetchTimeout: time.Second}, discardLogger())
	f.cache.SetClock(clock.Now)
	h.snapshots = f.cache
	h.proxy.snapshots = f.cache
	h.proxy.now = clock.Now
	h.proxy.authn = NewAuthenticator(f.cache)
	h.proxy.authn.SetClock(clock.Now)
	return f
}

func (f *refreshInterestFixture) bundle(t *testing.T, tenant string) *GatewayBundle {
	t.Helper()
	raw, err := f.h.source.Fetch(context.Background(), tenant)
	if err != nil {
		t.Fatal(err)
	}
	var envelope snapshotEnvelope
	var bundle GatewayBundle
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(envelope.Bundle, &bundle); err != nil {
		t.Fatal(err)
	}
	return &bundle
}

func (f *refreshInterestFixture) publish(t *testing.T, tenant string, bundle *GatewayBundle) {
	t.Helper()
	bundle.SequenceNumber++
	raw := signBundleForTest(t, f.h.keyring, bundle)
	f.h.source.mu.Lock()
	f.h.source.bundles[tenant] = raw
	f.h.source.mu.Unlock()
}

func (f *refreshInterestFixture) force(t *testing.T, tenant string) *SnapshotState {
	t.Helper()
	state, err := f.cache.refreshSnapshot(context.Background(), tenant, f.cache.entryFor(tenant), true)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func (f *refreshInterestFixture) count(tenant string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[tenant]
}

func (f *refreshInterestFixture) fail(tenant string, fail bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fails[tenant] = fail
}

func TestSnapshotRefreshInterestUsesUsableDirectoryKeys(t *testing.T) {
	str := func(v string) *string { return &v }
	for _, tc := range []struct {
		name string
		edit func(*SnapshotKey, time.Time)
		want bool
	}{
		{"enabled", func(*SnapshotKey, time.Time) {}, true},
		{"disabled", func(k *SnapshotKey, _ time.Time) { k.Enabled = false }, false},
		{"revoked", func(k *SnapshotKey, now time.Time) { k.RevokedAt = str(now.Format(time.RFC3339)) }, false},
		{"malformed_revocation_is_still_revoked", func(k *SnapshotKey, _ time.Time) { k.RevokedAt = str("invalid") }, false},
		{"empty_revocation", func(k *SnapshotKey, _ time.Time) { k.RevokedAt = str("") }, true},
		{"expired", func(k *SnapshotKey, now time.Time) { k.ExpiresAt = str(now.Add(-time.Second).Format(time.RFC3339)) }, false},
		{"expiry_boundary", func(k *SnapshotKey, now time.Time) { k.ExpiresAt = str(now.Format(time.RFC3339)) }, false},
		{"future_expiry", func(k *SnapshotKey, now time.Time) { k.ExpiresAt = str(now.Add(time.Minute).Format(time.RFC3339)) }, true},
		{"malformed_expiry", func(k *SnapshotKey, _ time.Time) { k.ExpiresAt = str("invalid") }, false},
		{"empty_expiry", func(k *SnapshotKey, _ time.Time) { k.ExpiresAt = str("") }, true},
		{"missing_tenant", func(k *SnapshotKey, _ time.Time) { k.TenantID = "" }, false},
		{"missing_organization", func(k *SnapshotKey, _ time.Time) { k.OrganizationID = "" }, false},
		{"missing_key_id", func(k *SnapshotKey, _ time.Time) { k.KeyID = "" }, false},
		{"different_tenant", func(k *SnapshotKey, _ time.Time) { k.TenantID = "tenant-other" }, false},
		{"unattributed_key", func(k *SnapshotKey, _ time.Time) { k.ProjectID = ""; k.AttributionStatus = "unattributed" }, true},
		{"usage_scope_only", func(k *SnapshotKey, _ time.Time) { k.Scopes = []string{ScopeUsageRead} }, true},
		{"empty_scopes", func(k *SnapshotKey, _ time.Time) { k.Scopes = nil }, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newRefreshInterestFixture(t, harnessOptions{})
			f.force(t, testTenantID)
			bundle := f.bundle(t, "")
			tc.edit(&bundle.Keys[0], f.clock.Now())
			f.publish(t, "", bundle)
			f.force(t, "")
			before := f.count(testTenantID)
			platformBefore := f.count("")
			f.cache.warmInterestedTenants(context.Background())
			want := 0
			if tc.want {
				want = 1
			}
			if got := f.count(testTenantID) - before; got != want {
				t.Fatalf("tenant refreshes=%d, want %d from accepted key eligibility", got, want)
			}
			if f.count("") != platformBefore {
				t.Fatal("tenant sweep fetched the platform directory")
			}
		})
	}
}

func TestSnapshotRefreshInterestUnionsKeysWithFirstHashWins(t *testing.T) {
	for _, tc := range []struct {
		name      string
		duplicate bool
		firstLive bool
		otherLive bool
		firstAway bool
		want      int
	}{
		{"one_live_key", false, false, true, false, 1},
		{"all_disabled", false, false, false, false, 0},
		{"duplicate_disabled_first", true, false, true, false, 0},
		{"duplicate_live_first", true, true, false, false, 1},
		{"duplicate_other_tenant_first", true, true, true, true, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newRefreshInterestFixture(t, harnessOptions{})
			f.force(t, testTenantID)
			bundle := f.bundle(t, "")
			first, second := bundle.Keys[0], bundle.Keys[0]
			first.Enabled, second.Enabled = tc.firstLive, tc.otherLive
			second.KeyID = "key-other"
			if !tc.duplicate {
				second.HashSHA256 = HashKey(APIKeyPrefix + "interestfixtureother0000000000")
			}
			if tc.firstAway {
				first.TenantID = "tenant-other"
			}
			bundle.Keys = []SnapshotKey{first, second}
			f.publish(t, "", bundle)
			f.force(t, "")
			before := f.count(testTenantID)
			f.cache.warmInterestedTenants(context.Background())
			if got := f.count(testTenantID) - before; got != tc.want {
				t.Fatalf("tenant refreshes=%d, want %d; shadowed hash entries must not create interest", got, tc.want)
			}
		})
	}
}

func TestSnapshotRefreshInterestDoesNotCreateTenantEntries(t *testing.T) {
	f := newRefreshInterestFixture(t, harnessOptions{})
	const added = "tenant-new-interest"
	bundle := f.bundle(t, "")
	newKey := bundle.Keys[0]
	newKey.TenantID, newKey.KeyID = added, "key-new-interest"
	newKey.HashSHA256 = HashKey(APIKeyPrefix + "interestfixturenew0000000000000")
	bundle.Keys = append(bundle.Keys, newKey)
	f.publish(t, "", bundle)
	tenantBundle := f.bundle(t, testTenantID)
	tenantID := added
	tenantBundle.TenantID, tenantBundle.Snapshot.TenantID = &tenantID, &tenantID
	tenantBundle.Keys = []SnapshotKey{newKey}
	f.publish(t, added, tenantBundle)
	f.force(t, "")
	f.force(t, testTenantID)
	f.cache.warmInterestedTenants(context.Background())
	if f.count(added) != 0 || slices.Contains(f.cache.KnownTenants(), added) {
		t.Fatal("background interest eagerly created or fetched an unseen tenant")
	}
	if _, err := f.cache.Get(context.Background(), added); err != nil {
		t.Fatal(err)
	}
	before := f.count(added)
	f.cache.warmInterestedTenants(context.Background())
	if f.count(added) != before+1 || f.count(testTenantID) != 3 {
		t.Fatal("a tenant first accessed in foreground did not join later refresh sweeps")
	}
}

func TestSnapshotRefreshInterestFallsBackWithoutFreshDirectory(t *testing.T) {
	for _, mode := range []string{"missing", "expired", "rejected_candidate"} {
		t.Run(mode, func(t *testing.T) {
			f := newRefreshInterestFixture(t, harnessOptions{})
			previous := f.force(t, testTenantID)
			if mode != "missing" {
				bundle := f.bundle(t, "")
				bundle.Keys = nil
				f.publish(t, "", bundle)
				platform := f.force(t, "")
				if mode == "rejected_candidate" {
					f.h.source.mu.Lock()
					f.h.source.bundles[""] = []byte(`{"bundle":`)
					f.h.source.mu.Unlock()
					if _, err := f.cache.refreshSnapshot(context.Background(), "", f.cache.entryFor(""), true); err == nil {
						t.Fatal("malformed platform candidate was accepted")
					}
					before := f.count(testTenantID)
					f.cache.warmInterestedTenants(context.Background())
					if f.count(testTenantID) != before || f.cache.entryFor("").state.Load() != platform {
						t.Fatal("rejected candidate discarded a still-fresh accepted interest decision")
					}
				}
				f.clock.Advance(2 * time.Hour)
			}
			f.fail(testTenantID, true)
			before := f.count(testTenantID)
			f.cache.warmInterestedTenants(context.Background())
			if f.count(testTenantID) != before+1 {
				t.Fatal("missing or expired directory suppressed conservative tenant refresh")
			}
			if got := f.cache.entryFor(testTenantID).state.Load(); got != previous {
				t.Fatal("failed fallback discarded the previous verified tenant state")
			}
		})
	}
}

func TestSnapshotRefreshInterestRetainsBYOKStateAcrossReauthorization(t *testing.T) {
	var upstreamCalls atomic.Int64
	f := newRefreshInterestFixture(t, harnessOptions{
		CredentialMode: "byok", ExpiresIn: time.Minute, PlatformExpiresIn: time.Hour,
		SnapshotLimits: SnapshotLimits{ByokContinueWhenStale: true},
		UpstreamHandler: func(w http.ResponseWriter, r *http.Request) {
			upstreamCalls.Add(1)
			defaultUpstreamHandler()(w, r)
		},
	})
	previous := f.force(t, testTenantID)
	expiry, fetched := previous.EffectiveExpiry, previous.FetchedAt
	directory := f.bundle(t, "")
	directory.Keys[0].Enabled = false
	f.publish(t, "", directory)
	f.force(t, "")
	f.clock.Advance(2 * time.Minute)
	f.fail(testTenantID, true)
	before := f.count(testTenantID)
	for range 3 {
		f.cache.warmInterestedTenants(context.Background())
	}
	if f.count(testTenantID) != before {
		t.Fatal("retired tenant still caused periodic HTTP requests")
	}
	if got := f.cache.entryFor(testTenantID).state.Load(); got != previous || got.EffectiveExpiry != expiry || got.FetchedAt != fetched || got.Fresh(f.clock.Now()) {
		t.Fatal("skipping a retired tenant deleted or extended its last verified state")
	}
	denied := f.h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(denied)
	if denied.StatusCode != http.StatusUnauthorized || upstreamCalls.Load() != 0 || len(f.h.store.Requests()) != 0 {
		t.Fatal("retained BYOK state bypassed the disabled platform key")
	}

	directory.Keys[0].Enabled = true
	f.publish(t, "", directory)
	f.force(t, "")
	f.cache.warmInterestedTenants(context.Background())
	if f.count(testTenantID) != before+1 || f.cache.entryFor(testTenantID).state.Load() != previous {
		t.Fatal("reauthorized tenant did not retry HTTP while preserving its last-good state")
	}
	staleAllowed := f.h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(staleAllowed)
	if staleAllowed.StatusCode != http.StatusOK || upstreamCalls.Load() != 1 || f.h.managed.reserveCount() != 0 || len(f.h.store.Requests()) != 1 {
		t.Fatalf("reauthorization changed existing explicit BYOK stale policy: status=%d upstream=%d terminal=%d", staleAllowed.StatusCode, upstreamCalls.Load(), len(f.h.store.Requests()))
	}
	if f.cache.entryFor(testTenantID).state.Load() != previous {
		t.Fatal("failed foreground fetch extended stale BYOK authority")
	}

	fresh := f.bundle(t, testTenantID)
	fresh.GeneratedAt = f.clock.Now().Format(time.RFC3339Nano)
	fresh.ExpiresAt = f.clock.Now().Add(time.Hour).Format(time.RFC3339Nano)
	f.publish(t, testTenantID, fresh)
	f.fail(testTenantID, false)
	f.cache.warmInterestedTenants(context.Background())
	if got := f.cache.entryFor(testTenantID).state.Load(); got == previous || !got.Fresh(f.clock.Now()) {
		t.Fatal("reauthorized tenant failed to recover a new verified generation")
	}
	recovered := f.h.doChat(chatBody(chatBodyOptions{}), nil)
	_ = readAll(recovered)
	if recovered.StatusCode != http.StatusOK || upstreamCalls.Load() != 2 || len(f.h.store.Requests()) != 2 || f.h.store.OutboxCount(testTenantID) != 2 {
		t.Fatal("fresh recovery did not execute and attribute exactly one additional request")
	}
}

func TestSnapshotRefreshInterestDoesNotChangeExplicitWarmAll(t *testing.T) {
	f := newRefreshInterestFixture(t, harnessOptions{DisableKey: true})
	f.force(t, "")
	f.force(t, testTenantID)
	f.cache.warmInterestedTenants(context.Background())
	if f.count(testTenantID) != 1 {
		t.Fatal("disabled tenant was selected by the background interest sweep")
	}
	f.cache.WarmAll(context.Background())
	if f.count(testTenantID) != 2 || f.count("") != 2 {
		t.Fatal("explicit WarmAll no longer force-refreshed every known scope")
	}
}
