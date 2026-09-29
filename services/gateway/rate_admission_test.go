package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRateAdmissionRequiresExplicitLocalProfile(t *testing.T) {
	for _, tc := range []struct {
		name    string
		env     *Env
		allowed bool
	}{
		{"missing", nil, false}, {"empty", &Env{}, false},
		{"unrecognized", &Env{Environment: "staging"}, false},
		{"production", &Env{Environment: "production"}, false},
		{"development", &Env{Environment: "development"}, true},
		{"test", &Env{Environment: "test"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			limiter, err := NewLimiter("", nil)
			if err != nil {
				t.Fatal(err)
			}
			p := &Proxy{env: tc.env}
			decision, err := limiter.Allow(context.Background(), "profile", 10, time.Minute, 1, p.allowLocalAdmission())
			if tc.allowed {
				if err != nil || !decision.Allowed || !decision.Degraded {
					t.Fatalf("explicit fallback: %+v %v", decision, err)
				}
			} else if !errors.Is(err, ErrRateLimitUnavailable) || decision.Allowed || len(limiter.local.buckets) != 0 {
				t.Fatalf("unspecified/production profile used local capacity: %+v %v", decision, err)
			}
		})
	}
}

func TestRateAdmissionCancelledLocalRequestDoesNotConsumeCapacity(t *testing.T) {
	limiter, _ := NewLimiter("", nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	decision, err := limiter.Allow(ctx, "cancelled", 10, time.Minute, 1, true)
	if !errors.Is(err, context.Canceled) || decision.Allowed || len(limiter.local.buckets) != 0 {
		t.Fatalf("cancelled request consumed capacity: %+v %v", decision, err)
	}
	decision, err = limiter.Allow(context.Background(), "cancelled", 10, time.Minute, 1, true)
	if err != nil || !decision.Allowed {
		t.Fatal("cancellation exhausted the next request's capacity")
	}
}

func TestLocalRateBucketImmediatelyAppliesTighterCapacity(t *testing.T) {
	buckets := newLocalBuckets()
	// No clock tick is needed to enforce a new, tighter signed policy. A
	// future refill timestamp also cannot preserve the previous large balance.
	buckets.buckets["policy"] = &localBucket{tokens: 100, lastRefill: time.Now().Add(time.Second)}
	if allowed, _ := buckets.allow("policy", 1, time.Hour, 1); !allowed {
		t.Fatal("tightened capacity should fit one request")
	}
	if allowed, retry := buckets.allow("policy", 1, time.Hour, 1); allowed || retry <= 0 {
		t.Fatal("tightened policy retained excess tokens")
	}
	if allowed, retry := buckets.allow("oversized", 1, time.Minute, 2); allowed || retry != 0 {
		t.Fatal("an oversized local request promised recovery by waiting")
	}
	if _, exists := buckets.buckets["oversized"]; exists {
		t.Fatal("impossible request allocated a local bucket")
	}
}
