package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestBackgroundRefreshReplacesStillFreshDirectory(t *testing.T) {
	v := loadBundleVector(t)
	clock := &testClock{now: testNow(t, v)}
	src := &fakeSource{}
	src.body.Store([]byte(v.Envelope))
	cache := newTestCache(t, v, src, time.Hour, clock)
	initial, err := cache.Get(context.Background(), v.ExpectedTenant)
	if err != nil {
		t.Fatal(err)
	}
	clock.Advance(5 * time.Second)
	cache.WarmAll(context.Background())
	refreshed, err := cache.Get(context.Background(), v.ExpectedTenant)
	if err != nil {
		t.Fatal(err)
	}
	if !refreshed.FetchedAt.After(initial.FetchedAt) {
		t.Fatal("background refresh kept the old key directory until TTL expiry")
	}
	src.err.Store(errors.New("control plane unavailable"))
	clock.Advance(5 * time.Second)
	cache.WarmAll(context.Background())
	retained, err := cache.Get(context.Background(), v.ExpectedTenant)
	if err != nil || retained != refreshed {
		t.Fatal("failed background fetch must retain fresh verified state")
	}
}
