// Observability package — shared by the control plane and the worker.
//
// Public surface:
//   logger   — structured JSON logger with field allowlist + secret redaction
//   metrics  — in-process counter/histogram registry with Prometheus rendering
//   trace    — trace context propagation (trace_id, span_id, parent)
//   redaction — allowlist/denylist rules used by the logger (exported for tests)

export {
  Logger,
  getRootLogger,
  hashTenantId,
  __resetLoggerForTests,
  type LogLevel,
  type LoggerContext,
  type LoggerOptions,
} from './logger'

export {
  MetricsRegistry,
  Counter,
  Histogram,
  getRegistry,
  metrics,
  __resetMetricsForTests,
  type MetricType,
} from './metrics'

export {
  generateTraceId,
  generateSpanId,
  extractTraceContext,
  injectTraceContext,
  SpanRecorder,
  getSpanRecorder,
  withSpan,
  __resetSpanRecorderForTests,
  type TraceContext,
  type Span,
} from './trace'

export {
  LOG_FIELD_ALLOWLIST,
  isDeniedField,
  isAllowedField,
  sanitizeFields,
  redactInlineSecrets,
  type LogField,
} from './redaction'
