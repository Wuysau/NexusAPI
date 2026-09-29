package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestVerifySnapshotRejectsSignedExpiryBoundary(t *testing.T) {
	v := loadBundleVector(t)
	keyring := vectorKeyring(t, v)
	verified, err := VerifySnapshotResponse(v.Envelope, keyring, v.ExpectedTenant, testNow(t, v))
	if err != nil {
		t.Fatal(err)
	}
	for _, delta := range []time.Duration{-time.Nanosecond, 0, time.Nanosecond} {
		t.Run(delta.String(), func(t *testing.T) {
			_, err := VerifySnapshotResponse(v.Envelope, keyring, v.ExpectedTenant, verified.ExpiresAt.Add(delta))
			if delta < 0 {
				if err != nil {
					t.Fatal("still valid signed bundle was rejected")
				}
			} else if err == nil || reasonOf(err) != ReasonSnapshotExpired {
				t.Fatalf("expired signed bundle accepted: %v", err)
			}
		})
	}
}

func TestSnapshotCacheRejectsExpiryDuringFetch(t *testing.T) {
	v := loadBundleVector(t)
	clock := &testClock{now: testNow(t, v)}
	source := catalogSourceFunc(func(context.Context, string) ([]byte, error) {
		clock.Advance(5 * time.Minute)
		return v.Envelope, nil
	})
	cache := newTestCache(t, v, source, time.Hour, clock)
	state, err := cache.Get(context.Background(), v.ExpectedTenant)
	if err == nil || state != nil || cache.entryFor(v.ExpectedTenant).state.Load() != nil {
		t.Fatal("a bundle that expired during retrieval entered the cache")
	}
}

func TestSnapshotCacheChecksExpiryAfterVerification(t *testing.T) {
	for _, maxAge := range []time.Duration{time.Second, time.Hour} {
		t.Run(maxAge.String(), func(t *testing.T) {
			v := loadBundleVector(t)
			start := testNow(t, v)
			fetched, afterFetchReads := false, 0
			source := catalogSourceFunc(func(context.Context, string) ([]byte, error) {
				fetched = true
				return v.Envelope, nil
			})
			cache := newTestCache(t, v, source, maxAge, nil)
			cache.SetClock(func() time.Time {
				if fetched {
					afterFetchReads++
					if afterFetchReads > 1 {
						if maxAge == time.Second {
							return start.Add(2 * time.Second)
						}
						return start.Add(5 * time.Minute)
					}
				}
				return start
			})
			state, err := cache.Get(context.Background(), v.ExpectedTenant)
			if err == nil || state != nil || cache.entryFor(v.ExpectedTenant).state.Load() != nil {
				t.Fatal("a bundle that expired before publication entered the cache")
			}
		})
	}
}

func TestSnapshotCacheRecordsActualReceiptTime(t *testing.T) {
	v := loadBundleVector(t)
	clock := &testClock{now: testNow(t, v)}
	source := catalogSourceFunc(func(context.Context, string) ([]byte, error) {
		clock.Advance(time.Second)
		return v.Envelope, nil
	})
	cache := newTestCache(t, v, source, time.Minute, clock)
	state, err := cache.Get(context.Background(), v.ExpectedTenant)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Verified.ReceivedAt.Equal(clock.Now()) || !state.FetchedAt.Equal(clock.Now()) || !state.EffectiveExpiry.Equal(clock.Now().Add(time.Minute)) {
		t.Fatal("freshness timestamps describe request start instead of successful receipt")
	}
}

func TestSnapshotCacheDoesNotPublishAfterSourceCancellation(t *testing.T) {
	v := loadBundleVector(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	source := catalogSourceFunc(func(context.Context, string) ([]byte, error) {
		cancel()
		return v.Envelope, nil
	})
	cache := newTestCache(t, v, source, time.Hour, nil)
	state, err := cache.Get(ctx, v.ExpectedTenant)
	if !errors.Is(err, context.Canceled) || state != nil || cache.entryFor(v.ExpectedTenant).state.Load() != nil {
		t.Fatalf("cancelled retrieval published new authorization: %v", err)
	}
}

func TestAuthenticatorAlwaysRequiresFreshDirectory(t *testing.T) {
	for _, cacheFailed := range []bool{false, true} {
		name := "expired_after_cache_read"
		if cacheFailed {
			name = "cache_reported_expiry"
		}
		t.Run(name, func(t *testing.T) {
			clock := &testClock{now: time.Now()}
			h := newHarness(t, harnessOptions{Clock: clock.Now, ExpiresIn: time.Minute})
			if _, err := h.snapshots.Get(context.Background(), ""); err != nil {
				t.Fatal(err)
			}
			initial := clock.Now()
			if cacheFailed {
				clock.Advance(2 * time.Minute)
				h.source.setFail(true)
				h.proxy.authn.SetClock(func() time.Time { return initial })
			} else {
				h.proxy.authn.SetClock(func() time.Time { return initial.Add(2 * time.Minute) })
			}
			identity, err := h.proxy.authn.Authenticate(context.Background(), testAPIKey, ScopeChatWrite)
			if err == nil || identity != nil || asAPIError(err).Code != CodeSnapshotExpired {
				t.Fatalf("expired directory authorized a key: identity=%v error=%v", identity != nil, err)
			}
		})
	}
}
