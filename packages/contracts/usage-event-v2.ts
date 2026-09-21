import { usageEventV2Schema } from './usage-event-v2.generated'
import type { NexusUsageEventV2 } from './usage-event-v2.generated'
export type { NexusUsageEventV2 } from './usage-event-v2.generated'
export type UsageEventUsageV2 = NexusUsageEventV2['usage']
export type UsageEventAttributionV2 = NexusUsageEventV2['attribution']
export type UsageEventStatusV2 = NexusUsageEventV2['status']
export type ExecutionModeV2 = UsageEventAttributionV2['execution_mode']
export const USAGE_EVENT_SCHEMA_VERSION_V2 = usageEventV2Schema.properties.schema_version.const

interface Relation {
  readonly kind: string
  readonly part?: string
  readonly whole?: string
  readonly total?: string
  readonly parts?: readonly string[]
  readonly when?: string
  readonly equals?: readonly unknown[]
  readonly field?: string
}
interface Schema {
  readonly type?: string | readonly string[]
  readonly const?: unknown
  readonly enum?: readonly unknown[]
  readonly properties?: Readonly<Record<string, Schema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
  readonly minimum?: number
  readonly maximum?: number
  readonly minLength?: number
  readonly maxLength?: number
  readonly format?: string
  readonly 'x-relations'?: readonly Relation[]
}
function validDateTime(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value)
  if (!match || +match[2] > 23 || +match[3] > 59 || +match[4] > 59 || +(match[5] ?? 0) > 23 || +(match[6] ?? 0) > 59)
    return false
  const date = new Date(`${match[1]}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(match[1])
}
/** This interpreter handles exactly the canonical schema vocabulary, not arbitrary JSON Schema. */
function validate(schema: Schema, value: unknown, path: string, errors: string[]): void {
  const fail = (message: string) => errors.push(`${path}: ${message}`)
  if ('const' in schema && value !== schema.const) fail('unexpected constant')
  if (schema.enum && !schema.enum.includes(value)) fail('value is outside enum')
  const kind = value === null ? 'null' : typeof value
  const types = typeof schema.type === 'string' ? [schema.type] : schema.type
  if (
    types &&
    !types.some((type) =>
      type === 'integer'
        ? typeof value === 'number' && Number.isSafeInteger(value)
        : type === kind && !Array.isArray(value),
    )
  ) {
    fail('incorrect type')
    return
  }
  if (typeof value === 'string') {
    const length = [...value].length
    if (schema.minLength !== undefined && length < schema.minLength) fail('string too short')
    if (schema.maxLength !== undefined && length > schema.maxLength) fail('string too long')
    if (schema.format === 'date-time' && !validDateTime(value)) fail('invalid date-time')
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail('below minimum')
    if (schema.maximum !== undefined && value > schema.maximum) fail('above maximum')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return
  const object = value as Record<string, unknown>
  for (const key of schema.required ?? []) if (!Object.hasOwn(object, key)) fail(`missing ${key}`)
  for (const [key, child] of Object.entries(object)) {
    const property = schema.properties?.[key]
    if (property) validate(property, child, `${path}.${key}`, errors)
    else if (schema.additionalProperties === false) fail(`unknown field ${key}`)
  }
  for (const rule of schema['x-relations'] ?? []) {
    if (rule.kind === 'subset') {
      const part = object[rule.part!],
        whole = object[rule.whole!]
      if (typeof part === 'number' && typeof whole === 'number' && part > whole)
        fail(`${rule.part} exceeds ${rule.whole}`)
    } else if (rule.kind === 'sum') {
      const total = object[rule.total!],
        parts = rule.parts!.map((key) => object[key])
      if (
        typeof total === 'number' &&
        parts.every((part) => typeof part === 'number') &&
        total !== (parts as number[]).reduce((a, b) => a + b, 0)
      )
        fail(`${rule.total} differs from component sum`)
    } else if (
      rule.equals!.includes(
        rule
          .when!.split('.')
          .reduce<unknown>(
            (value, key) =>
              value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined,
            object,
          ),
      )
    ) {
      if (rule.kind === 'requires-null' && object[rule.field!] !== null) fail(`${rule.field} must be null`)
      if (
        rule.kind === 'requires-value' &&
        (object[rule.field!] === null || object[rule.field!] === undefined || object[rule.field!] === '')
      )
        fail(`${rule.field} must be known`)
    }
  }
}
export function validateUsageEventV2(event: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  validate(usageEventV2Schema, event, 'event', errors)
  return { ok: errors.length === 0, errors }
}

/** Reuse canonical attribution rules for request-time capture before an event exists. */
export function validateUsageAttributionV2(attribution: unknown): boolean {
  const errors: string[] = []
  validate(usageEventV2Schema.properties.attribution, attribution, 'attribution', errors)
  return errors.length === 0
}

export function validateUsageRequestFieldV2(
  field: 'requested_model' | 'catalog_version_id' | 'policy_version_id',
  value: unknown,
): boolean {
  const errors: string[] = []
  validate(usageEventV2Schema.properties[field], value, field, errors)
  return errors.length === 0
}
export function usageEventTypeV2(status: UsageEventStatusV2): string {
  return `usage.v2.${status}`
}
