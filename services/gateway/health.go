package main

import (
	"context"
	"time"
)

const readinessTimeout = 2 * time.Second

type healthPinger interface{ Ping(context.Context) error }

// Dependency probes have a shared deadline and run independently. Return only
// booleans: driver errors can include connection strings or private hostnames.
func probeDependencies(ctx context.Context, database, redis healthPinger) map[string]bool {
	ctx, cancel := context.WithTimeout(ctx, readinessTimeout)
	defer cancel()
	type result struct {
		name string
		ok   bool
	}
	results := make(chan result, 2)
	for name, dependency := range map[string]healthPinger{"database": database, "redis": redis} {
		go func() { results <- result{name, dependency != nil && dependency.Ping(ctx) == nil} }()
	}
	checks := map[string]bool{"database": false, "redis": false}
	for i := 0; i < 2; i++ {
		select {
		case result := <-results:
			checks[result.name] = result.ok
		case <-ctx.Done():
			return checks
		}
	}
	return checks
}

func breakerCounts(breaker *Breaker) map[BreakerState]int {
	counts := map[BreakerState]int{BreakerClosed: 0, BreakerOpen: 0, BreakerHalfOpen: 0}
	for _, state := range breaker.Snapshot() {
		counts[state]++
	}
	return counts
}
