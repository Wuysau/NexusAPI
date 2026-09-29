package main

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Observing Done means the caller reached the refresh wait select. The owner
// remains blocked until every intended joiner is waiting, without timing sleeps.
type sharedSnapshotWaitContext struct {
	context.Context
	entered chan struct{}
	once    sync.Once
}

func (c *sharedSnapshotWaitContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.entered) })
	return c.Context.Done()
}

type sharedSnapshotResult struct {
	state *SnapshotState
	err   error
}

func sharedSnapshotFixture(t *testing.T, fetch func(context.Context, string) ([]byte, error)) (*SnapshotCache, []byte, *testClock) {
	t.Helper()
	v := loadBundleVector(t)
	keyring := vectorKeyring(t, v)
	var envelope snapshotEnvelope
	if err := json.Unmarshal(v.Envelope, &envelope); err != nil {
		t.Fatal(err)
	}
	var bundle GatewayBundle
	if err := json.Unmarshal(envelope.Bundle, &bundle); err != nil {
		t.Fatal(err)
	}
	bundle.TenantID = nil
	bundle.Snapshot.TenantID = nil
	body := signBundleForTest(t, keyring, &bundle)
	clock := &testClock{now: testNow(t, v)}
	cache := NewSnapshotCache(catalogSourceFunc(fetch), keyring,
		SnapshotConfig{MaxAge: 10 * time.Second, FetchTimeout: 5 * time.Second, RefreshInterval: time.Second}, discardLogger())
	cache.SetClock(clock.Now)
	return cache, body, clock
}

func sharedSnapshotAwait(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(2 * time.Second):
		t.Fatal("snapshot fixture did not reach its expected barrier")
	}
}

func sharedSnapshotGet(cache *SnapshotCache, ctx context.Context, tenant string) <-chan sharedSnapshotResult {
	done := make(chan sharedSnapshotResult, 1)
	go func() {
		state, err := cache.Get(ctx, tenant)
		done <- sharedSnapshotResult{state, err}
	}()
	return done
}

func sharedSnapshotReceive(t *testing.T, results <-chan sharedSnapshotResult) sharedSnapshotResult {
	t.Helper()
	select {
	case result := <-results:
		return result
	case <-time.After(2 * time.Second):
		t.Fatal("snapshot caller did not finish")
		return sharedSnapshotResult{}
	}
}

func TestSnapshotGetAndWarmAllShareRefresh(t *testing.T) {
	for _, ownerKind := range []string{"get", "background"} {
		for _, outcome := range []string{"success", "failure"} {
			t.Run(ownerKind+"/"+outcome, func(t *testing.T) {
				started, release := make(chan struct{}), make(chan struct{})
				unblock := sync.OnceFunc(func() { close(release) })
				defer unblock()
				var calls atomic.Int64
				var body []byte
				failure := errors.New("control plane unavailable")
				cache, envelope, clock := sharedSnapshotFixture(t, func(ctx context.Context, _ string) ([]byte, error) {
					if calls.Add(1) == 1 {
						close(started)
						select {
						case <-release:
						case <-ctx.Done():
							return nil, ctx.Err()
						}
					}
					if outcome == "failure" {
						return nil, failure
					}
					return body, nil
				})
				body = envelope
				run := func(kind string, ctx context.Context) <-chan sharedSnapshotResult {
					if kind == "get" {
						return sharedSnapshotGet(cache, ctx, "")
					}
					done := make(chan sharedSnapshotResult, 1)
					go func() { cache.WarmAll(ctx); done <- sharedSnapshotResult{} }()
					return done
				}
				owner := run(ownerKind, context.Background())
				sharedSnapshotAwait(t, started)
				waitKind := "get"
				if ownerKind == "get" {
					waitKind = "background"
				}
				waitCtx := &sharedSnapshotWaitContext{Context: context.Background(), entered: make(chan struct{})}
				waiter := run(waitKind, waitCtx)
				sharedSnapshotAwait(t, waitCtx.entered)
				unblock()
				ownerResult := sharedSnapshotReceive(t, owner)
				waitResult := sharedSnapshotReceive(t, waiter)
				result := ownerResult
				if waitKind == "get" {
					result = waitResult
				}
				if outcome == "failure" {
					if result.state != nil || !errors.Is(result.err, failure) || cache.entryFor("").state.Load() != nil {
						t.Fatal("shared failed refresh changed the missing-state contract")
					}
				} else if result.err != nil || result.state == nil || result.state != cache.entryFor("").state.Load() {
					t.Fatal("Get did not receive the generation published by the shared refresh")
				}
				if calls.Load() != 1 {
					t.Fatalf("Get and WarmAll repeated the same refresh: fetches=%d", calls.Load())
				}
				if outcome == "success" {
					// A later background pass still refreshes a fresh directory so
					// revocations do not wait for its original signed expiry.
					clock.Advance(time.Second)
					cache.WarmAll(context.Background())
					refreshed := cache.entryFor("").state.Load()
					if calls.Load() != 2 || refreshed == result.state || !refreshed.FetchedAt.After(result.state.FetchedAt) {
						t.Fatal("background refresh stopped updating still-fresh generations")
					}
				}
			})
		}
	}
}

func TestSnapshotSharedBackgroundFailurePreservesAcceptedState(t *testing.T) {
	for _, expired := range []bool{false, true} {
		name := "fresh"
		if expired {
			name = "expired"
		}
		t.Run(name, func(t *testing.T) {
			started, release := make(chan struct{}), make(chan struct{})
			unblock := sync.OnceFunc(func() { close(release) })
			defer unblock()
			var calls atomic.Int64
			var body []byte
			failure := errors.New("background fetch failed")
			cache, envelope, clock := sharedSnapshotFixture(t, func(ctx context.Context, _ string) ([]byte, error) {
				call := calls.Add(1)
				if call == 1 {
					return body, nil
				}
				if call == 2 {
					close(started)
					select {
					case <-release:
					case <-ctx.Done():
						return nil, ctx.Err()
					}
				}
				return nil, failure
			})
			body = envelope
			initial, err := cache.Get(context.Background(), "")
			if err != nil {
				t.Fatal(err)
			}
			expiry, fetched := initial.EffectiveExpiry, initial.FetchedAt
			if expired {
				clock.Advance(11 * time.Second)
			} else {
				clock.Advance(time.Second)
			}
			ownerDone := make(chan struct{})
			go func() { cache.WarmAll(context.Background()); close(ownerDone) }()
			sharedSnapshotAwait(t, started)
			waitCtx := &sharedSnapshotWaitContext{Context: context.Background(), entered: make(chan struct{})}
			waiter := sharedSnapshotGet(cache, waitCtx, "")
			var result sharedSnapshotResult
			if expired {
				sharedSnapshotAwait(t, waitCtx.entered)
				unblock()
				result = sharedSnapshotReceive(t, waiter)
			} else {
				// A fresh generation remains available without waiting for an
				// unrelated background refresh to finish or fail.
				result = sharedSnapshotReceive(t, waiter)
				unblock()
			}
			sharedSnapshotAwait(t, ownerDone)
			if result.state != initial || cache.entryFor("").state.Load() != initial || initial.EffectiveExpiry != expiry || initial.FetchedAt != fetched {
				t.Fatal("failed refresh changed the last accepted generation or extended its lifetime")
			}
			if expired {
				if !errors.Is(result.err, failure) || reasonOf(result.err) != ReasonSnapshotExpired {
					t.Fatal("shared failure lost the stale-state error contract")
				}
			} else if result.err != nil {
				t.Fatal("background failure invalidated the still-fresh generation")
			}
			if calls.Load() != 2 {
				t.Fatalf("waiting Get fetched again after background failure: fetches=%d", calls.Load())
			}
		})
	}
}

func TestSnapshotCanceledJoinerLeavesBackgroundRefreshRunning(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	defer unblock()
	var calls atomic.Int64
	var body []byte
	cache, envelope, _ := sharedSnapshotFixture(t, func(ctx context.Context, _ string) ([]byte, error) {
		if calls.Add(1) == 1 {
			close(started)
		}
		select {
		case <-release:
			return body, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	body = envelope
	ownerDone := make(chan struct{})
	go func() { cache.WarmAll(context.Background()); close(ownerDone) }()
	sharedSnapshotAwait(t, started)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	waitCtx := &sharedSnapshotWaitContext{Context: ctx, entered: make(chan struct{})}
	waiter := sharedSnapshotGet(cache, waitCtx, "")
	sharedSnapshotAwait(t, waitCtx.entered)
	cancel()
	result := sharedSnapshotReceive(t, waiter)
	if result.state != nil || !errors.Is(result.err, context.Canceled) {
		t.Fatal("joiner did not return its own cancellation")
	}
	select {
	case <-ownerDone:
		t.Fatal("joiner canceled the background refresh it did not own")
	default:
	}
	unblock()
	sharedSnapshotAwait(t, ownerDone)
	if state, err := cache.Get(context.Background(), ""); err != nil || state == nil || calls.Load() != 1 {
		t.Fatal("background refresh did not publish after an unrelated joiner left")
	}
}

func TestSnapshotCanceledOwnerSharesFailureAndAllowsNewRefresh(t *testing.T) {
	started := make(chan struct{})
	var calls atomic.Int64
	var body []byte
	cache, envelope, _ := sharedSnapshotFixture(t, func(ctx context.Context, _ string) ([]byte, error) {
		if calls.Add(1) == 1 {
			close(started)
			<-ctx.Done()
			return nil, ctx.Err()
		}
		return body, nil
	})
	body = envelope
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	owner := sharedSnapshotGet(cache, ctx, "")
	sharedSnapshotAwait(t, started)
	waitCtx := &sharedSnapshotWaitContext{Context: context.Background(), entered: make(chan struct{})}
	waiter := sharedSnapshotGet(cache, waitCtx, "")
	sharedSnapshotAwait(t, waitCtx.entered)
	cancel()
	for _, result := range []sharedSnapshotResult{sharedSnapshotReceive(t, owner), sharedSnapshotReceive(t, waiter)} {
		if result.state != nil || !errors.Is(result.err, context.Canceled) || reasonOf(result.err) != ReasonSnapshotUnavailable {
			t.Error("owner cancellation was not shared as the same failed refresh")
		}
	}
	if calls.Load() != 1 || cache.entryFor("").state.Load() != nil {
		t.Error("joiner retried the canceled refresh or published another generation")
	}
	before := calls.Load()
	if state, err := cache.Get(context.Background(), ""); err != nil || state == nil || calls.Load() != before+1 {
		t.Fatal("a new request could not immediately recover after the owner canceled")
	}
}

func TestSnapshotSharedRefreshDoesNotBlockAnotherTenant(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	defer unblock()
	v := loadBundleVector(t)
	var body []byte
	cache, envelope, _ := sharedSnapshotFixture(t, func(ctx context.Context, tenant string) ([]byte, error) {
		if tenant != "" {
			return v.Envelope, nil
		}
		close(started)
		select {
		case <-release:
			return body, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	body = envelope
	owner := sharedSnapshotGet(cache, context.Background(), "")
	sharedSnapshotAwait(t, started)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	state, err := cache.Get(ctx, v.ExpectedTenant)
	if err != nil || state == nil || tenantIDOf(state.Verified.Bundle.TenantID) != v.ExpectedTenant {
		t.Fatal("one blocked scope prevented another tenant from refreshing")
	}
	select {
	case <-owner:
		t.Fatal("blocked platform refresh unexpectedly finished before release")
	default:
	}
	unblock()
	if result := sharedSnapshotReceive(t, owner); result.err != nil || result.state == nil {
		t.Fatal("independent tenant refresh disrupted the platform refresh")
	}
}
