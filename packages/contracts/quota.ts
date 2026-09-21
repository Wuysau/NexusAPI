import schema from './schemas/quota-observation.schema.json'

export type QuotaScope = 'account' | 'connection' | 'project-estimated' | 'unknown'
export type QuotaSourceKind = 'official' | 'reported' | 'estimated' | 'derived' | 'unknown'
export type QuotaConfidence = 'authoritative' | 'reported' | 'estimated' | 'unknown'
export type QuotaAttributionMode = 'shared' | 'exclusive' | 'unknown'
export type QuotaAvailability = 'available' | 'unavailable' | 'unknown'
export type QuotaFreshness = 'fresh' | 'stale' | 'unknown' | 'unavailable'

/** Stronger provenance is an output vocabulary, never public ingestion authority. */
export interface QuotaSnapshotMetadata {
  provenanceVersion: 1 | null
  observationId: string | null
  scope: QuotaScope
  sourceKind: QuotaSourceKind
  confidence: QuotaConfidence
  attributionMode: QuotaAttributionMode
  availability: QuotaAvailability
  freshness: QuotaFreshness
  observedAt: string | null
  staleAt: string | null
  resetAt: string | null
}

export interface ManualQuotaObservation {
  observationId: string
  windowType: string
  used: string | null
  remaining: string | null
  scope: 'account' | 'connection'
  source: 'manual'
  sourceKind: 'reported' | 'estimated' | 'unknown'
  confidence: 'reported' | 'estimated' | 'unknown'
  attributionMode: 'shared' | 'unknown'
  observedAt: string
  staleAt: string
  resetAt: string | null
  availability: 'available' | 'unavailable'
}
export class QuotaContractError extends Error {
  readonly status = 400
  readonly code = 'invalid_request'
  constructor(field: string) {
    super(`Invalid quota observation: ${field}`)
    this.name = 'QuotaContractError'
  }
}
function invalid(field: string): never {
  throw new QuotaContractError(field)
}
function dateTime(value: string, field: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value)
  if (!m || +m[2] > 23 || +m[3] > 59 || +m[4] > 59 || +(m[5] ?? 0) > 23 || +(m[6] ?? 0) > 59) invalid(field)
  const calendar = new Date(`${m[1]}T00:00:00Z`),
    parsed = new Date(value)
  if (
    !Number.isFinite(calendar.getTime()) ||
    !calendar.toISOString().startsWith(m[1]) ||
    !Number.isFinite(parsed.getTime())
  )
    invalid(field)
  return parsed.toISOString()
}
interface Rule {
  $ref?: string
  type?: string | string[]
  enum?: string[]
  pattern?: string
  minLength?: number
  maxLength?: number
  format?: string
}

/** Public manual endpoint: no capability JSON or caller label upgrades trust. */
export function parseManualQuotaObservation(value: unknown, now = new Date()): ManualQuotaObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('body')
  if (!Number.isFinite(now.getTime())) invalid('now')
  const input = value as Record<string, unknown>
  const properties = schema.properties as Record<string, Rule>
  const defs = schema.$defs as Record<string, Rule>
  for (const field of schema.required) if (!Object.hasOwn(input, field)) invalid(field)
  const output: Record<string, string | null> = Object.create(null)
  for (const [field, item] of Object.entries(input)) {
    if (!Object.hasOwn(properties, field)) invalid(field)
    const original = properties[field],
      rule = original.$ref ? defs[original.$ref.slice('#/$defs/'.length)] : original
    if (item === null && Array.isArray(rule.type) && rule.type.includes('null')) {
      output[field] = null
      continue
    }
    if (typeof item !== 'string') invalid(field)
    if (
      (rule.enum && !rule.enum.includes(item)) ||
      (rule.pattern && !new RegExp(rule.pattern, 'u').test(item)) ||
      (rule.minLength !== undefined && item.length < rule.minLength) ||
      (rule.maxLength !== undefined && item.length > rule.maxLength)
    )
      invalid(field)
    if (field === 'used' || field === 'remaining') {
      const [integer, fraction = ''] = item.split('.')
      const whole = integer.replace(/^0+/, '') || '0',
        decimal = fraction.replace(/0+$/, '')
      output[field] = decimal ? `${whole}.${decimal}` : whole
    } else output[field] = rule.format === 'date-time' ? dateTime(item, field) : item
  }
  output.resetAt ??= null
  const observed = Date.parse(output.observedAt!)
  if (
    observed > now.getTime() ||
    Date.parse(output.staleAt!) < observed ||
    (output.resetAt !== null && Date.parse(output.resetAt) < observed)
  )
    invalid('time range')
  if (output.availability === 'unavailable' && (output.used !== null || output.remaining !== null))
    invalid('unavailable counts')
  return output as unknown as ManualQuotaObservation
}
export function validateManualQuotaObservation(value: unknown, now = new Date()): { ok: boolean; errors: string[] } {
  try {
    parseManualQuotaObservation(value, now)
    return { ok: true, errors: [] }
  } catch (error) {
    if (error instanceof QuotaContractError) return { ok: false, errors: [error.message] }
    throw error
  }
}
