package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Signal only once Get has joined the in-progress refresh and is selecting
// on cancellation. This keeps the concurrency assertion independent of timing.
type fanoutWaitContext struct {
	context.Context
	entered chan struct{}
	resume  <-chan struct{}
	once    sync.Once
}

func (c *fanoutWaitContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.entered) })
	if c.resume != nil {
		<-c.resume
	}
	return c.Context.Done()
}

func TestSnapshotSharedSuccessRechecksExpiryForDelayedWaiter(t *testing.T) {
	v := loadBundleVector(t)
	clock := &testClock{now: testNow(t, v)}
	source := &blockedSnapshotSource{started: make(chan struct{}), release: make(chan struct{}), body: v.Envelope}
	cache := newTestCache(t, v, source, time.Second, clock)
	type result struct {
		state *SnapshotState
		err   error
	}
	owner := make(chan result, 1)
	go func() {
		s, err := cache.Get(context.Background(), v.ExpectedTenant)
		owner <- result{s, err}
	}()
	<-source.started
	resume := make(chan struct{})
	var releaseOnce, resumeOnce sync.Once
	unblock := func() {
		releaseOnce.Do(func() { close(source.release) })
		resumeOnce.Do(func() { close(resume) })
	}
	defer unblock()
	ctx := &fanoutWaitContext{Context: context.Background(), entered: make(chan struct{}), resume: resume}
	waiter := make(chan result, 1)
	go func() {
		s, err := cache.Get(ctx, v.ExpectedTenant)
		waiter <- result{s, err}
	}()
	select {
	case <-ctx.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("waiter did not join")
	}
	releaseOnce.Do(func() { close(source.release) })
	accepted := <-owner
	if accepted.err != nil || accepted.state == nil {
		t.Fatalf("owner did not accept fresh generation: %v", accepted.err)
	}
	clock.Advance(2 * time.Second)
	resumeOnce.Do(func() { close(resume) })
	select {
	case got := <-waiter:
		if got.state != accepted.state || reasonOf(got.err) != ReasonSnapshotExpired || source.calls.Load() != 1 {
			t.Fatalf("delayed waiter must reject its now-expired result without another fetch: %v calls=%d", got.err, source.calls.Load())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("waiter did not finish")
	}
}

func TestSnapshotFailedRefreshSharesHTTPResult(t *testing.T) {
	for _, stale := range []bool{false, true} {
		for _, malformed := range []bool{false, true} {
			name := "cold"
			if stale {
				name = "expired"
			}
			if malformed {
				name += "/malformed"
			} else {
				name += "/503"
			}
			t.Run(name, func(t *testing.T) {
				v := loadBundleVector(t)
				started := make(chan struct{})
				release := make(chan struct{})
				var releaseOnce sync.Once
				unblock := func() { releaseOnce.Do(func() { close(release) }) }
				var calls atomic.Int32
				var recovered atomic.Bool
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if calls.Add(1) == 1 {
						close(started)
						select {
						case <-release:
						case <-r.Context().Done():
							return
						}
					}
					if recovered.Load() {
						_, _ = w.Write(v.Envelope)
					} else if malformed {
						_, _ = w.Write([]byte(`{"bundle":`))
					} else {
						w.WriteHeader(http.StatusServiceUnavailable)
					}
				}))
				defer srv.Close()
				defer unblock()
				cache := newTestCache(t, v, &HTTPSnapshotSource{BaseURL: srv.URL, Client: srv.Client()}, time.Hour, nil)
				var old *SnapshotState
				if stale {
					old = &SnapshotState{EffectiveExpiry: cache.now().Add(-time.Minute)}
					cache.entryFor(v.ExpectedTenant).state.Store(old)
				}
				type result struct {
					state *SnapshotState
					err   error
				}
				const concurrent = 16
				results := make(chan result, concurrent)
				get := func(ctx context.Context) {
					s, err := cache.Get(ctx, v.ExpectedTenant)
					results <- result{s, err}
				}
				go get(context.Background())
				select {
				case <-started:
				case <-time.After(3 * time.Second):
					t.Fatal("owner never reached the HTTP source")
				}
				for i := 1; i < concurrent; i++ {
					ctx := &fanoutWaitContext{Context: context.Background(), entered: make(chan struct{})}
					go get(ctx)
					select {
					case <-ctx.entered:
					case <-time.After(3 * time.Second):
						t.Fatal("waiter never joined the active refresh")
					}
				}
				unblock()
				for i := 0; i < concurrent; i++ {
					select {
					case got := <-results:
						var se *SnapshotError
						want := ReasonSnapshotUnavailable
						if stale {
							want = ReasonSnapshotExpired
						}
						if got.state != old || !errors.As(got.err, &se) || se.Reason != want {
							t.Fatalf("failure changed stale-state contract: state=%p old=%p error=%v", got.state, old, got.err)
						}
					case <-time.After(3 * time.Second):
						t.Fatal("waiter did not receive the refresh failure")
					}
				}
				if got := calls.Load(); got != 1 {
					t.Fatalf("one in-flight failure must be shared by all %d callers; got %d HTTP fetches", concurrent, got)
				}
				recovered.Store(true)
				fresh, err := cache.Get(context.Background(), v.ExpectedTenant)
				if err != nil || fresh == nil || fresh == old || !fresh.Fresh(cache.now()) || calls.Load() != 2 {
					t.Fatalf("next request must recover immediately with one new fetch: state=%p err=%v calls=%d", fresh, err, calls.Load())
				}
			})
		}
	}
}
