package main

import (
	"context"
	"errors"
	"strconv"
	"testing"
)

func TestGatewayStartupHonorsConfiguredProcessCapacity(t *testing.T) {
	for _, capacity := range []int{1, 3, 300} {
		t.Run(strconv.Itoa(capacity), func(t *testing.T) {
			limits := LoadLimits(func(key string) string {
				if key == "GATEWAY_MAX_CONCURRENT" {
					return strconv.Itoa(capacity)
				}
				return ""
			})
			limiter, err := newGatewayLimiter("", limits.MaxConcurrent, nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = limiter.Close() })
			leases := make([]*ConcurrencyLease, 0, capacity)
			t.Cleanup(func() {
				for _, lease := range leases {
					lease.Release()
				}
			})
			request := func(tenant string) ConcurrencyRequest {
				return ConcurrencyRequest{TenantID: tenant, TenantLimit: capacity + 1, AllowLocal: true}
			}
			for i := 0; i < capacity; i++ {
				lease, err := limiter.AcquireContext(context.Background(), request(strconv.Itoa(i)))
				if err != nil {
					t.Fatalf("configured capacity %d denied slot %d: %v", capacity, i+1, err)
				}
				leases = append(leases, lease)
			}
			extra, err := limiter.AcquireContext(context.Background(), request("overflow"))
			if extra != nil {
				extra.Release()
			}
			if !errors.Is(err, ErrConcurrencyLimit) {
				t.Fatalf("configured process capacity %d exceeded across tenants: %v", capacity, err)
			}
			leases[0].Release()
			replacement, err := limiter.AcquireContext(context.Background(), request("replacement"))
			if err != nil {
				t.Fatalf("released capacity was not reusable: %v", err)
			}
			leases = append(leases, replacement)
		})
	}
}

func TestGatewayStartupPreservesSharedAdmissionRequirement(t *testing.T) {
	limiter, err := newGatewayLimiter("", 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = limiter.Close() }()
	lease, err := limiter.AcquireContext(context.Background(), ConcurrencyRequest{TenantID: "tenant", TenantLimit: 1})
	if lease != nil {
		lease.Release()
	}
	if !errors.Is(err, ErrConcurrencyUnavailable) {
		t.Fatalf("startup enabled local admission without permission: %v", err)
	}
}
