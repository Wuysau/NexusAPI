import schema from './schemas/usage-analytics-query.schema.json'
import responseSchema from './schemas/usage-analytics-response.schema.json'

/** Leaves room for a complete page without losing integer precision. */
export const MAX_ANALYTICS_OFFSET = schema.properties.offset['x-maximum']

export type AnalyticsGroupBy =
  'project' | 'provider' | 'model' | 'apiKey' | 'connection' | 'executionMode' | 'usageSource' | 'subscription' | 'day'
export const ANALYTICS_GROUP_BY = schema.properties.groupBy.enum as AnalyticsGroupBy[]
export function isAnalyticsGroupBy(value: string): value is AnalyticsGroupBy {
  return ANALYTICS_GROUP_BY.some((group) => group === value)
}
/** The Billing endpoint embeds this canonical projection alongside wallet data. */
export interface BillingAnalyticsResponse {
  analytics: UsageAnalyticsResponse
}
export interface AnalyticsQuery {
  scope: 'organization' | 'tenant'
  organizationId?: string
  projectId?: string
  providerId?: string
  provider?: string
  model?: string
  apiKeyId?: string
  connectionId?: string
  usageSource?: 'all' | 'gateway' | 'codex_local' | 'claude_code_local' | `agent:${string}`
  authority?: 'authoritative' | 'client_observed'
  executionMode?: 'managed' | 'byok' | 'unknown' | 'interactive'
  groupBy: AnalyticsGroupBy
  from: string
  to: string
  asOf: string
  limit: number
  offset: number
  status: 'all' | 'success' | 'error'
  q?: string
  cursor?: string
}
export interface ExactMetric {
  knownSum: string
  unknownRequests: string
  total: string | null
}
export interface AnalyticsTokenMetrics {
  input: ExactMetric
  output: ExactMetric
  cached: ExactMetric
  reasoning: ExactMetric
  total: ExactMetric
}
export interface AnalyticsCurrencyMetrics {
  currency: string | null
  charge: ExactMetric
  upstreamCost: ExactMetric
  margin: ExactMetric
}
export interface AnalyticsMetrics {
  requests: string
  sessions?: string
  observedEvents?: string
  lastActivity?: string | null
  provenance?: Array<{ source: string; authority: string; events: string }>
  tokens: AnalyticsTokenMetrics
  money: AnalyticsCurrencyMetrics[]
}
export interface AnalyticsGroup {
  key: string | null
  label: string | null
  metrics: AnalyticsMetrics
}
export interface UsageAnalyticsResponse {
  asOf: string
  from: string
  to: string
  groupBy: AnalyticsGroupBy
  totals: AnalyticsMetrics
  groups: AnalyticsGroup[]
  totalGroups: string
  limit: number
  offset: number
  nextOffset: number | null
}

export class AnalyticsQueryError extends Error {
  readonly status = 400
  readonly code = 'invalid_request'
  constructor(message: string) {
    super(message)
    this.name = 'AnalyticsQueryError'
  }
}

interface ResponseRule {
  $ref?: string
  type?: string | string[]
  enum?: string[]
  required?: string[]
  properties?: Record<string, ResponseRule>
  additionalProperties?: boolean
  items?: ResponseRule
  pattern?: string
  format?: string
  minimum?: number
  maximum?: number
  'x-exact-total'?: boolean
  'x-time-range'?: boolean
}

/** Interpret only the vocabulary used by the canonical response schema. */
export function validateUsageAnalyticsResponse(value: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const defs = responseSchema.$defs as Record<string, ResponseRule>
  function visit(rule: ResponseRule, item: unknown, path: string): void {
    if (rule.$ref) {
      visit(defs[rule.$ref.slice('#/$defs/'.length)], item, path)
      return
    }
    const types = Array.isArray(rule.type) ? rule.type : [rule.type]
    const actual = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item
    if (
      !types.some(
        (type) => type === actual || (type === 'integer' && typeof item === 'number' && Number.isSafeInteger(item)),
      )
    ) {
      errors.push(`${path}: invalid type`)
      return
    }
    if (typeof item === 'string') {
      if (rule.pattern && !new RegExp(rule.pattern).test(item)) errors.push(`${path}: invalid decimal or currency`)
      if (rule.enum && !rule.enum.includes(item)) errors.push(`${path}: invalid enum`)
      if (rule.format === 'date-time') {
        try {
          timestamp(item, path)
        } catch {
          errors.push(`${path}: invalid timestamp`)
        }
      }
    }
    if (
      typeof item === 'number' &&
      ((rule.minimum !== undefined && item < rule.minimum) || (rule.maximum !== undefined && item > rule.maximum))
    )
      errors.push(`${path}: out of range`)
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(rule.items!, entry, `${path}[${index}]`))
      return
    }
    if (item !== null && typeof item === 'object') {
      const object = item as Record<string, unknown>
      for (const key of rule.required ?? []) if (!Object.hasOwn(object, key)) errors.push(`${path}.${key}: missing`)
      for (const key of Object.keys(object)) {
        if (rule.properties && Object.hasOwn(rule.properties, key))
          visit(rule.properties[key], object[key], `${path}.${key}`)
        else if (rule.additionalProperties === false) errors.push(`${path}.${key}: unknown field`)
      }
      if (rule['x-exact-total'] && object.total !== (object.unknownRequests === '0' ? object.knownSum : null))
        errors.push(`${path}: total must preserve unknown observations`)
      if (
        rule['x-time-range'] &&
        (Date.parse(String(object.from)) > Date.parse(String(object.to)) ||
          Date.parse(String(object.to)) > Date.parse(String(object.asOf)))
      )
        errors.push(`${path}: invalid time range`)
    }
  }
  visit(responseSchema, value, 'response')
  return { ok: errors.length === 0, errors }
}
function fail(field: string): never {
  throw new AnalyticsQueryError(`Invalid analytics query: ${field}`)
}
function timestamp(value: string, field: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value)
  if (!m || +m[2] > 23 || +m[3] > 59 || +m[4] > 59 || +(m[5] ?? 0) > 23 || +(m[6] ?? 0) > 59) fail(field)
  const calendar = new Date(`${m[1]}T00:00:00Z`)
  const parsed = new Date(value)
  if (
    !Number.isFinite(calendar.getTime()) ||
    !calendar.toISOString().startsWith(m[1]) ||
    !Number.isFinite(parsed.getTime())
  )
    fail(field)
  return parsed.toISOString()
}
interface Rule {
  $ref?: string
  enum?: string[]
  default?: string
  minLength?: number
  maxLength?: number
  pattern?: string
  format?: string
  'x-trim'?: boolean
  'x-minimum'?: number
  'x-maximum'?: number
  'x-encoding'?: string
}

/** Parse URL syntax only; authorization and cursor scope remain server responsibilities. */
export function parseUsageAnalyticsQuery(params: URLSearchParams, now = new Date()): AnalyticsQuery {
  if (!Number.isFinite(now.getTime())) fail('now')
  const values: Record<string, string | number> = Object.create(null)
  const rules = schema.properties as Record<string, Rule>
  for (const [key, raw] of params) {
    if (!Object.hasOwn(rules, key) || Object.hasOwn(values, key)) fail(key)
    const original = rules[key]
    const rule: Rule = original.$ref ? schema.$defs.id : original
    const value = rule['x-trim'] ? raw.trim() : raw
    if (
      (rule.minLength !== undefined && value.length < rule.minLength) ||
      (rule.maxLength !== undefined && value.length > rule.maxLength) ||
      (rule.enum && !rule.enum.includes(value)) ||
      (rule.pattern && !new RegExp(rule.pattern, 'u').test(value))
    )
      fail(key)
    if (rule['x-encoding']) {
      try {
        const bytes = Buffer.from(value, 'base64url')
        if (bytes.toString('base64url') !== value) fail(key)
        const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) fail(key)
      } catch {
        fail(key)
      }
    }
    if (rule['x-minimum'] !== undefined) {
      const count = Number(value)
      if (!Number.isSafeInteger(count) || count < rule['x-minimum'] || count > rule['x-maximum']!) fail(key)
      values[key] = count
    } else values[key] = rule.format === 'date-time' ? timestamp(value, key) : value
  }
  for (const [key, rule] of Object.entries(rules))
    if (!Object.hasOwn(values, key) && rule.default !== undefined)
      values[key] = rule['x-minimum'] === undefined ? rule.default : Number(rule.default)
  values.asOf ??= now.toISOString()
  values.to ??= values.asOf
  if (
    Date.parse(String(values.asOf)) > now.getTime() ||
    Date.parse(String(values.to)) > Date.parse(String(values.asOf)) ||
    Date.parse(String(values.from)) > Date.parse(String(values.to))
  )
    fail('time range')
  if (values.provider === 'all') delete values.provider
  if (values.q === '') delete values.q
  return values as unknown as AnalyticsQuery
}
