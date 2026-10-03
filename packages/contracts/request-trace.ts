import { API_ERROR_CODES } from './api-errors'

/** A bounded projection of persisted Gateway facts, never a content trace. */
export const REQUEST_TRACE_VERSION = 1 as const
export const MAX_REQUEST_TRACE_ATTEMPTS = 128
export const MAX_TRACE_PROVIDER_REQUEST_ID_CODEPOINTS = 512
export const REQUEST_TRACE_ERROR_CODES = [
  ...API_ERROR_CODES,
  'auth',
  'rate_limit',
  'quota',
  'content_policy',
  'transient',
  'provider_down',
  'timeout',
  'invalid_request',
  'unknown',
] as const
export type RequestTraceErrorCode = (typeof REQUEST_TRACE_ERROR_CODES)[number]

export interface TraceUsage {
  source: 'worker' | 'event' | null
  schemaVersion: 1 | 2 | null
  usageEventId: string | null
  inputTokens: string | null
  outputTokens: string | null
  cachedInputTokens: string | null
  reasoningTokens: string | null
  totalTokens: string | null
  estimated: boolean | null
}
export interface TraceTiming {
  startedAt: string
  completedAt: string | null
  durationMs: number | null
  ttftMs: null
  streamDurationMs: null
}
export interface TracePins {
  policyVersionId: string | null
  catalogVersionId: string | null
  priceVersionId: string | null
}
export interface TraceSettlement {
  usageRecordId: string
  chargeMicros: string | null
  chargeCurrency: string | null
  upstreamCostMicros: string | null
  upstreamCostCurrency: string | null
}
export interface RequestTraceAttempt {
  id: string
  number: number
  status: 'pending' | 'sent' | 'streaming' | 'completed' | 'failed' | 'retried' | 'unknown'
  providerId: string | null
  resolvedModel: string | null
  channelId: string | null
  connectionId: string | null
  executionMode: 'managed' | 'byok' | 'unknown'
  providerRequestId: string | null
  errorCode: RequestTraceErrorCode | null
  timing: TraceTiming
  pins: TracePins
  usage: TraceUsage
  settlement: TraceSettlement | null
}
export interface RequestTrace {
  version: typeof REQUEST_TRACE_VERSION
  coverage: 'recorded_gateway_attempts'
  request: {
    id: string
    traceId: string | null
    organizationId: string
    project: { id: string | null; name: string | null; attributionStatus: 'attributed' | 'unattributed' | 'unknown' }
    apiKeyId: string | null
    requestedModel: string
    status: 'created' | 'reserved' | 'sent' | 'streaming' | 'completed' | 'failed' | 'unknown' | 'reconciled'
    errorCode: RequestTraceErrorCode | null
    timing: TraceTiming
    pins: TracePins
    usage: TraceUsage
    settlement: TraceSettlement | null
    taskId: null
    sessionId: null
  }
  attempts: RequestTraceAttempt[]
  attemptCount: string
  attemptLimit: typeof MAX_REQUEST_TRACE_ATTEMPTS
  truncated: boolean
}

export function isRequestTraceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\x00-\x1f\x7f]/.test(value)
}

/** Unknown stored error text must never become a public diagnostic message. */
export function traceErrorCode(value: unknown): RequestTraceErrorCode | null {
  return typeof value === 'string' && (REQUEST_TRACE_ERROR_CODES as readonly string[]).includes(value)
    ? (value as RequestTraceErrorCode)
    : null
}

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)
const fixed = (value: unknown, keys: string[]): value is RecordValue =>
  record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const text = (value: unknown, max = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
const nullableText = (value: unknown, max = 256) => value === null || text(value, max)
const displayText = (value: unknown, allowEmpty = false) =>
  typeof value === 'string' &&
  (allowEmpty || value.length > 0) &&
  !value.includes('\0') &&
  !/[\uD800-\uDFFF]/u.test(value) &&
  Array.from(value).length <= 256
const nullableDisplayText = (value: unknown, allowEmpty = false) => value === null || displayText(value, allowEmpty)
// Gateway stores provider IDs as bounded opaque metadata. In particular, a
// valid historical ID may contain whitespace or more than 256 UTF-16 units.
const providerRequestId = (value: unknown) =>
  value === null ||
  (typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    Array.from(value).length <= MAX_TRACE_PROVIDER_REQUEST_ID_CODEPOINTS)
const integer = (value: unknown, signed = false): value is string =>
  typeof value === 'string' && value.length <= 100 && (signed ? /^(0|-?[1-9]\d*)$/ : /^(0|[1-9]\d*)$/).test(value)
const date = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value
const oneOf = (value: unknown, values: readonly unknown[]) => values.includes(value)
const errorCode = (value: unknown) => value === null || traceErrorCode(value) === value
function timing(value: unknown) {
  if (!fixed(value, ['startedAt', 'completedAt', 'durationMs', 'ttftMs', 'streamDurationMs'])) return false
  if (!date(value.startedAt) || (value.completedAt !== null && !date(value.completedAt))) return false
  const duration =
    value.completedAt === null ? null : Date.parse(String(value.completedAt)) - Date.parse(value.startedAt)
  return duration !== null && duration < 0
    ? false
    : value.durationMs === duration && value.ttftMs === null && value.streamDurationMs === null
}
function pins(value: unknown) {
  return (
    fixed(value, ['policyVersionId', 'catalogVersionId', 'priceVersionId']) &&
    Object.values(value).every((v) => nullableText(v))
  )
}
function usage(value: unknown) {
  if (
    !fixed(value, [
      'source',
      'schemaVersion',
      'usageEventId',
      'inputTokens',
      'outputTokens',
      'cachedInputTokens',
      'reasoningTokens',
      'totalTokens',
      'estimated',
    ])
  )
    return false
  if (
    !oneOf(value.source, ['worker', 'event', null]) ||
    !oneOf(value.schemaVersion, [1, 2, null]) ||
    !nullableText(value.usageEventId)
  )
    return false
  if (
    !['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens', 'totalTokens'].every(
      (key) => value[key] === null || integer(value[key]),
    )
  )
    return false
  if (value.estimated !== null && typeof value.estimated !== 'boolean') return false
  if (value.source === null) return Object.entries(value).every(([key, v]) => key === 'source' || v === null)
  return (
    value.schemaVersion !== null &&
    value.usageEventId !== null &&
    (value.schemaVersion !== 1 || value.totalTokens === null)
  )
}
function settlement(value: unknown) {
  if (value === null) return true
  if (
    !fixed(value, ['usageRecordId', 'chargeMicros', 'chargeCurrency', 'upstreamCostMicros', 'upstreamCostCurrency']) ||
    !text(value.usageRecordId)
  )
    return false
  return (
    ['chargeMicros', 'upstreamCostMicros'].every((key) => value[key] === null || integer(value[key])) &&
    ['chargeCurrency', 'upstreamCostCurrency'].every(
      (key) => value[key] === null || (typeof value[key] === 'string' && /^[A-Z]{3}$/.test(value[key] as string)),
    )
  )
}

/** Strict whitelist also rejects accidental body, event, metadata or secret fields. */
export function validateRequestTrace(value: unknown): value is RequestTrace {
  if (
    !fixed(value, ['version', 'coverage', 'request', 'attempts', 'attemptCount', 'attemptLimit', 'truncated']) ||
    value.version !== REQUEST_TRACE_VERSION ||
    value.coverage !== 'recorded_gateway_attempts' ||
    value.attemptLimit !== MAX_REQUEST_TRACE_ATTEMPTS
  )
    return false
  if (
    !integer(value.attemptCount) ||
    !Array.isArray(value.attempts) ||
    value.attempts.length > MAX_REQUEST_TRACE_ATTEMPTS
  )
    return false
  const count = BigInt(value.attemptCount)
  if (
    BigInt(value.attempts.length) !==
      (count > BigInt(MAX_REQUEST_TRACE_ATTEMPTS) ? BigInt(MAX_REQUEST_TRACE_ATTEMPTS) : count) ||
    value.truncated !== count > BigInt(MAX_REQUEST_TRACE_ATTEMPTS)
  )
    return false
  const request = value.request
  if (
    !fixed(request, [
      'id',
      'traceId',
      'organizationId',
      'project',
      'apiKeyId',
      'requestedModel',
      'status',
      'errorCode',
      'timing',
      'pins',
      'usage',
      'settlement',
      'taskId',
      'sessionId',
    ])
  )
    return false
  if (
    !isRequestTraceId(request.id) ||
    !nullableText(request.traceId) ||
    !text(request.organizationId) ||
    !nullableText(request.apiKeyId) ||
    !displayText(request.requestedModel)
  )
    return false
  if (
    !oneOf(request.status, [
      'created',
      'reserved',
      'sent',
      'streaming',
      'completed',
      'failed',
      'unknown',
      'reconciled',
    ]) ||
    !errorCode(request.errorCode) ||
    !timing(request.timing) ||
    !pins(request.pins) ||
    !usage(request.usage) ||
    !settlement(request.settlement) ||
    request.taskId !== null ||
    request.sessionId !== null
  )
    return false
  const project = request.project
  if (
    !fixed(project, ['id', 'name', 'attributionStatus']) ||
    !nullableText(project.id) ||
    !nullableDisplayText(project.name, true) ||
    !oneOf(project.attributionStatus, ['attributed', 'unattributed', 'unknown'])
  )
    return false
  const seen = new Set<string>()
  let previous: { number: number; id: string } | null = null
  for (const attempt of value.attempts) {
    if (
      !fixed(attempt, [
        'id',
        'number',
        'status',
        'providerId',
        'resolvedModel',
        'channelId',
        'connectionId',
        'executionMode',
        'providerRequestId',
        'errorCode',
        'timing',
        'pins',
        'usage',
        'settlement',
      ])
    )
      return false
    if (
      !text(attempt.id) ||
      seen.has(attempt.id) ||
      !Number.isSafeInteger(attempt.number) ||
      (attempt.number as number) < 1
    )
      return false
    if (
      previous &&
      ((attempt.number as number) < previous.number ||
        (attempt.number === previous.number && attempt.id <= previous.id))
    )
      return false
    seen.add(attempt.id)
    previous = { number: attempt.number as number, id: attempt.id }
    if (
      !oneOf(attempt.status, ['pending', 'sent', 'streaming', 'completed', 'failed', 'retried', 'unknown']) ||
      !oneOf(attempt.executionMode, ['managed', 'byok', 'unknown']) ||
      !errorCode(attempt.errorCode)
    )
      return false
    if (
      !providerRequestId(attempt.providerRequestId) ||
      !nullableDisplayText(attempt.resolvedModel) ||
      !['providerId', 'channelId', 'connectionId'].every((key) => nullableText(attempt[key])) ||
      !timing(attempt.timing) ||
      !pins(attempt.pins) ||
      !usage(attempt.usage) ||
      !settlement(attempt.settlement)
    )
      return false
  }
  return true
}
