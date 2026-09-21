// Metrics primitives: counters and histograms.
//
// The system does not depend on a metrics backend at runtime. These primitives
// are in-process and expose a Prometheus-style text snapshot for the /metrics
// endpoint or a scrape. A production deployment should replace the collector
// with a real backend (Prometheus, OpenTelemetry metrics); the interface is
// stable so the swap is a one-place change.
//
// The metric names align with the requirements (request rate, success rate,
// first-byte/total latency, provider errors, fallback, snapshot age, outbox
// age, billing lag, reconciliation variance, KMS failure, dead-letter count,
// duplicate count).

export type MetricType = 'counter' | 'histogram'

interface CounterMetric {
  type: 'counter'
  name: string
  help: string
  value: number
  labels: Map<string, number>
}

interface HistogramBucket {
  le: number
  count: number
}

interface HistogramMetric {
  type: 'histogram'
  name: string
  help: string
  count: number
  sum: number
  buckets: HistogramBucket[]
  labels: Map<string, { count: number; sum: number; buckets: HistogramBucket[] }>
}

type Metric = CounterMetric | HistogramMetric

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]

function makeBuckets(): HistogramBucket[] {
  return DEFAULT_BUCKETS.map((le) => ({ le, count: 0 }))
}

/**
 * In-process metrics registry. Thread-safe within the Node event loop (single
 * threaded). The registry is a singleton so every module sees the same state.
 */
export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>()

  /** Register or retrieve a counter. */
  counter(name: string, help: string): Counter {
    let m = this.metrics.get(name)
    if (!m) {
      m = { type: 'counter', name, help, value: 0, labels: new Map() }
      this.metrics.set(name, m)
    }
    return new Counter(m as CounterMetric)
  }

  /** Register or retrieve a histogram. */
  histogram(name: string, help: string, buckets: number[] = DEFAULT_BUCKETS): Histogram {
    let m = this.metrics.get(name)
    if (!m) {
      m = {
        type: 'histogram',
        name,
        help,
        count: 0,
        sum: 0,
        buckets: buckets.map((le) => ({ le, count: 0 })),
        labels: new Map(),
      }
      this.metrics.set(name, m)
    }
    return new Histogram(m as HistogramMetric)
  }

  /** Render all metrics as Prometheus text exposition format. */
  render(): string {
    const lines: string[] = []
    for (const m of this.metrics.values()) {
      lines.push(`# HELP ${m.name} ${m.help}`)
      lines.push(`# TYPE ${m.name} ${m.type}`)
      if (m.type === 'counter') {
        lines.push(`${m.name} ${m.value}`)
        for (const [label, value] of m.labels) {
          lines.push(`${m.name}{${label}} ${value}`)
        }
      } else {
        lines.push(`${m.name}_count ${m.count}`)
        lines.push(`${m.name}_sum ${m.sum}`)
        for (const b of m.buckets) {
          lines.push(`${m.name}_bucket{le="${b.le}"} ${b.count}`)
        }
        lines.push(`${m.name}_bucket{le="+Inf"} ${m.count}`)
      }
    }
    return lines.join('\n') + (lines.length ? '\n' : '')
  }

  /** Snapshot all metric values as a plain object (for /metrics JSON). */
  snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [name, m] of this.metrics) {
      if (m.type === 'counter') {
        out[name] = {
          type: 'counter',
          value: (m as CounterMetric).value,
          labels: Object.fromEntries((m as CounterMetric).labels),
        }
      } else {
        const hm = m as HistogramMetric
        out[name] = { type: 'histogram', count: hm.count, sum: hm.sum }
      }
    }
    return out
  }

  /** Reset all metrics (test-only). */
  reset(): void {
    this.metrics.clear()
  }
}

export class Counter {
  constructor(private readonly metric: CounterMetric) {}

  inc(value = 1, label?: string): void {
    if (label) {
      this.metric.labels.set(label, (this.metric.labels.get(label) ?? 0) + value)
    } else {
      this.metric.value += value
    }
  }

  get value(): number {
    return this.metric.value
  }
}

export class Histogram {
  constructor(private readonly metric: HistogramMetric) {}

  observe(value: number, label?: string): void {
    if (label) {
      let entry = this.metric.labels.get(label)
      if (!entry) {
        entry = { count: 0, sum: 0, buckets: makeBuckets() }
        this.metric.labels.set(label, entry)
      }
      entry.count += 1
      entry.sum += value
      for (const b of entry.buckets) {
        if (value <= b.le) b.count += 1
      }
    } else {
      this.metric.count += 1
      this.metric.sum += value
      for (const b of this.metric.buckets) {
        if (value <= b.le) b.count += 1
      }
    }
  }

  get count(): number {
    return this.metric.count
  }

  get sum(): number {
    return this.metric.sum
  }
}

// ── Singleton registry + named metric accessors ─────────────────────────

let registry: MetricsRegistry | null = null

export function getRegistry(): MetricsRegistry {
  if (!registry) registry = new MetricsRegistry()
  return registry
}

/** Test-only reset. */
export function __resetMetricsForTests(): void {
  registry = null
}

/**
 * Named metrics. Each accessor returns the metric singleton so every call site
 * increments the same counter/histogram.
 */
export const metrics = {
  requests: () => getRegistry().counter('nexus_requests_total', 'Total gateway requests'),
  requestErrors: () => getRegistry().counter('nexus_request_errors_total', 'Requests that errored'),
  requestDuration: () => getRegistry().histogram('nexus_request_duration_seconds', 'Total request latency'),
  firstByteDuration: () => getRegistry().histogram('nexus_first_byte_duration_seconds', 'Time to first byte'),
  providerErrors: () => getRegistry().counter('nexus_provider_errors_total', 'Upstream provider errors'),
  fallbackUsed: () => getRegistry().counter('nexus_fallback_total', 'Times a fallback channel was used'),
  snapshotAge: () => getRegistry().histogram('nexus_snapshot_age_seconds', 'Age of the active price snapshot'),
  outboxAge: () => getRegistry().histogram('nexus_outbox_age_seconds', 'Age of the oldest pending outbox event'),
  outboxDepth: () => getRegistry().counter('nexus_outbox_depth', 'Current pending outbox depth (gauge via last value)'),
  billingLag: () => getRegistry().histogram('nexus_billing_lag_seconds', 'Time from usage event to ledger posting'),
  reconcileVariance: () =>
    getRegistry().histogram('nexus_reconcile_variance_micros', 'Absolute reconciliation variance in micros'),
  kmsFailures: () => getRegistry().counter('nexus_kms_failures_total', 'KMS decrypt/envelope failures'),
  deadLetters: () => getRegistry().counter('nexus_outbox_dead_letters_total', 'Outbox events dead-lettered'),
  duplicates: () => getRegistry().counter('nexus_outbox_duplicates_total', 'Duplicate outbox deliveries detected'),
  published: () => getRegistry().counter('nexus_outbox_published_total', 'Outbox events published'),
  claimed: () => getRegistry().counter('nexus_outbox_claimed_total', 'Outbox events claimed for processing'),
  retried: () => getRegistry().counter('nexus_outbox_retried_total', 'Outbox events retried'),
}
