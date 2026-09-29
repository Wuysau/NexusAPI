package main

// Gateway metrics — in-process counters and histograms.
//
// The authenticated /metrics endpoint exposes the four wired HTTP metrics.
// The registry retains additional observation helpers for explicit future
// instrumentation; unobserved provider and Worker signals are not exported.
//
// Metric names (aligned with ADR-0005 and the TS package):
//   nexus_requests_total
//   nexus_request_errors_total
//   nexus_request_duration_seconds
//   nexus_first_byte_duration_seconds
//   nexus_provider_errors_total
//   nexus_fallback_total
//   nexus_snapshot_age_seconds
//   nexus_outbox_age_seconds
//   nexus_outbox_dead_letters_total
//   nexus_outbox_duplicates_total
//   nexus_kms_failures_total
//
// F7: outbox age, duplicate, and dead-letter metrics are required by
// ADR-0005 ("must monitor outbox age, duplicate rate, dead-letters").

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

// Metrics is the gateway's in-process metrics registry.
type Metrics struct {
	mu       sync.RWMutex
	counters map[string]*int64
	histos   map[string]*Histogram
}

// Histogram is a simple histogram with fixed buckets.
type Histogram struct {
	mu      sync.Mutex
	count   int64
	sum     float64
	buckets []float64
	values  []int64
}

// NewMetrics creates a new registry.
func NewMetrics() *Metrics {
	return &Metrics{
		counters: make(map[string]*int64),
		histos:   make(map[string]*Histogram),
	}
}

// Counter returns (creating if needed) a counter by name.
func (m *Metrics) Counter(name string) *int64 {
	m.mu.RLock()
	c, ok := m.counters[name]
	m.mu.RUnlock()
	if ok {
		return c
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	// Double-check after acquiring write lock.
	if c, ok := m.counters[name]; ok {
		return c
	}
	var v int64
	m.counters[name] = &v
	return &v
}

// Histogram returns (creating if needed) a histogram by name.
func (m *Metrics) Histogram(name string, buckets []float64) *Histogram {
	m.mu.RLock()
	h, ok := m.histos[name]
	m.mu.RUnlock()
	if ok {
		return h
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if h, ok := m.histos[name]; ok {
		return h
	}
	h = &Histogram{
		buckets: append([]float64(nil), buckets...),
		values:  make([]int64, len(buckets)),
	}
	m.histos[name] = h
	return h
}

// Inc increments a counter by 1.
func (m *Metrics) Inc(name string) {
	atomic.AddInt64(m.Counter(name), 1)
}

// Add adds a value to a counter.
func (m *Metrics) Add(name string, delta int64) {
	atomic.AddInt64(m.Counter(name), delta)
}

// Observe records a value in a histogram.
func (m *Metrics) Observe(name string, value float64, buckets []float64) {
	h := m.Histogram(name, buckets)
	h.mu.Lock()
	defer h.mu.Unlock()
	h.count++
	h.sum += value
	for i, le := range h.buckets {
		if value <= le {
			h.values[i]++
		}
	}
}

// Render produces a Prometheus text exposition.
func (m *Metrics) Render() string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var names []string
	for n := range m.counters {
		names = append(names, n)
	}
	for n := range m.histos {
		names = append(names, n)
	}
	sort.Strings(names)

	var sb strings.Builder
	for _, name := range names {
		if c, ok := m.counters[name]; ok {
			fmt.Fprintf(&sb, "# TYPE %s counter\n", name)
			fmt.Fprintf(&sb, "%s %d\n", name, atomic.LoadInt64(c))
			continue
		}
		if h, ok := m.histos[name]; ok {
			fmt.Fprintf(&sb, "# TYPE %s histogram\n", name)
			h.mu.Lock()
			fmt.Fprintf(&sb, "%s_count %d\n", name, h.count)
			fmt.Fprintf(&sb, "%s_sum %g\n", name, h.sum)
			for i, le := range h.buckets {
				fmt.Fprintf(&sb, "%s_bucket{le=\"%g\"} %d\n", name, le, h.values[i])
			}
			fmt.Fprintf(&sb, "%s_bucket{le=\"+Inf\"} %d\n", name, h.count)
			h.mu.Unlock()
		}
	}
	return sb.String()
}

// DefaultBuckets returns standard latency buckets matching the TS package.
func DefaultBuckets() []float64 {
	return []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60}
}

// GatewayMetrics holds the named metric handles for the gateway.
type GatewayMetrics struct {
	registry *Metrics
}

// NewGatewayMetrics creates only the metric set wired to HTTP observations.
func NewGatewayMetrics(registry *Metrics) *GatewayMetrics {
	// HTTP zero counters are meaningful before requests arrive. Do not expose
	// uninstrumented provider, billing or Worker metrics as measured zero.
	registry.Counter("nexus_requests_total")
	registry.Counter("nexus_request_errors_total")
	registry.Histogram("nexus_request_duration_seconds", DefaultBuckets())
	registry.Histogram("nexus_first_byte_duration_seconds", DefaultBuckets())
	return &GatewayMetrics{registry: registry}
}

// IncRequest increments the total request counter.
func (g *GatewayMetrics) IncRequest() {
	g.registry.Inc("nexus_requests_total")
}

// IncError increments the error counter.
func (g *GatewayMetrics) IncError() {
	g.registry.Inc("nexus_request_errors_total")
}

// IncProviderError increments the provider error counter.
func (g *GatewayMetrics) IncProviderError() {
	g.registry.Inc("nexus_provider_errors_total")
}

// IncFallback increments the fallback counter.
func (g *GatewayMetrics) IncFallback() {
	g.registry.Inc("nexus_fallback_total")
}

// IncDeadLetter increments the dead-letter counter (F7).
func (g *GatewayMetrics) IncDeadLetter() {
	g.registry.Inc("nexus_outbox_dead_letters_total")
}

// IncDuplicate increments the duplicate delivery counter (F7).
func (g *GatewayMetrics) IncDuplicate() {
	g.registry.Inc("nexus_outbox_duplicates_total")
}

// IncKmsFailure increments the KMS failure counter.
func (g *GatewayMetrics) IncKmsFailure() {
	g.registry.Inc("nexus_kms_failures_total")
}

// ObserveRequestDuration records the total request latency.
func (g *GatewayMetrics) ObserveRequestDuration(seconds float64) {
	g.registry.Observe("nexus_request_duration_seconds", seconds, DefaultBuckets())
}

// ObserveFirstByteDuration records the time-to-first-byte latency.
func (g *GatewayMetrics) ObserveFirstByteDuration(seconds float64) {
	g.registry.Observe("nexus_first_byte_duration_seconds", seconds, DefaultBuckets())
}

// ObserveSnapshotAge records the snapshot age.
func (g *GatewayMetrics) ObserveSnapshotAge(seconds float64) {
	g.registry.Observe("nexus_snapshot_age_seconds", seconds, DefaultBuckets())
}

// ObserveOutboxAge records the outbox age (F7).
func (g *GatewayMetrics) ObserveOutboxAge(seconds float64) {
	g.registry.Observe("nexus_outbox_age_seconds", seconds, DefaultBuckets())
}
