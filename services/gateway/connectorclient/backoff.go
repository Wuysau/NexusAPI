package connectorclient

import (
	"context"
	"math/rand/v2"
	"time"
)

const (
	retryBase = 500 * time.Millisecond
	retryMax  = 15 * time.Second
)

// retryBackoff belongs to one loop. Equal jitter keeps a nonzero lower bound
// while spreading reconnects from connectors recovering at the same time.
type retryBackoff struct {
	delay  time.Duration
	random func(int64) int64
}

func (b *retryBackoff) next() time.Duration {
	switch {
	case b.delay == 0:
		b.delay = retryBase
	case b.delay >= retryMax/2:
		b.delay = retryMax
	default:
		b.delay *= 2
	}
	random := b.random
	if random == nil {
		random = rand.Int64N
	}
	return b.delay/2 + time.Duration(random(int64(b.delay-b.delay/2)+1))
}

func (b *retryBackoff) reset() { b.delay = 0 }

func pause(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return ctx.Err() == nil
	}
}
