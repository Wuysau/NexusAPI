// Price-candidate lifecycle state machine and auto-activation guard.
//
// Discovery and collection only ever produce CANDIDATES. Nothing becomes
// billable until it has been validated, approved by a human with
// `pricing:approve`, and activated at its effective time (ADR-0003). This
// module is the single gate that decides whether a state change is legal, and
// whether a change is safe enough to publish without a human (it never is for
// high-risk changes — see `canAutoActivate`).
//
// The pure functions here import no database code; the DB-backed
// `transitionPriceCandidate` loads the pool lazily so the state machine can be
// unit-tested without DATABASE_URL.

import type { PoolClient } from 'pg'
import {
  commonUnit,
  componentByKind,
  hasNonZeroAmount,
  parseDecimal,
  relativeChangeExceeds,
  type PriceComponent,
  validateComponents,
} from '../pricing/components'

export const PRICE_LIFECYCLE_STATES = [
  'fetched',
  'validated',
  'pending_approval',
  'scheduled',
  'active',
  'superseded',
  'rejected',
] as const

export type PriceLifecycleState = (typeof PRICE_LIFECYCLE_STATES)[number]

export function isPriceLifecycleState(value: unknown): value is PriceLifecycleState {
  return typeof value === 'string' && (PRICE_LIFECYCLE_STATES as readonly string[]).includes(value)
}

/**
 * Allowed transitions (verbatim from the plan):
 *   fetched → validated
 *   validated → pending_approval
 *   pending_approval → {scheduled, rejected}
 *   scheduled → active            (at effective_from, by the activation job)
 *   active → superseded           (by a newer active version)
 *   any → rejected
 * Forbidden, explicitly: active → fetched, superseded → active. Those are
 * absent from the table, and the table is deny-by-default.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<PriceLifecycleState, readonly PriceLifecycleState[]>> = Object.freeze({
  fetched: ['validated', 'rejected'],
  validated: ['pending_approval', 'rejected'],
  pending_approval: ['scheduled', 'rejected'],
  scheduled: ['active', 'rejected'],
  active: ['superseded', 'rejected'],
  superseded: ['rejected'],
  rejected: [],
})

export class LifecycleError extends Error {
  constructor(
    public code: 'invalid_transition' | 'not_found',
    message: string,
  ) {
    super(message)
    this.name = 'LifecycleError'
  }
}

export function canTransition(from: PriceLifecycleState, to: PriceLifecycleState): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to)
}

export function assertTransition(from: PriceLifecycleState, to: PriceLifecycleState): void {
  if (!canTransition(from, to)) {
    throw new LifecycleError('invalid_transition', `price lifecycle: ${from} → ${to} is not allowed`)
  }
}

export function nextStates(from: PriceLifecycleState): readonly PriceLifecycleState[] {
  return ALLOWED_TRANSITIONS[from] ?? []
}

// ── Auto-activation guard ──────────────────────────────────────────────

export const LOW_RISK_THRESHOLD_MICROS = 200_000n // 20%

export const AUTO_ACTIVATE_BLOCK_REASONS = {
  modelIdUnmatched: 'model_id_unmatched',
  parserStructureChanged: 'parser_structure_changed',
  currencyUnknown: 'currency_unknown',
  currencyChanged: 'currency_changed',
  unitUndeterminable: 'unit_undeterminable',
  multiContextTierAmbiguity: 'multi_context_tier_ambiguity',
  zeroPriceOnNonFreeModel: 'zero_price_on_non_free_model',
  priceChangeExceeds20Pct: 'price_change_exceeds_20pct',
} as const

export interface AutoActivateCandidate {
  provider: string
  modelId: string
  /** The discovered id resolved to a known catalog model. */
  modelIdMatched: boolean
  currency: string
  components: PriceComponent[]
  /** The parser saw a shape it does not recognize (page structure change). */
  parserStructureChanged?: boolean
  /** Explicitly free models may legitimately carry zero prices. */
  isFreeModel?: boolean
  /** Distinct context/price tiers present in the source for this model. */
  contextTiers?: number[]
  /** The model disappeared from the provider's list. */
  removed?: boolean
}

export interface ActivePriceVersionRef {
  id?: string
  currency: string
  components: PriceComponent[]
  contextTiers?: number[]
}

export interface AutoActivateResult {
  ok: boolean
  reasons: string[]
}

/**
 * Hard blocks for unattended (auto) activation. Any non-empty reason list means
 * the candidate MUST go through manual approval instead. High-risk changes can
 * still be approved by a human — this predicate only forbids publishing them
 * without one.
 */
export function canAutoActivate(
  candidate: AutoActivateCandidate,
  active: ActivePriceVersionRef | null,
): AutoActivateResult {
  const reasons: string[] = []

  if (!candidate.modelIdMatched) reasons.push(AUTO_ACTIVATE_BLOCK_REASONS.modelIdUnmatched)
  if (candidate.parserStructureChanged) reasons.push(AUTO_ACTIVATE_BLOCK_REASONS.parserStructureChanged)

  if (!/^[A-Z]{3}$/.test(candidate.currency)) reasons.push(AUTO_ACTIVATE_BLOCK_REASONS.currencyUnknown)
  if (active && active.currency && candidate.currency !== active.currency) {
    reasons.push(AUTO_ACTIVATE_BLOCK_REASONS.currencyChanged)
  }

  reasons.push(...validateComponents(candidate.components).reasons)

  const tiers = candidate.contextTiers ?? []
  if (new Set(tiers).size > 1) reasons.push(AUTO_ACTIVATE_BLOCK_REASONS.multiContextTierAmbiguity)
  if (!tiers.length && (active?.contextTiers?.length ?? 0) > 1) {
    reasons.push(AUTO_ACTIVATE_BLOCK_REASONS.multiContextTierAmbiguity)
  }

  if (!candidate.isFreeModel && !hasNonZeroAmount(candidate.components)) {
    reasons.push(AUTO_ACTIVATE_BLOCK_REASONS.zeroPriceOnNonFreeModel)
  }

  if (active) {
    for (const c of candidate.components) {
      const prev = componentByKind(active.components, c.kind)
      if (prev && relativeChangeExceeds(prev.amount, c.amount, LOW_RISK_THRESHOLD_MICROS)) {
        reasons.push(AUTO_ACTIVATE_BLOCK_REASONS.priceChangeExceeds20Pct)
        break
      }
    }
  }

  return { ok: reasons.length === 0, reasons: dedupe(reasons) }
}

/**
 * Risk classification for the review queue. Superset of the hard blocks:
 * removals, unit changes, any price increase and structural anomalies are
 * flagged high-risk even when they would not be auto-blocked. The flag is
 * advisory metadata for the console; approval is still required either way
 * (a candidate is never active without one).
 */
export function classifyRisk(
  candidate: AutoActivateCandidate,
  active: ActivePriceVersionRef | null,
): { highRisk: boolean; reasons: string[] } {
  const reasons = [...canAutoActivate(candidate, active).reasons]

  if (candidate.removed) reasons.push('model_removed')
  if (active) {
    const prevUnit = commonUnit(active.components)
    const nextUnit = commonUnit(candidate.components)
    if (prevUnit && nextUnit && prevUnit !== nextUnit) reasons.push('unit_changed')

    for (const c of candidate.components) {
      const prev = componentByKind(active.components, c.kind)
      if (prev && decimalGreaterThan(c.amount, prev.amount)) {
        reasons.push('price_increase')
        break
      }
    }
    if (Math.abs(candidate.components.length - active.components.length) >= 2) {
      reasons.push('component_count_anomaly')
    }
  }

  const unique = dedupe(reasons)
  return { highRisk: unique.length > 0, reasons: unique }
}

function decimalGreaterThan(a: string, b: string): boolean {
  const x = parseDecimal(a)
  const y = parseDecimal(b)
  return x.num * y.den > y.num * x.den
}

// ── DB-backed transition ───────────────────────────────────────────────

export interface TransitionPriceCandidateInput {
  candidateId: string
  to: PriceLifecycleState
  actorUserId?: string | null
  tenantId?: string | null
  reason?: string
  /** Join an existing transaction instead of opening one. */
  client?: PoolClient
  traceId?: string
}

export interface TransitionResult {
  id: string
  from: PriceLifecycleState
  to: PriceLifecycleState
}

/**
 * Apply a lifecycle transition under a row lock and write the audit record in
 * the same transaction. Illegal transitions throw LifecycleError before any
 * row is touched. Audit is fail-closed: if it cannot be written, the
 * transaction rolls back.
 */
export async function transitionPriceCandidate(input: TransitionPriceCandidateInput): Promise<TransitionResult> {
  // Lazy imports keep the pure state machine importable without a database.
  const { pool } = await import('@/db')
  const { logAudit } = await import('@/lib/audit')

  const ownClient = !input.client
  const client = input.client ?? (await pool.connect())
  try {
    if (ownClient) await client.query('BEGIN')
    const current = await client.query<{ id: string; status: string }>(
      'SELECT id, status FROM price_candidates WHERE id = $1 FOR UPDATE',
      [input.candidateId],
    )
    if (!current.rows.length) {
      throw new LifecycleError('not_found', `price candidate ${input.candidateId} not found`)
    }
    const from = current.rows[0].status as PriceLifecycleState
    assertTransition(from, input.to)

    await client.query('UPDATE price_candidates SET status = $2, updated_at = now() WHERE id = $1', [
      input.candidateId,
      input.to,
    ])

    await logAudit({
      actorUserId: input.actorUserId ?? null,
      tenantId: input.tenantId ?? null,
      action: 'catalog.price_lifecycle_transition',
      targetType: 'price_candidate',
      targetId: input.candidateId,
      metadata: { from, to: input.to, reason: input.reason ?? null },
      traceId: input.traceId,
      client,
    })

    if (ownClient) await client.query('COMMIT')
    return { id: input.candidateId, from, to: input.to }
  } catch (e) {
    if (ownClient) await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    if (ownClient) client.release()
  }
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}
