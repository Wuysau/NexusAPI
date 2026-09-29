package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const refresherFixtureInterval = 10 * time.Millisecond

func refresherIsolationBundles(t *testing.T) (*Keyring, *testClock, map[string][]byte, map[int64][]byte) {
	t.Helper()
	v := loadBundleVector(t)
	keyring := vectorKeyring(t, v)
	clock := &testClock{now: testNow(t, v)}
	var envelope snapshotEnvelope
	if err := json.Unmarshal(v.Envelope, &envelope); err != nil {
		t.Fatal(err)
	}
	var bundle GatewayBundle
	if err := json.Unmarshal(envelope.Bundle, &bundle); err != nil {
		t.Fatal(err)
	}
	bundle.ExpiresAt = clock.Now().Add(time.Hour).Format(time.RFC3339)
	bundle.Keys = []SnapshotKey{
		{KeyID: "refresher-key-a", TenantID: "tenant-a", OrganizationID: "org-a", HashSHA256: HashKey(testAPIKey), Scopes: []string{ScopeChatWrite}, Enabled: true},
		{KeyID: "refresher-key-b", TenantID: "tenant-b", OrganizationID: "org-b", HashSHA256: HashKey(testAPIKey + "-b"), Scopes: []string{ScopeChatWrite}, Enabled: true},
	}
	bodies := make(map[string][]byte)
	for _, scope := range []string{"", "tenant-a", "tenant-b"} {
		bundle.TenantID, bundle.Snapshot.TenantID = nil, nil
		if scope != "" {
			id := scope
			bundle.TenantID, bundle.Snapshot.TenantID = &id, &id
		}
		bundle.SequenceNumber, bundle.Snapshot.SequenceNumber, bundle.RevocationEpoch = 1, 1, 1
		bodies[scope] = signBundleForTest(t, keyring, &bundle)
	}
	bundle.TenantID, bundle.Snapshot.TenantID = nil, nil
	updates := make(map[int64][]byte)
	for epoch := int64(2); epoch <= 4; epoch++ {
		bundle.SequenceNumber, bundle.Snapshot.SequenceNumber, bundle.RevocationEpoch = epoch, epoch, epoch
		revokedAt := clock.Now().Add(time.Duration(epoch) * time.Second).Format(time.RFC3339)
		bundle.Keys[0].Enabled, bundle.Keys[0].RevokedAt = false, &revokedAt
		updates[epoch] = signBundleForTest(t, keyring, &bundle)
	}
	return keyring, clock, bodies, updates
}

func refresherIsolationReceive[T any](t *testing.T, signal <-chan T, description string) T {
	t.Helper()
	select {
	case value := <-signal:
		return value
	case <-time.After(2 * time.Second):
		t.Fatalf("refresher did not reach %s", description)
		var zero T
		return zero
	}
}

func refresherIsolationMaximum(maximum *atomic.Int32, active int32) {
	for previous := maximum.Load(); active > previous; previous = maximum.Load() {
		if maximum.CompareAndSwap(previous, active) {
			return
		}
	}
}

func TestSnapshotRefresherPlatformRevocationsAdvanceWhileTenantBlocks(t *testing.T) {
	keyring, clock, bodies, updates := refresherIsolationBundles(t)
	var background atomic.Bool
	var platformCalls, tenantCalls, platformActive, tenantActive, platformMax, tenantMax atomic.Int32
	platformStarted, platformRelease := make(chan int64, 8), make(chan struct{}, 1)
	tenantStarted := make(chan string, 8)
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		scope := r.URL.Query().Get("tenant_id")
		body := bodies[scope]
		if background.Load() {
			if scope != "" {
				select {
				case tenantStarted <- scope:
				case <-r.Context().Done():
					return
				}
				<-r.Context().Done()
				return
			}
			generation := int64(platformCalls.Load()) + 1
			select {
			case platformStarted <- generation:
			case <-r.Context().Done():
				return
			}
			select {
			case <-platformRelease:
				body = updates[generation]
			case <-r.Context().Done():
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(cp.Close)
	httpSource := &HTTPSnapshotSource{BaseURL: cp.URL, Token: "refresher-fixture", Client: cp.Client()}
	source := catalogSourceFunc(func(ctx context.Context, scope string) ([]byte, error) {
		if background.Load() {
			if scope == "" {
				platformCalls.Add(1)
				refresherIsolationMaximum(&platformMax, platformActive.Add(1))
				defer platformActive.Add(-1)
			} else {
				tenantCalls.Add(1)
				refresherIsolationMaximum(&tenantMax, tenantActive.Add(1))
				defer tenantActive.Add(-1)
			}
		}
		return httpSource.Fetch(ctx, scope)
	})
	cache := NewSnapshotCache(source, keyring, SnapshotConfig{RefreshInterval: refresherFixtureInterval, MaxAge: 10 * time.Second, FetchTimeout: time.Minute}, discardLogger())
	cache.SetClock(clock.Now)
	for _, scope := range []string{"", "tenant-a", "tenant-b"} {
		if _, err := cache.Get(context.Background(), scope); err != nil {
			t.Fatal(err)
		}
	}
	authn := NewAuthenticator(cache)
	authn.SetClock(clock.Now)
	if _, err := authn.Authenticate(context.Background(), testAPIKey, ScopeChatWrite); err != nil {
		t.Fatalf("initial directory did not authorize fixture key: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan struct{})
	background.Store(true)
	go func() { cache.RunRefresher(ctx); close(finished) }()
	t.Cleanup(func() {
		cancel()
		refresherIsolationReceive(t, finished, "refresher shutdown")
	})
	if generation := refresherIsolationReceive(t, platformStarted, "first platform refresh"); generation != 2 {
		t.Fatalf("unexpected initial platform generation: %d", generation)
	}
	blockedTenant := refresherIsolationReceive(t, tenantStarted, "blocked tenant refresh")
	platformRelease <- struct{}{}
	for want := int64(2); want <= 3; want++ {
		// The next request starts only after the prior signed generation has
		// been verified and published. Its gate keeps that generation stable.
		if generation := refresherIsolationReceive(t, platformStarted, "next platform tick while tenant remains blocked"); generation != want+1 {
			t.Fatalf("platform skipped a refresh generation: %d", generation)
		}
		state, err := cache.Get(context.Background(), "")
		if err != nil || state.Verified.Bundle.RevocationEpoch != want || state.Verified.Bundle.SequenceNumber != want {
			t.Fatalf("blocked tenant delayed a signed platform revocation: state=%+v err=%v", state, err)
		}
		key := state.Verified.Bundle.Keys[0]
		if key.Enabled || key.RevokedAt == nil {
			t.Fatal("platform refresh retained the revoked key")
		}
		_, authErr := authn.Authenticate(context.Background(), testAPIKey, ScopeChatWrite)
		var apiErr *APIError
		if !errors.As(authErr, &apiErr) || apiErr.Code != CodeKeyRevoked {
			t.Fatalf("blocked tenant delayed authentication revocation: %v", authErr)
		}
		if want == 2 {
			platformRelease <- struct{}{}
		}
	}
	// Both scopes are now stale and already refreshing. Foreground readers
	// must join their matching background fetch and keep independent cancel.
	clock.Advance(11 * time.Second)
	for _, scope := range []string{"", blockedTenant} {
		waitCtx, stopWaiter := context.WithCancel(context.Background())
		wait := &sharedSnapshotWaitContext{Context: waitCtx, entered: make(chan struct{})}
		result := sharedSnapshotGet(cache, wait, scope)
		refresherIsolationReceive(t, wait.entered, "foreground singleflight join")
		stopWaiter()
		got := sharedSnapshotReceive(t, result)
		if !errors.Is(got.err, context.Canceled) || got.state == nil {
			t.Fatalf("foreground cancellation changed shared stale-state contract: %v", got.err)
		}
	}
	if tenantCalls.Load() != 1 || platformCalls.Load() != 3 || tenantMax.Load() != 1 || platformMax.Load() != 1 {
		t.Fatalf("refresh concurrency escaped its bounds: tenant calls/max=%d/%d platform calls/max=%d/%d", tenantCalls.Load(), tenantMax.Load(), platformCalls.Load(), platformMax.Load())
	}
	cancel()
	refresherIsolationReceive(t, finished, "all refresh workers to stop")
	if tenantActive.Load() != 0 || platformActive.Load() != 0 {
		t.Fatal("RunRefresher returned with an active fetch")
	}
	beforeTenant, beforePlatform := tenantCalls.Load(), platformCalls.Load()
	cache.RunRefresher(ctx)
	if tenantCalls.Load() != beforeTenant || platformCalls.Load() != beforePlatform {
		t.Fatal("canceled refresher started another fetch")
	}
}

func TestSnapshotRefresherCancellationWaitsForOwnedTenantCleanup(t *testing.T) {
	keyring, clock, bodies, _ := refresherIsolationBundles(t)
	var background atomic.Bool
	var calls, active atomic.Int32
	started, canceled, finishCleanup := make(chan struct{}), make(chan struct{}), make(chan struct{})
	signalStarted := sync.OnceFunc(func() { close(started) })
	signalCanceled := sync.OnceFunc(func() { close(canceled) })
	releaseCleanup := sync.OnceFunc(func() { close(finishCleanup) })
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		scope := r.URL.Query().Get("tenant_id")
		if background.Load() && scope != "" {
			signalStarted()
			<-r.Context().Done()
			return
		}
		_, _ = w.Write(bodies[scope])
	}))
	t.Cleanup(cp.Close)
	httpSource := &HTTPSnapshotSource{BaseURL: cp.URL, Token: "refresher-fixture", Client: cp.Client()}
	source := catalogSourceFunc(func(ctx context.Context, scope string) ([]byte, error) {
		if !background.Load() {
			return httpSource.Fetch(ctx, scope)
		}
		calls.Add(1)
		active.Add(1)
		defer active.Add(-1)
		body, err := httpSource.Fetch(ctx, scope)
		if scope != "" {
			signalCanceled()
			// The source has observed cancellation but still owns cleanup. An
			// HTTP handler ending alone does not prove this worker has exited.
			<-finishCleanup
		}
		return body, err
	})
	cache := NewSnapshotCache(source, keyring, SnapshotConfig{RefreshInterval: refresherFixtureInterval, MaxAge: time.Minute, FetchTimeout: time.Minute}, discardLogger())
	cache.SetClock(clock.Now)
	if _, err := cache.Get(context.Background(), "tenant-a"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan struct{})
	background.Store(true)
	go func() { cache.RunRefresher(ctx); close(finished) }()
	t.Cleanup(func() {
		cancel()
		releaseCleanup()
		refresherIsolationReceive(t, finished, "refresher cleanup")
	})
	refresherIsolationReceive(t, started, "tenant fetch owned by refresher")
	cancel()
	refresherIsolationReceive(t, canceled, "tenant fetch cancellation")
	before := calls.Load()
	// This is an absence assertion while an explicit cleanup gate is closed,
	// not a performance deadline for a successful operation.
	select {
	case <-finished:
		t.Fatal("RunRefresher returned before its tenant worker finished cleanup")
	case <-time.After(4 * refresherFixtureInterval):
	}
	if calls.Load() != before {
		t.Fatal("canceled refresher started a new fetch during cleanup")
	}
	releaseCleanup()
	refresherIsolationReceive(t, finished, "owned tenant worker exit")
	if active.Load() != 0 {
		t.Fatal("refresher shutdown left a fetch worker running")
	}
	cache.RunRefresher(ctx)
	if calls.Load() != before {
		t.Fatal("already canceled context allowed another refresh")
	}
}

func TestSnapshotRefresherCancellationPreservesForegroundOwner(t *testing.T) {
	for _, ownerScope := range []string{"", "tenant-a"} {
		name := "tenant"
		if ownerScope == "" {
			name = "platform"
		}
		t.Run(name, func(t *testing.T) {
			keyring, clock, bodies, _ := refresherIsolationBundles(t)
			var background atomic.Bool
			var ownerCalls atomic.Int32
			ownerStarted, releaseOwner := make(chan struct{}), make(chan struct{})
			ownerFetchContexts := make(chan context.Context, 8)
			otherRefreshes := make(chan struct{}, 16)
			signalStarted := sync.OnceFunc(func() { close(ownerStarted) })
			finishOwner := sync.OnceFunc(func() { close(releaseOwner) })
			cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				scope := r.URL.Query().Get("tenant_id")
				if background.Load() {
					if scope == ownerScope {
						signalStarted()
						select {
						case <-releaseOwner:
						case <-r.Context().Done():
							return
						}
					} else {
						select {
						case otherRefreshes <- struct{}{}:
						case <-r.Context().Done():
							return
						}
					}
				}
				_, _ = w.Write(bodies[scope])
			}))
			t.Cleanup(cp.Close)
			httpSource := &HTTPSnapshotSource{BaseURL: cp.URL, Token: "refresher-fixture", Client: cp.Client()}
			source := catalogSourceFunc(func(ctx context.Context, scope string) ([]byte, error) {
				if background.Load() && scope == ownerScope {
					ownerCalls.Add(1)
					select {
					case ownerFetchContexts <- ctx:
					case <-ctx.Done():
						return nil, ctx.Err()
					}
				}
				return httpSource.Fetch(ctx, scope)
			})
			cache := NewSnapshotCache(source, keyring, SnapshotConfig{RefreshInterval: refresherFixtureInterval, MaxAge: 10 * time.Second, FetchTimeout: time.Minute}, discardLogger())
			cache.SetClock(clock.Now)
			for _, scope := range []string{"", "tenant-a"} {
				if _, err := cache.Get(context.Background(), scope); err != nil {
					t.Fatal(err)
				}
			}
			clock.Advance(11 * time.Second)
			background.Store(true)
			ownerCtx, cancelOwner := context.WithCancel(context.Background())
			ownerResult, ownerDone := make(chan sharedSnapshotResult, 1), make(chan struct{})
			go func() {
				defer close(ownerDone)
				state, err := cache.Get(ownerCtx, ownerScope)
				ownerResult <- sharedSnapshotResult{state, err}
			}()
			t.Cleanup(func() {
				cancelOwner()
				finishOwner()
				refresherIsolationReceive(t, ownerDone, "foreground owner cleanup")
			})
			refresherIsolationReceive(t, ownerStarted, "foreground request owning shared fetch")
			ownerFetchCtx := refresherIsolationReceive(t, ownerFetchContexts, "foreground fetch context")
			refreshCtx, cancelRefresh := context.WithCancel(context.Background())
			refreshDone := make(chan struct{})
			go func() { cache.RunRefresher(refreshCtx); close(refreshDone) }()
			t.Cleanup(func() {
				cancelRefresh()
				refresherIsolationReceive(t, refreshDone, "joined refresher shutdown")
			})
			// The independent scope crosses multiple ticks while the foreground
			// owner stays blocked. Its scope must not start a duplicate fetch.
			for i := 0; i < 2; i++ {
				refresherIsolationReceive(t, otherRefreshes, "independent scope refresh")
			}
			cancelRefresh()
			refresherIsolationReceive(t, refreshDone, "refresher exit without waiting for foreground owner")
			if ownerCalls.Load() != 1 || ownerFetchCtx.Err() != nil {
				t.Fatalf("refresher changed foreground ownership: calls=%d owner error=%v", ownerCalls.Load(), ownerFetchCtx.Err())
			}
			select {
			case <-ownerDone:
				t.Fatal("refresher cancellation ended the foreground fetch")
			default:
			}
			finishOwner()
			got := sharedSnapshotReceive(t, ownerResult)
			if got.err != nil || got.state == nil || !got.state.Fresh(clock.Now()) || got.state.Verified.Bundle.SequenceNumber != 1 {
				t.Fatalf("foreground owner could not publish after refresher stopped: state=%+v err=%v", got.state, got.err)
			}
			if ownerCalls.Load() != 1 {
				t.Fatal("background refresher duplicated the foreground request")
			}
		})
	}
}
