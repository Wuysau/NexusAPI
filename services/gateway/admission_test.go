package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestAdmissionRequiresExplicitLocalProfile(t *testing.T) {
	l, _ := NewLimiter("", nil)
	_, err := l.AcquireContext(context.Background(), ConcurrencyRequest{TenantID: "t", TenantLimit: 1})
	if !errors.Is(err, ErrConcurrencyUnavailable) {
		t.Fatalf("unconfigured production limiter admitted: %v", err)
	}
}

func TestAdmissionLocalCancellationReleasesBothScopes(t *testing.T) {
	l, _ := NewLimiter("", nil)
	req := ConcurrencyRequest{TenantID: "t", ChannelID: "c", TenantLimit: 1, ChannelLimit: 1, AllowLocal: true}
	ctx, cancel := context.WithCancel(context.Background())
	lease, err := l.AcquireContext(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	_, err = l.AcquireContext(context.Background(), req)
	if !errors.Is(err, ErrConcurrencyLimit) {
		t.Fatalf("concurrent request admitted: %v", err)
	}
	cancel()
	select {
	case <-lease.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("cancellation lost")
	}
	lease.Release()
	lease.Release()
	req.WaitTimeout = time.Second
	next, err := l.AcquireContext(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	next.Release()
}

func TestAdmissionWaitIsBoundedAndContextAware(t *testing.T) {
	l, _ := NewLimiter("", nil)
	req := ConcurrencyRequest{TenantID: "t", TenantLimit: 1, AllowLocal: true}
	first, err := l.AcquireContext(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()
	req.WaitTimeout = 30 * time.Millisecond
	start := time.Now()
	_, err = l.AcquireContext(context.Background(), req)
	if !errors.Is(err, ErrConcurrencyLimit) || time.Since(start) > time.Second {
		t.Fatalf("wait not bounded: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = l.AcquireContext(ctx, req)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled waiter admitted: %v", err)
	}
}

func TestAdmissionCapChangesDoNotResetActiveCount(t *testing.T) {
	l, _ := NewLimiter("", nil)
	first, ok := l.AcquireConcurrency("t", 2)
	if !ok {
		t.Fatal("first denied")
	}
	defer first()
	second, ok := l.AcquireConcurrency("t", 1)
	if ok {
		second()
		t.Fatal("tightened cap reset active tenant count")
	}
}

func TestAdmissionRedisFailureFailsClosed(t *testing.T) {
	l, _ := NewLimiter("redis://127.0.0.1:1?dial_timeout=20ms&read_timeout=20ms&write_timeout=20ms&max_retries=-1", nil)
	defer func() { _ = l.Close() }()
	_, err := l.AcquireContext(context.Background(), ConcurrencyRequest{TenantID: "t", TenantLimit: 1})
	if !errors.Is(err, ErrConcurrencyUnavailable) {
		t.Fatalf("Redis failure admitted: %v", err)
	}
}
