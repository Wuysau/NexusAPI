package connectorclient

import (
	"context"
	"testing"
	"time"
)

func TestRetryBackoffGrowsCapsAndResets(t *testing.T) {
	for _, upper := range []bool{false, true} {
		b := retryBackoff{random: func(n int64) int64 {
			if upper {
				return n - 1
			}
			return 0
		}}
		for _, nominal := range []time.Duration{500 * time.Millisecond, time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 15 * time.Second, 15 * time.Second} {
			want := nominal / 2
			if upper {
				want = nominal
			}
			if got := b.next(); got != want {
				t.Fatalf("jitter upper=%v got=%v want=%v", upper, got, want)
			}
		}
		for range 1000 {
			if got := b.next(); got < retryMax/2 || got > retryMax {
				t.Fatalf("repeated failures overflowed the cap: %v", got)
			}
		}
		b.reset()
		if got := b.next(); got < retryBase/2 || got > retryBase {
			t.Fatalf("healthy response did not reset backoff: %v", got)
		}
	}
}

func TestRetryBackoffRandomJitterStaysWithinBounds(t *testing.T) {
	for range 100 {
		var b retryBackoff
		for range 20 {
			got := b.next()
			if got < b.delay/2 || got > b.delay || got > retryMax {
				t.Fatalf("jitter escaped positive bounded interval: %v nominal=%v", got, b.delay)
			}
		}
	}
}

func TestBackoffWaitIsInterruptedByContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan bool, 1)
	go func() { done <- pause(ctx, retryMax) }()
	cancel()
	select {
	case ok := <-done:
		if ok {
			t.Fatal("canceled wait reported success")
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not interrupt retry wait")
	}
}
