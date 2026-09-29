package main

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

type blockedSnapshotSource struct {
	started chan struct{}
	release chan struct{}
	calls   atomic.Int64
	body    []byte
}

func (s *blockedSnapshotSource) Fetch(ctx context.Context, _ string) ([]byte, error) {
	if s.calls.Add(1) == 1 {
		close(s.started)
	}
	select {
	case <-s.release:
		return s.body, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func TestSnapshotRefreshWaitHonorsCancellation(t *testing.T) {
	for _, stale := range []bool{false, true} {
		name := "empty"
		if stale {
			name = "expired"
		}
		t.Run(name, func(t *testing.T) {
			v := loadBundleVector(t)
			src := &blockedSnapshotSource{started: make(chan struct{}), release: make(chan struct{}), body: v.Envelope}
			cache := newTestCache(t, v, src, time.Hour, nil)
			if stale {
				cache.entryFor(v.ExpectedTenant).state.Store(&SnapshotState{EffectiveExpiry: cache.now().Add(-time.Second)})
			}
			ownerDone := make(chan error, 1)
			go func() {
				_, err := cache.Get(context.Background(), v.ExpectedTenant)
				ownerDone <- err
			}()
			<-src.started
			defer func() {
				close(src.release)
				if err := <-ownerDone; err != nil {
					t.Errorf("original refresh was affected by another caller's cancellation: %v", err)
				}
			}()
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			defer cancel()
			started := time.Now()
			state, err := cache.Get(ctx, v.ExpectedTenant)
			if time.Since(started) > 500*time.Millisecond || !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("blocked waiter must respect its own deadline: %v", err)
			}
			var snapshotErr *SnapshotError
			wantReason := ReasonSnapshotUnavailable
			if stale {
				wantReason = ReasonSnapshotExpired
			}
			if !errors.As(err, &snapshotErr) || snapshotErr.Reason != wantReason || (state != nil) != stale {
				t.Fatalf("canceled wait must retain stale-state/error contract: state=%v err=%v", state, err)
			}
			if src.calls.Load() != 1 {
				t.Fatal("canceled waiter started another upstream fetch")
			}
		})
	}
}

func TestSnapshotBackgroundRefreshWaitHonorsCancellation(t *testing.T) {
	v := loadBundleVector(t)
	src := &blockedSnapshotSource{started: make(chan struct{}), release: make(chan struct{}), body: v.Envelope}
	cache := newTestCache(t, v, src, time.Hour, nil)
	ownerDone := make(chan struct{})
	go func() {
		cache.WarmAll(context.Background())
		close(ownerDone)
	}()
	<-src.started
	defer func() { close(src.release); <-ownerDone }()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	started := time.Now()
	cache.WarmAll(ctx)
	if time.Since(started) > 500*time.Millisecond || src.calls.Load() != 1 {
		t.Fatal("background refresh waited past cancellation or issued a canceled fetch")
	}
}
