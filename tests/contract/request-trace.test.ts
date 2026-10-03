import { describe, expect, it } from 'vitest'
import {
  MAX_REQUEST_TRACE_ATTEMPTS,
  isRequestTraceId,
  traceErrorCode,
  validateRequestTrace,
  type RequestTrace,
} from '../../packages/contracts/request-trace'

function fixture(): RequestTrace {
  const usage = {
    source: null,
    schemaVersion: null,
    usageEventId: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    estimated: null,
  }
  const timing = {
    startedAt: '2026-10-04T00:00:00.000Z',
    completedAt: null,
    durationMs: null,
    ttftMs: null,
    streamDurationMs: null,
  }
  const pins = { policyVersionId: null, catalogVersionId: null, priceVersionId: null }
  return {
    version: 1,
    coverage: 'recorded_gateway_attempts',
    request: {
      id: 'request',
      traceId: null,
      organizationId: 'org',
      project: { id: null, name: null, attributionStatus: 'unknown' },
      apiKeyId: null,
      requestedModel: 'alias',
      status: 'sent',
      errorCode: null,
      timing: { ...timing },
      pins: { ...pins },
      usage: { ...usage },
      settlement: null,
      taskId: null,
      sessionId: null,
    },
    attempts: [
      {
        id: 'attempt',
        number: 1,
        status: 'pending',
        providerId: null,
        resolvedModel: null,
        channelId: null,
        connectionId: null,
        executionMode: 'unknown',
        providerRequestId: null,
        errorCode: null,
        timing: { ...timing },
        pins: { ...pins },
        usage: { ...usage },
        settlement: null,
      },
    ],
    attemptCount: '1',
    attemptLimit: 128,
    truncated: false,
  }
}

describe('recorded request trace contract', () => {
  it('keeps unknown usage, missing settlement and unrecorded relationships explicit', () => {
    const value = fixture()
    expect(validateRequestTrace(value)).toBe(true)
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
    expect(value.request.usage.inputTokens).toBeNull()
    expect(value.request.settlement).toBeNull()
    expect(value.request.taskId).toBeNull()
    expect(value.request.timing.ttftMs).toBeNull()
  })
  it('keeps present zero distinct from unknown and preserves integers beyond JS precision', () => {
    const value = fixture()
    value.attempts[0].usage = {
      source: 'worker',
      schemaVersion: 2,
      usageEventId: 'event',
      inputTokens: '9007199254740993',
      outputTokens: '0',
      cachedInputTokens: null,
      reasoningTokens: null,
      totalTokens: '9007199254740993',
      estimated: false,
    }
    value.attempts[0].settlement = {
      usageRecordId: 'record',
      chargeMicros: '9007199254740993',
      chargeCurrency: 'USD',
      upstreamCostMicros: '0',
      upstreamCostCurrency: 'CNY',
    }
    expect(validateRequestTrace(value)).toBe(true)
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
    value.attempts[0].usage.schemaVersion = 1
    expect(validateRequestTrace(value)).toBe(false)
    value.attempts[0].usage.totalTokens = null
    expect(validateRequestTrace(value)).toBe(true)
  })
  it('declares a bounded incomplete list without silently suggesting completeness', () => {
    const value = fixture()
    const attempt = value.attempts[0]
    value.attempts = Array.from({ length: MAX_REQUEST_TRACE_ATTEMPTS }, (_, index) => ({
      ...attempt,
      id: `attempt-${index}`,
      number: index + 1,
    }))
    value.attemptCount = '129'
    value.truncated = true
    expect(validateRequestTrace(value)).toBe(true)
    for (const invalid of [
      { ...value, truncated: false },
      { ...value, attemptCount: '128' },
      { ...value, attempts: value.attempts.slice(1) },
      { ...value, attemptLimit: 129 },
    ])
      expect(validateRequestTrace(invalid)).toBe(false)
  })
  it('accepts an empty persisted request and recorded end intervals only', () => {
    const value = fixture()
    value.attempts = []
    value.attemptCount = '0'
    value.request.timing = { ...value.request.timing, completedAt: '2026-10-04T00:00:01.250Z', durationMs: 1250 }
    expect(validateRequestTrace(value)).toBe(true)
    value.request.timing.durationMs = 1249
    expect(validateRequestTrace(value)).toBe(false)
  })
  it.each([
    ['version', 2],
    ['coverage', 'all_requests'],
    ['request.id', ''],
    ['request.project.extra', 'body'],
    ['request.prompt', 'canary'],
    ['request.errorCode', 'raw_provider_exception'],
    ['request.status', 'observed'],
    ['request.taskId', 'invented-task'],
    ['request.sessionId', 'invented-session'],
    ['request.traceId', 'x\nbody'],
    ['request.timing.ttftMs', 0],
    ['request.timing.streamDurationMs', 100],
    ['request.timing.completedAt', '2026-02-30T00:00:00.000Z'],
    ['request.timing.completedAt', '2026-10-03T00:00:00.000Z'],
    ['request.pins.credentialRef', 'secret'],
    ['attempts.0.payload', { prompt: 'canary' }],
    ['attempts.0.providerRequestId', 'x'.repeat(513)],
    ['attempts.0.providerId', 'x\u0000y'],
    ['attempts.0.number', 0],
    ['attempts.0.number', 1.5],
    ['attempts.0.usage.inputTokens', '0'],
    ['attempts.0.usage.source', 'legacy_counter'],
    ['attemptCount', 1],
    ['attemptCount', '-1'],
    ['attemptCount', '1e3'],
    ['request.settlement', { chargeMicros: '0' }],
  ])('rejects invalid or unauthorized field %s', (path, replacement) => {
    const value = fixture()
    let parent: Record<string, unknown> = value as unknown as Record<string, unknown>
    const parts = path.split('.')
    for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>
    parent[parts.at(-1)!] = replacement
    expect(validateRequestTrace(value)).toBe(false)
  })
  it('rejects duplicated or unordered attempt identities', () => {
    const value = fixture()
    value.attemptCount = '2'
    value.attempts.push({ ...value.attempts[0], number: 2 })
    expect(validateRequestTrace(value)).toBe(false)
    value.attempts[1].id = 'another'
    value.attempts.reverse()
    expect(validateRequestTrace(value)).toBe(false)
  })
  it.each(['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens', 'totalTokens'] as const)(
    'rejects lossy or negative %s',
    (field) => {
      for (const invalid of [9007199254740993, '-1', '01', '1.5', '1e3', 'NaN']) {
        const value = fixture()
        value.request.usage = { ...value.request.usage, source: 'event', schemaVersion: 2, usageEventId: 'event' }
        ;(value.request.usage as unknown as Record<string, unknown>)[field] = invalid
        expect(validateRequestTrace(value)).toBe(false)
      }
    },
  )
  it('bounds IDs and exposes only known fixed error codes', () => {
    expect(isRequestTraceId('request-123')).toBe(true)
    for (const value of ['', 'x'.repeat(129), 'x y', 'x\n', 'x\u007f', null])
      expect(isRequestTraceId(value)).toBe(false)
    expect(traceErrorCode('upstream_timeout')).toBe('upstream_timeout')
    expect(traceErrorCode('provider_down')).toBe('provider_down')
    expect(traceErrorCode('secret raw failure')).toBeNull()
  })
  it('preserves Gateway-compatible 512-codepoint provider IDs including whitespace and Unicode', () => {
    const value = fixture()
    for (const id of ['x'.repeat(300), 'line\nprovider\trequest', '🙂'.repeat(512)]) {
      value.attempts[0].providerRequestId = id
      expect(validateRequestTrace(value)).toBe(true)
    }
    for (const id of ['🙂'.repeat(513), 'embedded\0nul']) {
      value.attempts[0].providerRequestId = id
      expect(validateRequestTrace(value)).toBe(false)
    }
  })
  it('accepts bounded historical project/model strings without imposing new ingress restrictions', () => {
    const value = fixture()
    value.request.project.name = 'Alpha\nBeta\t🙂'
    value.request.requestedModel = '🙂'.repeat(256)
    value.attempts[0].resolvedModel = 'model\nidentifier'
    expect(validateRequestTrace(value)).toBe(true)
    value.request.project.name = 'bad\0name'
    expect(validateRequestTrace(value)).toBe(false)
    value.request.project.name = '🙂'.repeat(257)
    expect(validateRequestTrace(value)).toBe(false)
  })
})
