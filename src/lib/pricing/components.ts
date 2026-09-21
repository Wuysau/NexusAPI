// Price component model — the monetary payload of a NexusPriceRecordV1.
//
// A provider price is NOT a scalar. One model can charge differently for fresh
// input, cached input, output, reasoning tokens, per request, images, audio and
// stored bytes, and any of those can carry billing conditions (context tier,
// region, batch vs interactive). We model each billable dimension as a
// component so a version is complete, comparable and diffable.
//
// The existing `CostPrice` interface (four token rates + one unit) is a LOSSY
// projection of this model, kept because the Phase-0 charge math uses it.
// `componentsToCostPrice` / `costPriceToComponents` are the only bridge; they
// never guess — an unrepresentable component set throws rather than silently
// dropping a billable dimension.
//
// Contract: packages/contracts/schemas/price-record.schema.json

import { parseDecimal, type Micros } from '../money'
import type { CostPrice } from '../pricing'

export { parseDecimal }

export const PRICE_COMPONENT_KINDS = [
  'input',
  'cached_input',
  'output',
  'reasoning',
  'request',
  'image',
  'audio',
  'storage',
] as const

export type PriceComponentKind = (typeof PRICE_COMPONENT_KINDS)[number]

/** Token-rate units. Non-token components use a count unit (per_request, …). */
export const PRICE_UNITS = [
  'per_million_tokens',
  'per_token',
  'per_request',
  'per_image',
  'per_second',
  'per_gb_month',
] as const

export type PriceUnit = (typeof PRICE_UNITS)[number]

export const TOKEN_COMPONENT_KINDS: readonly PriceComponentKind[] = ['input', 'cached_input', 'output', 'reasoning']

export const PRICE_RECORD_STATUSES = [
  'fetched',
  'validated',
  'pending_approval',
  'scheduled',
  'active',
  'superseded',
  'rejected',
] as const

export type PriceRecordStatus = (typeof PRICE_RECORD_STATUSES)[number]

export interface PriceComponent {
  kind: PriceComponentKind
  unit: string
  amount: string // non-negative decimal string, in `unit`
  conditions: Record<string, unknown>
}

export interface NexusPriceRecordSource {
  url: string
  retrieved_at: string
  content_sha256: string
}

/** Shape of packages/contracts/schemas/price-record.schema.json (additionalProperties: false). */
export interface NexusPriceRecordV1 {
  schema_version: 1
  provider: string
  model_id: string
  currency: string
  status: PriceRecordStatus
  effective_from: string
  effective_to: string | null
  components: PriceComponent[]
  source: NexusPriceRecordSource
  approved_by: string | null
  approved_at: string | null
}

export interface ValidationResult {
  ok: boolean
  errors: string[]
  /** Machine-readable block reasons (subset of the auto-activation rules). */
  reasons: string[]
}

const AMOUNT_RE = /^[0-9]+(\.[0-9]+)?$/
const CURRENCY_RE = /^[A-Z]{3}$/
const SHA256_RE = /^[a-f0-9]{64}$/

export function isPriceComponentKind(value: unknown): value is PriceComponentKind {
  return typeof value === 'string' && (PRICE_COMPONENT_KINDS as readonly string[]).includes(value)
}

export function isPriceUnit(value: unknown): value is PriceUnit {
  return typeof value === 'string' && (PRICE_UNITS as readonly string[]).includes(value)
}

export function isPriceRecordStatus(value: unknown): value is PriceRecordStatus {
  return typeof value === 'string' && (PRICE_RECORD_STATUSES as readonly string[]).includes(value)
}

export function componentByKind(
  components: readonly PriceComponent[],
  kind: PriceComponentKind,
): PriceComponent | null {
  return components.find((c) => c.kind === kind) ?? null
}

/** Amount for a kind, or '0' when the dimension is not charged. */
export function componentAmount(components: readonly PriceComponent[], kind: PriceComponentKind): string {
  return componentByKind(components, kind)?.amount ?? '0'
}

/** True when at least one component has a non-zero amount. */
export function hasNonZeroAmount(components: readonly PriceComponent[]): boolean {
  return components.some((c) => parseDecimal(c.amount).num !== 0n)
}

/** Single unit shared by every component, or null when mixed/unknown. */
export function commonUnit(components: readonly PriceComponent[]): string | null {
  const units = new Set(components.map((c) => c.unit))
  if (units.size !== 1) return null
  return [...units][0] ?? null
}

/**
 * Structural validation of a component set. Pure: no DB, no clock.
 * `reasons` are the auto-activation block rules this set triggers.
 */
export function validateComponents(components: readonly PriceComponent[]): ValidationResult {
  const errors: string[] = []
  const reasons: string[] = []

  if (components.length === 0) {
    errors.push('components: at least one component is required')
    reasons.push('unit_undeterminable')
    return { ok: false, errors, reasons }
  }

  for (const c of components) {
    if (!isPriceComponentKind(c.kind)) errors.push(`component: unknown kind "${String(c.kind)}"`)
    if (!isPriceUnit(c.unit)) {
      errors.push(`component ${String(c.kind)}: unknown unit "${String(c.unit)}"`)
      reasons.push('unit_undeterminable')
    }
    if (typeof c.amount !== 'string' || !AMOUNT_RE.test(c.amount)) {
      errors.push(`component ${String(c.kind)}: invalid amount "${String(c.amount)}"`)
    }
  }

  // A version must be priced in exactly one unit; mixing per-token and
  // per-request rates makes the version non-comparable and unsafe to activate.
  if (components.length > 1 && commonUnit(components) === null) {
    errors.push('components: mixed units within one price version')
    reasons.push('unit_undeterminable')
  }

  return { ok: errors.length === 0, errors, reasons: dedupe(reasons) }
}

/**
 * Project a component set onto the legacy CostPrice shape.
 * Throws when a component cannot be represented — never drops silently.
 */
export function componentsToCostPrice(components: readonly PriceComponent[], currency: string): CostPrice {
  const unit = commonUnit(components) ?? 'per_million_tokens'
  return {
    inputPrice: componentAmount(components, 'input'),
    outputPrice: componentAmount(components, 'output'),
    cachedInputPrice: componentAmount(components, 'cached_input'),
    reasoningPrice: componentAmount(components, 'reasoning'),
    requestPrice: componentAmount(components, 'request'),
    imagePrice: componentAmount(components, 'image'),
    audioPrice: componentAmount(components, 'audio'),
    storagePrice: componentAmount(components, 'storage'),
    unit,
    currency,
  }
}

export interface NonTokenComponentAmounts {
  request?: string
  image?: string
  audio?: string
  storage?: string
}

/** Inverse of `componentsToCostPrice`: exact for token + non-token rates. */
export function costPriceToComponents(price: CostPrice, nonToken?: NonTokenComponentAmounts): PriceComponent[] {
  const conditions = {}
  const comps: PriceComponent[] = [
    { kind: 'input', unit: price.unit, amount: price.inputPrice, conditions },
    { kind: 'cached_input', unit: price.unit, amount: price.cachedInputPrice, conditions },
    { kind: 'output', unit: price.unit, amount: price.outputPrice, conditions },
    { kind: 'reasoning', unit: price.unit, amount: price.reasoningPrice, conditions },
  ]
  const extras: [PriceComponentKind, string | undefined, string][] = [
    ['request', nonToken?.request ?? price.requestPrice, 'per_request'],
    ['image', nonToken?.image ?? price.imagePrice, 'per_image'],
    ['audio', nonToken?.audio ?? price.audioPrice, 'per_second'],
    ['storage', nonToken?.storage ?? price.storagePrice, 'per_gb_month'],
  ]
  for (const [kind, amount, unit] of extras) {
    if (amount !== undefined && parseDecimal(amount).num !== 0n) comps.push({ kind, unit, amount, conditions })
  }
  return comps
}

/**
 * Exact relative-change test: |new - old| / old > threshold, in integer math.
 * old == 0 and new != 0 counts as "exceeds" (0 → any price is an anomaly).
 * threshold is a ratio in micros (20% = 200_000).
 */
export function relativeChangeExceeds(oldAmount: string, newAmount: string, thresholdMicros = 200_000n): boolean {
  const old = parseDecimal(oldAmount)
  const next = parseDecimal(newAmount)
  if (old.num === 0n) return next.num !== 0n
  if (next.num < 0n || old.num < 0n) return true
  // |next/next.den - old/old.den| / (old/old.den)
  //   = |next*old.den - old*next.den| / (old*next.den)
  const delta = abs(next.num * old.den - old.num * next.den)
  const base = old.num * next.den
  return delta * 1_000_000n > base * thresholdMicros
}

function abs(v: bigint): bigint {
  return v < 0n ? -v : v
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** Validate an object against packages/contracts/schemas/price-record.schema.json (hand-rolled, no dep). */
export function validatePriceRecord(record: unknown): ValidationResult {
  const errors: string[] = []
  const reasons: string[] = []
  if (typeof record !== 'object' || record === null) {
    return { ok: false, errors: ['record: not an object'], reasons: [] }
  }
  const r = record as Record<string, unknown>

  if (r.schema_version !== 1) errors.push('schema_version: must be 1')
  if (typeof r.provider !== 'string' || !r.provider) errors.push('provider: required string')
  if (typeof r.model_id !== 'string' || !r.model_id) errors.push('model_id: required string')
  if (typeof r.currency !== 'string' || !CURRENCY_RE.test(r.currency)) {
    errors.push('currency: must match ^[A-Z]{3}$')
    reasons.push('currency_unknown')
  }
  if (!isPriceRecordStatus(r.status)) errors.push('status: not a known lifecycle state')
  if (typeof r.effective_from !== 'string' || Number.isNaN(Date.parse(r.effective_from))) {
    errors.push('effective_from: must be an ISO date-time')
  }
  if (r.effective_to !== null && (typeof r.effective_to !== 'string' || Number.isNaN(Date.parse(r.effective_to)))) {
    errors.push('effective_to: must be null or an ISO date-time')
  }
  if (r.approved_by !== null && typeof r.approved_by !== 'string') errors.push('approved_by: must be null or string')
  if (r.approved_at !== null && (typeof r.approved_at !== 'string' || Number.isNaN(Date.parse(r.approved_at)))) {
    errors.push('approved_at: must be null or an ISO date-time')
  }

  const src = r.source
  if (typeof src !== 'object' || src === null) {
    errors.push('source: required object')
  } else {
    const s = src as Record<string, unknown>
    if (typeof s.url !== 'string' || !s.url) errors.push('source.url: required string')
    if (typeof s.retrieved_at !== 'string' || Number.isNaN(Date.parse(s.retrieved_at))) {
      errors.push('source.retrieved_at: must be an ISO date-time')
    }
    if (typeof s.content_sha256 !== 'string' || !SHA256_RE.test(s.content_sha256)) {
      errors.push('source.content_sha256: must be 64 lowercase hex chars')
    }
  }

  if (!Array.isArray(r.components)) {
    errors.push('components: required array')
    reasons.push('unit_undeterminable')
  } else {
    const components = r.components as PriceComponent[]
    const compValidation = validateComponents(components)
    errors.push(...compValidation.errors)
    reasons.push(...compValidation.reasons)
  }

  return { ok: errors.length === 0, errors, reasons: dedupe(reasons) }
}

export interface BuildPriceRecordInput {
  provider: string
  modelId: string
  currency: string
  status: PriceRecordStatus
  effectiveFrom: Date | string
  effectiveTo?: Date | string | null
  components: PriceComponent[]
  source: NexusPriceRecordSource
  approvedBy?: string | null
  approvedAt?: Date | string | null
}

/** Assemble a schema-conformant record. Times are normalized to ISO strings. */
export function buildPriceRecord(input: BuildPriceRecordInput): NexusPriceRecordV1 {
  const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString())
  return {
    schema_version: 1,
    provider: input.provider,
    model_id: input.modelId,
    currency: input.currency,
    status: input.status,
    effective_from: iso(input.effectiveFrom),
    effective_to: input.effectiveTo ? iso(input.effectiveTo) : null,
    components: input.components,
    source: input.source,
    approved_by: input.approvedBy ?? null,
    approved_at: input.approvedAt ? iso(input.approvedAt) : null,
  }
}

/** Sum of component rates in micros. Diagnostic only — not a charge. */
export function sumComponentRateMicros(components: readonly PriceComponent[]): Micros {
  let total = 0n
  for (const c of components) {
    const { num, den } = parseDecimal(c.amount)
    total += (num * 1_000_000n) / den
  }
  return total
}
