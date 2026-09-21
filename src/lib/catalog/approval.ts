// Approval of a price candidate.
//
// Approval is a human, capability-gated action (`pricing:approve`, held by
// billing/admin/owner — see src/lib/auth/capabilities.ts). The approver may set
// a future effective time; the activation job publishes it when due. Approval
// always writes an audit record, including the risk reasons that would have
// blocked unattended activation — a human may override a block, but never
// silently (ADR-0003, DYNAMIC spec §Approval and Activation).

import { pool } from '@/db'
import { logAudit } from '@/lib/audit'
import { requireCapability, type Principal } from '@/lib/auth/capabilities'
import type { PoolClient } from 'pg'
import type { PriceComponent } from '@/lib/pricing/components'
import { activateCandidate } from './activation'
import { assertCandidatePriceEvidence } from './evidence'
import { assertTransition, canAutoActivate, transitionPriceCandidate, type PriceLifecycleState } from './lifecycle'

export interface ApprovePriceInput {
  candidateId: string
  actor: Principal | null
  /** Future times schedule the activation; past/now activates immediately. */
  effectiveFrom?: Date | string
  reason?: string
  tenantId?: string | null
  ip?: string
  traceId?: string
}

export interface ApprovePriceResult {
  candidateId: string
  status: 'scheduled' | 'active'
  versionId: string | null
  effectiveFrom: string
  /** True when the change is high-risk and a human overrode the auto-activation block. */
  autoActivateBlocked: boolean
  riskReasons: string[]
}

interface CandidateForApproval {
  id: string
  provider_id: string
  upstream_model_id: string
  currency: string
  region: string
  status: PriceLifecycleState
  high_risk_flag: boolean
  risk_reasons: string[]
}

async function loadCandidate(client: PoolClient, candidateId: string): Promise<CandidateForApproval> {
  const res = await client.query<CandidateForApproval>(
    `SELECT id, provider_id, upstream_model_id, currency, region, status, high_risk_flag, risk_reasons
     FROM price_candidates WHERE id = $1 FOR UPDATE`,
    [candidateId],
  )
  if (!res.rows.length) throw new Error(`price candidate ${candidateId} not found`)
  return res.rows[0]
}

/** The service tier of the candidate's version (candidates carry no tier column). */
async function serviceTierForCandidate(client: PoolClient, candidateId: string): Promise<string> {
  const res = await client.query<{ service_tier: string }>(
    `SELECT v.service_tier FROM price_components pc
     JOIN provider_price_versions v ON v.id = pc.price_version_id
     WHERE pc.price_candidate_id = $1 LIMIT 1`,
    [candidateId],
  )
  return res.rows[0]?.service_tier ?? 'default'
}

async function activeVersionFor(
  client: PoolClient,
  candidate: CandidateForApproval,
  serviceTier: string,
): Promise<{ id: string; currency: string; components: PriceComponent[] } | null> {
  const version = await client.query<{ id: string; currency: string }>(
    `SELECT id, currency FROM provider_price_versions
     WHERE provider_id = $1 AND upstream_model_id = $2 AND region = $3 AND service_tier = $4 AND status = 'active'
     LIMIT 1`,
    [candidate.provider_id, candidate.upstream_model_id, candidate.region, serviceTier],
  )
  if (!version.rows.length) return null
  const comps = await client.query<{ kind: string; unit: string; amount: string; conditions: Record<string, unknown> }>(
    'SELECT kind, unit, amount, conditions FROM price_components WHERE price_version_id = $1 ORDER BY kind',
    [version.rows[0].id],
  )
  return {
    id: version.rows[0].id,
    currency: version.rows[0].currency,
    components: comps.rows.map((c) => ({
      kind: c.kind as PriceComponent['kind'],
      unit: c.unit,
      amount: c.amount,
      conditions: c.conditions ?? {},
    })),
  }
}

async function candidateComponents(client: PoolClient, candidateId: string): Promise<PriceComponent[]> {
  const res = await client.query<{ kind: string; unit: string; amount: string; conditions: Record<string, unknown> }>(
    `SELECT pc.kind, pc.unit, pc.amount, pc.conditions
     FROM price_components pc
     WHERE pc.price_candidate_id = $1
     ORDER BY pc.kind`,
    [candidateId],
  )
  return res.rows.map((c) => ({
    kind: c.kind as PriceComponent['kind'],
    unit: c.unit,
    amount: c.amount,
    conditions: c.conditions ?? {},
  }))
}

/**
 * Approve a candidate: validate the lifecycle, record the approver, then
 * schedule or (if already due) activate it. Activation runs after this
 * transaction commits, so a failure leaves the candidate safely `scheduled`
 * for the job to retry.
 */
export async function approvePriceCandidate(input: ApprovePriceInput): Promise<ApprovePriceResult> {
  const actor = requireCapability(input.actor, 'pricing:approve')
  const now = new Date()
  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : now
  if (Number.isNaN(effectiveFrom.getTime())) throw new Error('approve: invalid effectiveFrom')
  const tenantId = input.tenantId ?? null

  const client = await pool.connect()
  let versionId: string | null = null
  let autoActivateBlocked = false
  let riskReasons: string[] = []
  try {
    await client.query('BEGIN')
    const candidate = await loadCandidate(client, input.candidateId)
    await assertCandidatePriceEvidence(client, candidate.id)

    // Normalize the queue state: a candidate may arrive here from `validated`
    // (e.g. a manual entry) or already be `pending_approval`.
    let status = candidate.status
    if (status === 'fetched') {
      assertTransition(status, 'validated')
      await transitionPriceCandidate({
        candidateId: candidate.id,
        to: 'validated',
        actorUserId: actor.userId ?? null,
        tenantId,
        reason: 'approval: pre-check',
        client,
      })
      status = 'validated'
    }
    if (status === 'validated') {
      assertTransition(status, 'pending_approval')
      await transitionPriceCandidate({
        candidateId: candidate.id,
        to: 'pending_approval',
        actorUserId: actor.userId ?? null,
        tenantId,
        reason: 'approval: submitted',
        client,
      })
      status = 'pending_approval'
    }
    assertTransition(status, 'scheduled')

    const serviceTier = await serviceTierForCandidate(client, candidate.id)
    const active = await activeVersionFor(client, candidate, serviceTier)
    const components = await candidateComponents(client, candidate.id)
    const guard = canAutoActivate(
      {
        provider: candidate.provider_id,
        modelId: candidate.upstream_model_id,
        modelIdMatched: true,
        currency: candidate.currency,
        components,
        isFreeModel: components.some((c) => (c.conditions as Record<string, unknown>)?.free === true),
      },
      active ? { id: active.id, currency: active.currency, components: active.components } : null,
    )
    autoActivateBlocked = !guard.ok
    riskReasons = [...new Set([...(candidate.risk_reasons ?? []), ...guard.reasons])]

    const version = await client.query<{ id: string }>(
      'SELECT price_version_id AS id FROM price_components WHERE price_candidate_id = $1 LIMIT 1',
      [candidate.id],
    )
    versionId = version.rows[0]?.id ?? null
    if (!versionId) throw new Error(`candidate ${candidate.id} has no price version payload`)

    await client.query(
      `UPDATE price_candidates
       SET approved_by = $2, approved_at = now(), effective_from = $3, high_risk_flag = $4, risk_reasons = $5::jsonb, updated_at = now()
       WHERE id = $1`,
      [candidate.id, actor.userId ?? null, effectiveFrom, autoActivateBlocked, JSON.stringify(riskReasons)],
    )
    await client.query(
      `UPDATE provider_price_versions SET status = 'approved', approved_by = $2, approved_at = now(), effective_from = $3 WHERE id = $1`,
      [versionId, actor.userId ?? null, effectiveFrom],
    )

    await transitionPriceCandidate({
      candidateId: candidate.id,
      to: 'scheduled',
      actorUserId: actor.userId ?? null,
      tenantId,
      reason: input.reason ?? 'approved',
      traceId: input.traceId,
      client,
    })

    await logAudit({
      actorUserId: actor.userId ?? null,
      tenantId,
      action: 'catalog.price_approved',
      targetType: 'price_candidate',
      targetId: candidate.id,
      metadata: {
        versionId,
        effectiveFrom: effectiveFrom.toISOString(),
        autoActivateBlocked,
        riskReasons,
        reason: input.reason ?? null,
      },
      ip: input.ip,
      traceId: input.traceId,
      client,
    })

    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  if (effectiveFrom.getTime() <= now.getTime()) {
    const outcome = await activateCandidate({
      candidateId: input.candidateId,
      now,
      actorUserId: actor.userId ?? null,
      tenantId,
    })
    if (outcome.activated) {
      return {
        candidateId: input.candidateId,
        status: 'active',
        versionId: outcome.versionId ?? versionId,
        effectiveFrom: effectiveFrom.toISOString(),
        autoActivateBlocked,
        riskReasons,
      }
    }
  }

  return {
    candidateId: input.candidateId,
    status: 'scheduled',
    versionId,
    effectiveFrom: effectiveFrom.toISOString(),
    autoActivateBlocked,
    riskReasons,
  }
}
