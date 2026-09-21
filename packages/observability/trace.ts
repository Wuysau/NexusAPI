// OpenTelemetry trace context propagation.
//
// This module provides a lightweight, dependency-free trace context
// abstraction that the control plane and worker use to propagate trace_id
// across boundaries. The Go gateway has its own OTel tracer
// (services/gateway/telemetry.go) with a real TracerProvider; this TS module
// focuses on context extraction/injection and a minimal span recorder for
// tests.
//
// The trace_id and request_id are the only correlation keys that cross the
// control-plane / gateway / worker boundary. They are set as response headers
// so a client can correlate a failure with a log line.

import { randomBytes, createHash } from 'node:crypto'

export interface TraceContext {
  traceId: string
  spanId: string
  /** Optional parent span id when propagated from an upstream service. */
  parentSpanId?: string
}

const TRACE_HEADER = 'x-trace-id'
const PARENT_HEADER = 'x-parent-span-id'

/** Generate a 16-byte hex trace id (W3C-compatible length). */
export function generateTraceId(): string {
  return randomBytes(16).toString('hex')
}

/** Generate an 8-byte hex span id. */
export function generateSpanId(): string {
  return randomBytes(8).toString('hex')
}

/**
 * Extract a trace context from incoming request headers. If no trace id is
 * present, a fresh one is generated (the caller owns the decision).
 */
export function extractTraceContext(headers: Headers): TraceContext {
  const traceId = headers.get(TRACE_HEADER)?.trim() || generateTraceId()
  const parentSpanId = headers.get(PARENT_HEADER)?.trim() || undefined
  return { traceId, spanId: generateSpanId(), parentSpanId }
}

/**
 * Inject a trace context into outgoing headers (for downstream calls to the
 * gateway or internal API).
 */
export function injectTraceContext(ctx: TraceContext, headers: Record<string, string> = {}): Record<string, string> {
  headers[TRACE_HEADER] = ctx.traceId
  headers[PARENT_HEADER] = ctx.spanId
  return headers
}

/**
 * A minimal span recorder for tests and local development. Production should
 * use the OTel SDK; this is here so the worker and control plane can emit
 * structured span summaries without a hard OTel dependency.
 */
export interface Span {
  name: string
  traceId: string
  spanId: string
  parentSpanId?: string
  startTime: number
  endTime?: number
  attributes: Record<string, string | number | boolean>
}

export class SpanRecorder {
  private spans: Span[] = []
  private readonly maxSpans: number

  constructor(maxSpans = 10_000) {
    this.maxSpans = maxSpans
  }

  start(name: string, ctx: TraceContext, attributes: Record<string, string | number | boolean> = {}): Span {
    const span: Span = {
      name,
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      parentSpanId: ctx.parentSpanId,
      startTime: Date.now(),
      attributes,
    }
    return span
  }

  end(span: Span, extraAttrs?: Record<string, string | number | boolean>): void {
    span.endTime = Date.now()
    if (extraAttrs) Object.assign(span.attributes, extraAttrs)
    if (this.spans.length < this.maxSpans) this.spans.push(span)
  }

  /** Drain and return all recorded spans (test-only). */
  drain(): Span[] {
    const out = this.spans
    this.spans = []
    return out
  }

  /** Number of spans currently held. */
  get length(): number {
    return this.spans.length
  }
}

let recorder: SpanRecorder | null = null

export function getSpanRecorder(): SpanRecorder {
  if (!recorder) recorder = new SpanRecorder()
  return recorder
}

/** Test-only reset. */
export function __resetSpanRecorderForTests(): void {
  recorder = null
}

/**
 * Run a function within a span, automatically timing it. The span is recorded
 * with the outcome attribute set to 'ok' or 'error'.
 */
export async function withSpan<T>(
  recorder: SpanRecorder,
  name: string,
  ctx: TraceContext,
  fn: () => Promise<T>,
  extraAttrs?: Record<string, string | number | boolean>,
): Promise<T> {
  const span = recorder.start(name, ctx, extraAttrs)
  try {
    const result = await fn()
    recorder.end(span, { outcome: 'ok' })
    return result
  } catch (error) {
    recorder.end(span, {
      outcome: 'error',
      error_kind: error instanceof Error ? error.name : 'unknown',
    })
    throw error
  }
}
