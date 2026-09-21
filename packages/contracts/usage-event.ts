// NexusUsageEventV1 — shared TypeScript binding for
// packages/contracts/schemas/usage-event.schema.json, the fact the Go
// data plane writes to the outbox and the relay publishes.
//
// The Go side has a mirrored implementation in services/gateway/contracts.go
// (UsageEvent + Validate). Both are checked against the JSON Schema by the
// respective test suites; neither is generated, because the schema is small and
// a generator would add a build step for no benefit.

export const USAGE_EVENT_SCHEMA_VERSION = 1

export type UsageEventStatus = 'completed' | 'failed' | 'unknown'

export interface UsageEventUsage {
  input_tokens: number
  cached_input_tokens?: number
  output_tokens: number
  reasoning_tokens?: number
  estimated: boolean
}

/** Field order and names are fixed by the contract; do not rename. */
export interface NexusUsageEventV1 {
  schema_version: typeof USAGE_EVENT_SCHEMA_VERSION
  event_id: string
  occurred_at: string
  tenant_id: string
  request_id: string
  attempt_id: string
  provider_request_id?: string | null
  model_id: string
  status: UsageEventStatus
  price_version_id: string
  catalog_version_id: string
  policy_version_id?: string | null
  usage: UsageEventUsage
  dimensions?: Record<string, string | number>
}

export interface UsageEventValidation {
  ok: boolean
  errors: string[]
}

const STATUSES: readonly UsageEventStatus[] = ['completed', 'failed', 'unknown']
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Validate an event against the parts of the schema a type cannot express.
 * Mirrors UsageEvent.Validate() in Go so both sides agree on what "valid" is.
 */
export function validateUsageEvent(event: unknown): UsageEventValidation {
  const errors: string[] = []
  if (!event || typeof event !== 'object') {
    return { ok: false, errors: ['event must be an object'] }
  }
  const value = event as Partial<NexusUsageEventV1>

  if (value.schema_version !== USAGE_EVENT_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${USAGE_EVENT_SCHEMA_VERSION}`)
  }
  if (typeof value.event_id !== 'string' || value.event_id.length < 16) {
    errors.push('event_id must be a string of at least 16 characters')
  }
  if (typeof value.occurred_at !== 'string' || !RFC3339.test(value.occurred_at)) {
    errors.push('occurred_at must be an RFC3339 date-time')
  }
  for (const field of [
    'tenant_id',
    'request_id',
    'attempt_id',
    'model_id',
    'price_version_id',
    'catalog_version_id',
  ] as const) {
    if (typeof value[field] !== 'string' || (value[field] as string).length === 0) {
      errors.push(`${field} is required`)
    }
  }
  if (!STATUSES.includes(value.status as UsageEventStatus)) {
    errors.push('status must be completed, failed or unknown')
  }
  const usage = value.usage
  if (!usage || typeof usage !== 'object') {
    errors.push('usage is required')
  } else {
    if (!isNonNegativeInteger(usage.input_tokens)) errors.push('usage.input_tokens must be a non-negative integer')
    if (!isNonNegativeInteger(usage.output_tokens)) errors.push('usage.output_tokens must be a non-negative integer')
    if (typeof usage.estimated !== 'boolean') errors.push('usage.estimated must be a boolean')
    if (usage.cached_input_tokens !== undefined && !isNonNegativeInteger(usage.cached_input_tokens)) {
      errors.push('usage.cached_input_tokens must be a non-negative integer')
    }
    if (usage.reasoning_tokens !== undefined && !isNonNegativeInteger(usage.reasoning_tokens)) {
      errors.push('usage.reasoning_tokens must be a non-negative integer')
    }
  }
  if (
    value.provider_request_id !== undefined &&
    value.provider_request_id !== null &&
    value.provider_request_id === ''
  ) {
    errors.push('provider_request_id must not be an empty string when present')
  }
  return { ok: errors.length === 0, errors }
}

/**
 * The outbox event type the gateway writes for a terminal request. Kept here so
 * the relay and the gateway agree without importing across the language
 * boundary.
 */
export function usageEventType(status: UsageEventStatus): string {
  return `usage.${status}`
}
