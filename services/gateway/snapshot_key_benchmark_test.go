package main

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

var benchmarkIdentity *Identity
var benchmarkAuthError error

func benchmarkKeyDirectory(size int) (*GatewayBundle, string) {
	bundle := &GatewayBundle{Keys: make([]SnapshotKey, size)}
	var last string
	for i := range bundle.Keys {
		last = fmt.Sprintf("sk-nx-benchmark-key-%064d", i)
		bundle.Keys[i] = SnapshotKey{
			KeyID:    fmt.Sprintf("%08d-0000-4000-8000-000000000000", i),
			TenantID: "11111111-1111-4111-8111-111111111111", OrganizationID: "22222222-2222-4222-8222-222222222222",
			HashSHA256: HashKey(last), Scopes: []string{ScopeChatWrite, ScopeModelsRead}, Enabled: true,
			Fingerprint: "0123456789abcdef", ProjectID: "33333333-3333-4333-8333-333333333333",
			ProjectName: "Engineering", KeyKind: "shared", AttributionStatus: "attributed",
		}
	}
	return bundle, last
}

// Compare full authentication against the same prewarmed directory, including
// hashing, freshness and permission checks. No I/O or signature verification is
// timed here; those run at refresh. Sizes stay within the 8 MiB wire limit for
// these representative key fields. This is not a whole-HTTP throughput test.
func BenchmarkSnapshotAuthentication(b *testing.B) {
	for _, size := range []int{1000, 10000} {
		for _, mode := range []string{"linear", "indexed"} {
			for _, position := range []string{"last", "missing"} {
				b.Run(fmt.Sprintf("keys=%d/%s/%s", size, mode, position), func(b *testing.B) {
					bundle, presented := benchmarkKeyDirectory(size)
					if mode == "indexed" {
						bundle.indexKeys()
					}
					if position == "missing" {
						presented = "sk-nx-benchmark-key-not-in-directory"
					}
					encoded, err := json.Marshal(bundle)
					if err != nil || len(encoded) >= 8<<20 {
						b.Fatalf("benchmark directory exceeds transport limit: %v", err)
					}
					now := time.Now()
					cache := NewSnapshotCache(nil, nil, SnapshotConfig{}, nil)
					cache.SetClock(func() time.Time { return now })
					cache.entryFor("").state.Store(&SnapshotState{
						Verified: &VerifiedBundle{Bundle: bundle}, EffectiveExpiry: now.Add(time.Hour),
					})
					auth := NewAuthenticator(cache)
					auth.SetClock(func() time.Time { return now })
					ctx := context.Background()
					identity, err := auth.Authenticate(ctx, presented, ScopeChatWrite)
					if (identity != nil && err == nil) != (position == "last") {
						b.Fatal("incorrect authentication result")
					}
					b.ReportAllocs()
					b.ResetTimer()
					for i := 0; i < b.N; i++ {
						benchmarkIdentity, benchmarkAuthError = auth.Authenticate(ctx, presented, ScopeChatWrite)
					}
					b.ReportMetric(float64(len(encoded)), "bundle-bytes")
				})
			}
		}
	}
}

func BenchmarkSnapshotKeyIndexBuild(b *testing.B) {
	for _, size := range []int{1000, 10000} {
		b.Run(fmt.Sprintf("keys=%d", size), func(b *testing.B) {
			bundle, _ := benchmarkKeyDirectory(size)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				bundle.indexKeys()
			}
		})
	}
}
