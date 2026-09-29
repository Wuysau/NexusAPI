package main

// Circuit breaker, isolated per (channel, model).
//
// GATEWAY_SPEC: "熔断器按 provider account + model 隔离". A channel that is
// failing for one model must not be taken out for the models it still serves,
// and one bad tenant's traffic must not open a breaker for everyone.
//
// The breaker also tracks an exponentially weighted latency estimate, which the
// router uses as the soft latency signal.

import (
	"sync"
	"time"
)

type BreakerState string

const (
	BreakerClosed   BreakerState = "closed"
	BreakerOpen     BreakerState = "open"
	BreakerHalfOpen BreakerState = "half_open"
)

type breakerEntry struct {
	state               BreakerState
	consecutiveFailures int
	openedAt            time.Time
	retryAt             time.Time
	// latencyEwmaMs is the smoothed observed latency used for soft scoring.
	latencyEwmaMs float64
	samples       int
	lastFailure   time.Time
	ttftEwmaMs    float64
	ttftSamples   int
	failureEwma   float64
	healthSamples int
}

// BreakerConfig tunes the state machine.
type BreakerConfig struct {
	// FailureThreshold is the number of consecutive failures that opens it.
	FailureThreshold int
	// OpenDuration is how long it stays open before a half-open probe.
	OpenDuration time.Duration
	// HalfOpenProbes is how many concurrent probes are admitted while half-open.
	HalfOpenProbes int
	// LatencyAlpha is the EWMA smoothing factor (0..1).
	LatencyAlpha float64
}

func DefaultBreakerConfig() BreakerConfig {
	return BreakerConfig{FailureThreshold: 5, OpenDuration: 30 * time.Second, HalfOpenProbes: 1, LatencyAlpha: 0.2}
}

// BreakerKey names a breaker. Channel is the provider account; model scopes it.
func BreakerKey(channelID, model string) string { return channelID + "|" + model }

type Breaker struct {
	cfg BreakerConfig
	now func() time.Time

	mu      sync.Mutex
	entries map[string]*breakerEntry
	probes  map[string]int
}

func NewBreaker(cfg BreakerConfig) *Breaker {
	if cfg.FailureThreshold < 1 {
		cfg.FailureThreshold = 1
	}
	if cfg.OpenDuration <= 0 {
		cfg.OpenDuration = 30 * time.Second
	}
	if cfg.HalfOpenProbes < 1 {
		cfg.HalfOpenProbes = 1
	}
	if cfg.LatencyAlpha <= 0 || cfg.LatencyAlpha > 1 {
		cfg.LatencyAlpha = 0.2
	}
	return &Breaker{cfg: cfg, now: time.Now, entries: make(map[string]*breakerEntry), probes: make(map[string]int)}
}

// SetClock overrides the clock. Test-only.
func (b *Breaker) SetClock(now func() time.Time) { b.now = now }

func (b *Breaker) entryLocked(key string) *breakerEntry {
	e, ok := b.entries[key]
	if !ok {
		e = &breakerEntry{state: BreakerClosed}
		b.entries[key] = e
	}
	return e
}

// Allow reports whether a request may use this channel/model right now, and
// moves an open breaker to half-open once the cooldown has elapsed.
func (b *Breaker) Allow(key string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	e := b.entryLocked(key)
	switch e.state {
	case BreakerClosed:
		return true
	case BreakerOpen:
		if !b.now().Before(e.retryAt) {
			e.state = BreakerHalfOpen
			b.probes[key] = 0
			return b.admitProbeLocked(key)
		}
		return false
	case BreakerHalfOpen:
		return b.admitProbeLocked(key)
	default:
		return true
	}
}

// Available inspects eligibility without reserving a half-open probe. The
// caller must still call Allow immediately before dispatch.
func (b *Breaker) Available(key string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	e := b.entryLocked(key)
	if e.state == BreakerOpen {
		return !b.now().Before(e.retryAt)
	}
	if e.state == BreakerHalfOpen {
		return b.probes[key] < b.cfg.HalfOpenProbes
	}
	return true
}

// ReleaseProbe releases an unused/cancelled probe without marking the upstream
// unhealthy. Success/failure paths reset the probe count themselves.
func (b *Breaker) ReleaseProbe(key string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.probes[key] > 0 {
		b.probes[key]--
	}
}

// RecordTTFT records time to the first semantic output separately from total
// request latency, which depends on generated response length.
func (b *Breaker) RecordTTFT(key string, latency time.Duration) {
	if latency < 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	e := b.entryLocked(key)
	e.ttftEwmaMs = ewma(e.ttftEwmaMs, float64(latency)/float64(time.Millisecond), b.cfg.LatencyAlpha, e.ttftSamples)
	e.ttftSamples++
}

func (b *Breaker) TTFTMs(key string) float64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.entryLocked(key).ttftEwmaMs
}

func (b *Breaker) admitProbeLocked(key string) bool {
	if b.probes[key] >= b.cfg.HalfOpenProbes {
		return false
	}
	b.probes[key]++
	return true
}

// RecordSuccess closes the breaker and folds the latency into the EWMA.
func (b *Breaker) RecordSuccess(key string, latency time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	e := b.entryLocked(key)
	// An older in-flight request may finish after another request received a
	// provider cooldown. Its success must not make that cooldown disappear.
	if e.state != BreakerOpen || !b.now().Before(e.retryAt) {
		e.state = BreakerClosed
		e.consecutiveFailures = 0
		b.probes[key] = 0
		e.retryAt = time.Time{}
	}
	e.latencyEwmaMs = ewma(e.latencyEwmaMs, float64(latency.Milliseconds()), b.cfg.LatencyAlpha, e.samples)
	e.samples++
	e.failureEwma = ewma(e.failureEwma, 0, b.cfg.LatencyAlpha, e.healthSamples)
	e.healthSamples++
}

// RecordFailure counts a failure and opens the breaker at the threshold.
func (b *Breaker) RecordFailure(key string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	e := b.entryLocked(key)
	e.consecutiveFailures++
	e.failureEwma = ewma(e.failureEwma, 1, b.cfg.LatencyAlpha, e.healthSamples)
	e.healthSamples++
	e.lastFailure = b.now()
	if e.state == BreakerHalfOpen || e.consecutiveFailures >= b.cfg.FailureThreshold {
		e.state = BreakerOpen
		e.openedAt = b.now()
		until := e.openedAt.Add(b.cfg.OpenDuration)
		if until.After(e.retryAt) {
			e.retryAt = until
		}
		b.probes[key] = 0
	}
}

// Open marks a confirmed resource exhaustion unavailable immediately. The
// usual failure threshold remains reserved for transient health failures.
func (b *Breaker) Open(key string) {
	b.Cooldown(key, 0)
}

// Cooldown excludes the channel/model immediately without blocking a request.
// An absent provider hint uses the existing circuit-open duration. Repeated
// hints can extend a cooldown, but cannot shorten one already in force.
func (b *Breaker) Cooldown(key string, delay time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if delay <= 0 {
		delay = b.cfg.OpenDuration
	} else if delay > time.Minute {
		delay = time.Minute
	}
	e := b.entryLocked(key)
	e.state = BreakerOpen
	e.consecutiveFailures = b.cfg.FailureThreshold
	e.openedAt = b.now()
	until := e.openedAt.Add(delay)
	if e.retryAt.After(until) {
		until = e.retryAt
	}
	e.retryAt = until
	b.probes[key] = 0
	e.failureEwma = ewma(e.failureEwma, 1, b.cfg.LatencyAlpha, e.healthSamples)
	e.healthSamples++
	e.lastFailure = e.openedAt
}

// State reports the current state (observability + tests).
func (b *Breaker) State(key string) BreakerState {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.entryLocked(key).state
}

// LatencyMs returns the smoothed latency, or 0 when there is no sample yet.
func (b *Breaker) LatencyMs(key string) float64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	e, ok := b.entries[key]
	if !ok || e.samples == 0 {
		return 0
	}
	return e.latencyEwmaMs
}

// FailureRate is a smoothed upstream error signal, independent of whether the
// consecutive failure threshold has opened the circuit yet.
func (b *Breaker) FailureRate(key string) float64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.entryLocked(key).failureEwma
}

// Snapshot reports every tracked breaker for /healthz-style introspection.
func (b *Breaker) Snapshot() map[string]BreakerState {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make(map[string]BreakerState, len(b.entries))
	for k, e := range b.entries {
		out[k] = e.state
	}
	return out
}

func ewma(previous, sample, alpha float64, samples int) float64 {
	if samples == 0 {
		return sample
	}
	return alpha*sample + (1-alpha)*previous
}
