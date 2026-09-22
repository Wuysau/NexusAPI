//go:build redisintegration

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"
)

// These tests deliberately fail (never skip) when their isolated Redis fixture
// is unavailable. Run: go test -tags redisintegration ./...
func admissionRedisFixture(t *testing.T) (*Limiter, *Limiter, string) {
	t.Helper()
	url := os.Getenv("NEXUS_TEST_REDIS_URL")
	if url == "" {
		url = "redis://127.0.0.1:56381"
	}
	a, err := NewLimiter(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewLimiter(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := a.Ping(ctx); err != nil {
		t.Fatalf("isolated Redis fixture required: %v", err)
	}
	t.Cleanup(func() { _ = a.Close(); _ = b.Close() })
	return a, b, fmt.Sprintf("gateway-test-%s-%d", t.Name(), time.Now().UnixNano())
}

func TestRedisAdmissionIsAtomicAcrossInstancesAndBothScopes(t *testing.T) {
	a, b, prefix := admissionRedisFixture(t)
	req := ConcurrencyRequest{TenantID: prefix + "t", ChannelID: prefix + "c", TenantLimit: 1, ChannelLimit: 1}
	first, err := a.AcquireContext(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()
	other := req
	other.TenantID = prefix + "other"
	if _, err = b.AcquireContext(context.Background(), other); !errors.Is(err, ErrConcurrencyLimit) {
		t.Fatalf("shared channel cap bypassed: %v", err)
	}
	other.ChannelID = prefix + "other-channel"
	second, err := b.AcquireContext(context.Background(), other)
	if err != nil {
		t.Fatalf("failed atomic admission leaked tenant slot: %v", err)
	}
	second.Release()
	other = req
	other.ChannelID = prefix + "other-channel"
	if _, err = b.AcquireContext(context.Background(), other); !errors.Is(err, ErrConcurrencyLimit) {
		t.Fatalf("shared tenant cap bypassed: %v", err)
	}
	other.TenantID = prefix + "other"
	third, err := b.AcquireContext(context.Background(), other)
	if err != nil {
		t.Fatalf("failed atomic admission leaked channel slot: %v", err)
	}
	third.Release()
	first.Release()
	first.Release()
	fourth, err := b.AcquireContext(context.Background(), req)
	if err != nil {
		t.Fatalf("release did not restore capacity: %v", err)
	}
	fourth.Release()
}

func TestRedisAdmissionConcurrentInstancesCannotExceedCap(t *testing.T) {
	a, b, prefix := admissionRedisFixture(t)
	req := ConcurrencyRequest{TenantID: prefix, ChannelID: prefix, TenantLimit: 3, ChannelLimit: 3}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var admitted []*ConcurrencyLease
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			l := a
			if i%2 != 0 {
				l = b
			}
			lease, err := l.AcquireContext(context.Background(), req)
			if err != nil {
				if !errors.Is(err, ErrConcurrencyLimit) {
					t.Errorf("acquire: %v", err)
				}
				return
			}
			mu.Lock()
			admitted = append(admitted, lease)
			mu.Unlock()
		}(i)
	}
	wg.Wait()
	for _, lease := range admitted {
		lease.Release()
	}
	if len(admitted) != 3 {
		t.Fatalf("shared cap 3 admitted %d", len(admitted))
	}
}

func TestRedisAdmissionRenewsLongRequestsAndCancelsOnLeaseLoss(t *testing.T) {
	a, b, prefix := admissionRedisFixture(t)
	req := ConcurrencyRequest{TenantID: prefix, TenantLimit: 1, LeaseTTL: 600 * time.Millisecond}
	first, err := a.AcquireContext(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()
	time.Sleep(1400 * time.Millisecond)
	if _, err = b.AcquireContext(context.Background(), req); !errors.Is(err, ErrConcurrencyLimit) {
		t.Fatalf("active lease expired instead of renewing: %v", err)
	}
	keys, _ := concurrencyKeys(req)
	if err := a.redis.Del(context.Background(), keys...).Err(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-first.Context().Done():
	case <-time.After(2 * time.Second):
		t.Fatal("lost lease did not cancel upstream context")
	}
}

func TestRedisAdmissionCrashRecoveryAndNoExpiredRenewal(t *testing.T) {
	a, b, prefix := admissionRedisFixture(t)
	req := ConcurrencyRequest{TenantID: prefix, ChannelID: prefix, TenantLimit: 1, ChannelLimit: 1}
	keys, _ := concurrencyKeys(req)
	// A raw acquisition has no renewal goroutine, modeling an instance which
	// exits immediately after Redis has atomically committed its reservation.
	got, err := acquireLeaseLua.Run(context.Background(), a.redis, keys, "crashed-owner", 150, 1, 1).Int()
	if err != nil || got != 1 {
		t.Fatalf("crash fixture: %d %v", got, err)
	}
	if _, err = b.AcquireContext(context.Background(), req); !errors.Is(err, ErrConcurrencyLimit) {
		t.Fatalf("unexpired crash lease ignored: %v", err)
	}
	time.Sleep(200 * time.Millisecond)
	lease, err := b.AcquireContext(context.Background(), req)
	if err != nil {
		t.Fatalf("expired crash lease was not recovered: %v", err)
	}
	defer lease.Release()
	got, err = renewLeaseLua.Run(context.Background(), a.redis, keys, "crashed-owner", 150).Int()
	if err != nil || got != 0 {
		t.Fatalf("stale owner resurrected lease: %d %v", got, err)
	}
	if err := releaseLeaseLua.Run(context.Background(), a.redis, keys, "crashed-owner").Err(); err != nil {
		t.Fatal(err)
	}
	if _, err = a.AcquireContext(context.Background(), req); !errors.Is(err, ErrConcurrencyLimit) {
		t.Fatalf("stale release removed new owner's slot: %v", err)
	}
}

func TestRedisAdmissionWaiterAcquiresReleasedCapacity(t *testing.T) {
	a, b, prefix := admissionRedisFixture(t)
	req := ConcurrencyRequest{TenantID: prefix, TenantLimit: 1}
	first, err := a.AcquireContext(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()
	req.WaitTimeout = time.Second
	result := make(chan error, 1)
	go func() {
		lease, err := b.AcquireContext(context.Background(), req)
		if lease != nil {
			lease.Release()
		}
		result <- err
	}()
	time.Sleep(40 * time.Millisecond)
	first.Release()
	if err := <-result; err != nil {
		t.Fatalf("waiter did not acquire released capacity: %v", err)
	}
}

func TestRedisShortLeaseDoesNotExpireAnotherOwnersLongLease(t *testing.T) {
	a, b, prefix := admissionRedisFixture(t)
	req := ConcurrencyRequest{TenantID: prefix, TenantLimit: 2, LeaseTTL: 1800 * time.Millisecond}
	long, err := a.AcquireContext(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	defer long.Release()
	shortReq := req
	shortReq.LeaseTTL = 90 * time.Millisecond
	short, err := b.AcquireContext(context.Background(), shortReq)
	if err != nil {
		t.Fatal(err)
	}
	short.Release()
	time.Sleep(250 * time.Millisecond)
	third, err := b.AcquireContext(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	defer third.Release()
	fourth, err := b.AcquireContext(context.Background(), req)
	if fourth != nil {
		fourth.Release()
	}
	if !errors.Is(err, ErrConcurrencyLimit) {
		t.Fatalf("short lease expired another owner's long reservation: %v", err)
	}
}

func TestRedisAdmissionClientCancellationReturnsSharedCapacity(t *testing.T) {
	a, b, prefix := admissionRedisFixture(t)
	req := ConcurrencyRequest{TenantID: prefix, ChannelID: prefix, TenantLimit: 1, ChannelLimit: 1}
	ctx, cancel := context.WithCancel(context.Background())
	first, err := a.AcquireContext(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()
	cancel()
	req.WaitTimeout = time.Second
	next, err := b.AcquireContext(context.Background(), req)
	if err != nil {
		t.Fatalf("client cancellation leaked shared tenant/channel capacity: %v", err)
	}
	next.Release()
}
