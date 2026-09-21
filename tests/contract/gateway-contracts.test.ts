// Contract tests for the cross-service bindings (packages/contracts).
//
// These do not need a database: they assert that the TS validators agree with
// the JSON Schema in packages/contracts/schemas, and that the error
// table matches the documented HTTP mapping. The Go side is checked against the
// same shapes by services/gateway/contracts_test.go.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  USAGE_EVENT_SCHEMA_VERSION,
  validateUsageEvent,
  usageEventType,
  type NexusUsageEventV1,
} from '@/../packages/contracts/usage-event'
import { API_ERROR_CODES, API_ERROR_STATUS, API_ERROR_TYPES, isRetryableCode } from '@/../packages/contracts/api-errors'

const SCHEMAS = join(process.cwd(), 'packages', 'contracts', 'schemas')

function readSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(SCHEMAS, name), 'utf-8')) as Record<string, unknown>
}

function validEvent(over: Partial<NexusUsageEventV1> = {}): NexusUsageEventV1 {
  return {
    schema_version: 1,
    event_id: 'evt_0123456789abcdef0123456789abcdef',
    occurred_at: '2026-09-11T00:00:00Z',
    tenant_id: 'tenant-1',
    request_id: 'req_1',
    attempt_id: 'att_1',
    model_id: 'gpt-4o',
    status: 'completed',
    price_version_id: 'pv_1',
    catalog_version_id: 'cat_1',
    usage: { input_tokens: 10, output_tokens: 5, estimated: false },
    ...over,
  }
}

describe('NexusUsageEventV1', () => {
  const schema = readSchema('usage-event.schema.json')

  it('requires exactly the fields the JSON Schema requires', () => {
    const required = schema.required as string[]
    const missing = required.filter((field) => !(field in validEvent()))
    expect(missing).toEqual([])

    // And the validator rejects an event with any required field removed.
    for (const field of required) {
      const broken = { ...validEvent() } as Record<string, unknown>
      delete broken[field]
      expect(validateUsageEvent(broken).ok, `removing ${field} must invalidate the event`).toBe(false)
    }
  })

  it('accepts a fully-populated event', () => {
    const event = validEvent({
      provider_request_id: 'chatcmpl-1',
      policy_version_id: 'pol_1',
      usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5, reasoning_tokens: 2, estimated: false },
      dimensions: { channel_id: 'chan_1', streaming: 1 },
    })
    expect(validateUsageEvent(event)).toEqual({ ok: true, errors: [] })
  })

  it('enforces the schema enumerations and minimums', () => {
    expect(validateUsageEvent(validEvent({ event_id: 'short' })).ok).toBe(false)
    expect(validateUsageEvent(validEvent({ occurred_at: 'yesterday' })).ok).toBe(false)
    expect(validateUsageEvent(validEvent({ status: 'maybe' as never })).ok).toBe(false)
    expect(validateUsageEvent(validEvent({ schema_version: 2 as never })).ok).toBe(false)
    expect(validateUsageEvent(validEvent({ usage: { input_tokens: -1, output_tokens: 0, estimated: true } })).ok).toBe(
      false,
    )
    expect(
      validateUsageEvent(validEvent({ usage: { input_tokens: 1, output_tokens: 0, estimated: 'yes' as never } })).ok,
    ).toBe(false)
  })

  it('uses the schema_version and event type the gateway writes', () => {
    expect(USAGE_EVENT_SCHEMA_VERSION).toBe(
      (schema.properties as Record<string, { const: number }>).schema_version.const,
    )
    expect(usageEventType('unknown')).toBe('usage.unknown')
  })

  it('marks estimated usage explicitly (never a silent zero)', () => {
    const estimated = validEvent({ status: 'unknown', usage: { input_tokens: 7, output_tokens: 0, estimated: true } })
    expect(validateUsageEvent(estimated).ok).toBe(true)
    expect(estimated.usage.estimated).toBe(true)
  })
})

describe('public API error contract', () => {
  it('maps every code to the documented HTTP status', () => {
    expect(API_ERROR_STATUS.invalid_api_key).toBe(401)
    expect(API_ERROR_STATUS.scope_denied).toBe(403)
    expect(API_ERROR_STATUS.idempotency_conflict).toBe(409)
    expect(API_ERROR_STATUS.request_too_large).toBe(413)
    expect(API_ERROR_STATUS.capability_not_supported).toBe(422)
    expect(API_ERROR_STATUS.budget_exceeded).toBe(429)
    expect(API_ERROR_STATUS.rate_limit_exceeded).toBe(429)
    expect(API_ERROR_STATUS.upstream_protocol_error).toBe(502)
    expect(API_ERROR_STATUS.no_healthy_upstream).toBe(503)
    expect(API_ERROR_STATUS.snapshot_expired).toBe(503)
    expect(API_ERROR_STATUS.storage_unavailable).toBe(503)
    expect(API_ERROR_STATUS.upstream_timeout).toBe(504)
  })

  it('covers every code in the status table', () => {
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_STATUS[code], `${code} needs an HTTP mapping`).toBeTypeOf('number')
    }
  })

  it('classifies only safe codes as retryable', () => {
    expect(isRetryableCode('invalid_api_key')).toBe(false)
    expect(isRetryableCode('budget_exceeded')).toBe(false)
    expect(isRetryableCode('model_not_allowed')).toBe(false)
    expect(isRetryableCode('rate_limit_exceeded')).toBe(true)
    expect(isRetryableCode('no_healthy_upstream')).toBe(true)
  })

  it('exposes the documented error types', () => {
    expect(API_ERROR_TYPES).toContain('policy_error')
    expect(API_ERROR_TYPES).toContain('service_unavailable_error')
  })
})
