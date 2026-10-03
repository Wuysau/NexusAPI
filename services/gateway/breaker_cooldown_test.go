package main

import (
	"testing"
	"time"
)

func TestBreakerCooldownIsolationExpiryAndCancelledProbe(t *testing.T) {
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	b := NewBreaker(DefaultBreakerConfig())
	b.SetClock(func() time.Time { return now })
	key := BreakerKey("channel-a", "model-a")
	b.Cooldown(key, 5*time.Second)
	if b.Available(key) || b.Allow(key) {
		t.Fatal("active cooldown admitted a request")
	}
	if !b.Allow(BreakerKey("channel-b", "model-a")) || !b.Allow(BreakerKey("channel-a", "model-b")) {
		t.Fatal("cooldown leaked to a different channel/model")
	}
	now = now.Add(5 * time.Second)
	for i := range 2 {
		if !b.Available(key) {
			t.Fatalf("inspection %d should see eligibility without consuming a probe", i)
		}
	}
	if !b.Allow(key) || b.Allow(key) {
		t.Fatal("expired cooldown must allow only one half-open probe")
	}
	b.ReleaseProbe(key)
	if !b.Allow(key) {
		t.Fatal("cancelled probe did not release capacity")
	}
	b.RecordSuccess(key, 20*time.Millisecond)
	if b.State(key) != BreakerClosed || !b.Allow(key) {
		t.Fatal("successful probe did not recover the channel")
	}
}

func TestBreakerLateSuccessAndShortHintCannotEraseCooldown(t *testing.T) {
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	b := NewBreaker(DefaultBreakerConfig())
	b.SetClock(func() time.Time { return now })
	key := BreakerKey("a", "m")
	if !b.Allow(key) {
		t.Fatal("initial request not admitted")
	}
	b.Cooldown(key, 20*time.Second)
	now = now.Add(time.Second)
	b.RecordSuccess(key, time.Second)
	b.Cooldown(key, time.Second)
	now = now.Add(2 * time.Second)
	if b.Available(key) || b.State(key) != BreakerOpen {
		t.Fatal("late success/shorter hint erased active cooldown")
	}
	now = now.Add(17 * time.Second)
	if !b.Allow(key) {
		t.Fatal("original cooldown deadline did not expire")
	}
}

func TestBreakerCooldownDefaultsAndCaps(t *testing.T) {
	for _, tc := range []struct {
		name string
		hint time.Duration
		want time.Duration
	}{{"absent", 0, 30 * time.Second}, {"negative", -time.Second, 30 * time.Second}, {"bounded", 24 * time.Hour, time.Minute}} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Now()
			b := NewBreaker(DefaultBreakerConfig())
			b.SetClock(func() time.Time { return now })
			b.Cooldown("a", tc.hint)
			now = now.Add(tc.want - time.Nanosecond)
			if b.Available("a") {
				t.Fatal("cooldown ended before its deadline")
			}
			now = now.Add(time.Nanosecond)
			if !b.Allow("a") {
				t.Fatal("cooldown did not expire")
			}
		})
	}
}

func TestBreakerFailedCooldownProbeReopensForConfiguredDuration(t *testing.T) {
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	b := NewBreaker(DefaultBreakerConfig())
	b.SetClock(func() time.Time { return now })
	b.Cooldown("a", time.Second)
	now = now.Add(time.Second)
	if !b.Allow("a") {
		t.Fatal("expired cooldown did not admit probe")
	}
	b.RecordFailure("a")
	b.RecordSuccess("a", 10*time.Second) // an older request finishes late
	now = now.Add(29 * time.Second)
	if b.Available("a") {
		t.Fatal("failed probe did not preserve configured recovery cooldown")
	}
	now = now.Add(time.Second)
	if !b.Allow("a") {
		t.Fatal("recovery cooldown did not expire")
	}
}
