// Activation job: publish approved price versions and signed gateway snapshots.
//
// Activation is the ONLY path that can change what the gateway charges, and it
// runs in one transaction: close the old effective range, enable the new
// version, publish the catalog version + signed snapshot. History is
// append-only — an active row is superseded, never edited; rollback creates a
// NEW version rather than resurrecting an old one (ADR-0003, DYNAMIC spec
// §Approval and Activation).
//
// Time-range safety: activations for the same provider+model serialize on an
// advisory lock, and a candidate may not take effect at or before the start of
// the currently active version. Two concurrent activations therefore cannot
// produce overlapping effective ranges.

import { pool } from '@/db'
import { logAudit } from '@/lib/audit'
import { sha256hex } from '@/lib/crypto'
import { requireCapability, type Principal } from '@/lib/auth/capabilities'
import type { PoolClient } from 'pg'
import { componentAmount, type PriceComponent } from '@/lib/pricing/components'
import { insertSaleSnapshot } from './sale-snapshot'
import type { SaleRule } from '@/lib/pricing'
import {
  buildSnapshotPayload,
  signSnapshot,
  type GatewaySnapshotPayload,
  type SnapshotCatalogVersion,
  type SnapshotPriceVersion,
  type SnapshotRoutingPolicy,
} from './snapshot'
import { transitionPriceCandidate } from './lifecycle'
import { assertCandidatePriceEvidence, isPlaceholderPriceSource, PriceEvidenceError } from './evidence'

export class ActivationError extends Error {
  constructor(
    public code: 'not_found' | 'not_scheduled' | 'effective_range_conflict' | 'no_version' | 'invalid_rollback',
    message: string,
  ) {
    super(message)
    this.name = 'ActivationError'
  }
}

export interface CandidateRow {
  id: string
  provider_id: string
  upstream_model_id: string
  currency: string
  region: string
  status: string
  approved_by: string | null
  approved_at: Date | null
  effective_from: Date | null
  high_risk_flag: boolean
  risk_reasons: string[]
}

export interface ActivationOutcome {
  activated: boolean
  candidateId: string
  versionId?: string
  snapshotId?: string
  reason?: string
}

export interface ActivationJobResult {
  activated: string[]
  notDue: string[]
  failed: { candidateId: string; error: string }[]
}

async function loadCandidateForUpdate(client: PoolClient, candidateId: string): Promise<CandidateRow> {
  const res = await client.query<CandidateRow>(
    `SELECT id, provider_id, upstream_model_id, currency, region, status,
            approved_by, approved_at, effective_from, high_risk_flag, risk_reasons
     FROM price_candidates WHERE id = $1 FOR UPDATE`,
    [candidateId],
  )
  if (!res.rows.length) throw new ActivationError('not_found', `price candidate ${candidateId} not found`)
  return res.rows[0]
}

/** The candidate's monetary payload: its version id and the version's service tier. */
async function versionMetaForCandidate(
  client: PoolClient,
  candidateId: string,
): Promise<{ versionId: string; serviceTier: string }> {
  const res = await client.query<{ price_version_id: string; service_tier: string }>(
    `SELECT pc.price_version_id, v.service_tier
     FROM price_components pc JOIN provider_price_versions v ON v.id = pc.price_version_id
     WHERE pc.price_candidate_id = $1 LIMIT 1`,
    [candidateId],
  )
  if (!res.rows.length) throw new ActivationError('no_version', `candidate ${candidateId} has no price version payload`)
  return { versionId: res.rows[0].price_version_id, serviceTier: res.rows[0].service_tier }
}

async function publishCatalogVersion(
  client: PoolClient,
  tenantId: string | null,
  publishedBy: string | null,
): Promise<SnapshotCatalogVersion> {
  const next = await client.query<{ version: number }>(
    'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM catalog_versions WHERE tenant_id IS NOT DISTINCT FROM $1',
    [tenantId],
  )
  const version = next.rows[0].version
  const active = await client.query<{
    id: string
    upstream_model_id: string
    currency: string
    region: string
    source_url: string | null
  }>(
    `SELECT id, upstream_model_id, currency, region, source_url FROM provider_price_versions WHERE status = 'active' ORDER BY id`,
  )
  const payload = {
    schema_version: 1,
    price_versions: active.rows
      .filter((r) => !isPlaceholderPriceSource(r.source_url))
      .map((r) => ({
        id: r.id,
        model_id: r.upstream_model_id,
        currency: r.currency,
        region: r.region,
      })),
  }
  const checksum = sha256hex(JSON.stringify(payload))
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO catalog_versions (id, tenant_id, version, payload, checksum, published_by, published_at)
     VALUES (gen_random_uuid(), $1, $2, $3::jsonb, $4, $5, now())
     RETURNING id`,
    [tenantId, version, JSON.stringify(payload), checksum, publishedBy],
  )
  return { id: inserted.rows[0].id, version, checksum }
}

async function loadActivePriceVersions(client: PoolClient, tenantId: string | null): Promise<SnapshotPriceVersion[]> {
  const versions = await client.query<{
    id: string
    provider: string
    upstream_model_id: string
    currency: string
    region: string
    service_tier: string
    unit: string
    provider_id: string
    effective_from: Date | null
    effective_to: Date | null
    source_url: string | null
  }>(
    `SELECT v.id, p.code AS provider, v.upstream_model_id, v.currency, v.region, v.service_tier, v.unit,
            v.provider_id, v.effective_from, v.effective_to, v.source_url
     FROM provider_price_versions v JOIN providers p ON p.id = v.provider_id
     WHERE v.status = 'active'
     ORDER BY p.code, v.upstream_model_id, v.region, v.service_tier`,
  )
  const out: SnapshotPriceVersion[] = []
  for (const v of versions.rows) {
    // Preserve historical seed versions but never publish them as chargeable evidence.
    if (isPlaceholderPriceSource(v.source_url)) continue
    const comps = await client.query<{
      kind: string
      unit: string
      amount: string
      conditions: Record<string, unknown>
    }>('SELECT kind, unit, amount, conditions FROM price_components WHERE price_version_id = $1 ORDER BY kind', [v.id])
    const components: PriceComponent[] = comps.rows.map((c) => ({
      kind: c.kind as PriceComponent['kind'],
      unit: c.unit,
      amount: c.amount,
      conditions: c.conditions ?? {},
    }))

    // INVARIANT #4: freeze the sale rates for this price version so the gateway
    // can pin them on request_records and settle can recompute identically.
    const { saleSnapshotId, exchangeRateSnapshotId } = await ensureSaleSnapshot(
      client,
      v.provider_id,
      v.id,
      v.upstream_model_id,
      v.currency,
      components,
      tenantId,
    )

    out.push({
      id: v.id,
      provider: v.provider,
      model_id: v.upstream_model_id,
      currency: v.currency,
      region: v.region,
      service_tier: v.service_tier,
      unit: v.unit,
      effective_from: v.effective_from ? v.effective_from.toISOString() : null,
      effective_to: v.effective_to ? v.effective_to.toISOString() : null,
      components,
      sale_price_snapshot_id: saleSnapshotId,
      exchange_rate_snapshot_id: exchangeRateSnapshotId,
    })
  }
  return out
}

/**
 * Resolve the active sale_price_rule and latest exchange_rate for a price
 * version, create a sale_price_snapshots row, and return its id.
 *
 * If no rule exists, no snapshot is created and the ids are null — the gateway
 * will refuse to bill a request without a sale snapshot (INVARIANT #4).
 */
async function ensureSaleSnapshot(
  client: PoolClient,
  providerId: string,
  priceVersionId: string,
  modelId: string,
  providerCurrency: string,
  components: PriceComponent[],
  tenantId: string | null,
): Promise<{ saleSnapshotId: string | null; exchangeRateSnapshotId: string | null }> {
  const rule = await loadSaleRuleForSnapshot(client, providerId, modelId, tenantId)
  if (!rule) return { saleSnapshotId: null, exchangeRateSnapshotId: null }

  // Find the latest exchange rate if the provider and sale currencies differ.
  let exchangeRateSnapshotId: string | null = null
  let exchangeRate = null
  if (providerCurrency !== rule.saleRule.currency) {
    const fx = await client.query<{ id: string; base_currency: string; quote_currency: string; rate: string }>(
      `SELECT id, base_currency, quote_currency, rate FROM exchange_rate_snapshots
        WHERE base_currency = $1 AND quote_currency = $2
        ORDER BY fetched_at DESC LIMIT 1`,
      [providerCurrency, rule.saleRule.currency],
    )
    if (fx.rows.length) {
      exchangeRateSnapshotId = fx.rows[0].id
      exchangeRate = { base: fx.rows[0].base_currency, quote: fx.rows[0].quote_currency, rate: fx.rows[0].rate }
    }
  }

  const snapshot = await insertSaleSnapshot(client, {
    ruleId: rule.id,
    providerPriceVersionId: priceVersionId,
    components,
    providerCurrency,
    rule: rule.saleRule,
    exchangeRate,
    exchangeRateSnapshotId,
  })
  return { saleSnapshotId: snapshot.id, exchangeRateSnapshotId }
}

interface SaleRuleRow {
  id: string
  saleRule: SaleRule
}

async function loadSaleRuleForSnapshot(
  client: PoolClient,
  providerId: string,
  modelId: string,
  tenantId: string | null,
): Promise<SaleRuleRow | null> {
  const result = await client.query<{
    id: string
    pricing_mode: SaleRule['pricingMode']
    markup_rate: string
    target_margin_rate: string
    fixed_fee: string
    minimum_charge: string
    currency: string
  }>(
    `SELECT id, pricing_mode, markup_rate, target_margin_rate, fixed_fee, minimum_charge, currency
     FROM sale_price_rules
     WHERE provider_id = $1 AND upstream_model_id = $2 AND enabled = true
       AND (tenant_id = $3 OR tenant_id IS NULL)
       AND (effective_to IS NULL OR effective_to > now())
     ORDER BY (tenant_id = $3) DESC, effective_from DESC
     LIMIT 1`,
    [providerId, modelId, tenantId],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    id: row.id,
    saleRule: {
      pricingMode: row.pricing_mode,
      markupRate: row.markup_rate,
      targetMarginRate: row.target_margin_rate,
      fixedFee: row.fixed_fee,
      minimumCharge: row.minimum_charge,
      currency: row.currency,
    },
  }
}

async function loadPublishedRoutingPolicies(
  client: PoolClient,
  tenantId: string | null,
): Promise<SnapshotRoutingPolicy[]> {
  const res = await client.query<{
    id: string
    version: number
    checksum: string
    credential_mode: string
    model_routes: { modelId: string; weight: number; priority?: number }[]
  }>(
    `SELECT pv.id, pv.version, pv.checksum, pv.credential_mode, pv.model_routes
     FROM policy_versions pv JOIN routing_policies rp ON rp.id = pv.routing_policy_id
     WHERE pv.published_at IS NOT NULL AND rp.enabled = true AND rp.tenant_id IS NOT DISTINCT FROM $1
     ORDER BY pv.version DESC`,
    [tenantId],
  )
  return res.rows.map((r) => ({
    id: r.id,
    version: r.version,
    checksum: r.checksum,
    credential_mode: r.credential_mode,
    model_routes: r.model_routes ?? [],
  }))
}

/** Build, sign and store a snapshot covering all active price versions. */
export async function publishSnapshot(
  client: PoolClient,
  input: {
    tenantId: string | null
    catalogVersion: SnapshotCatalogVersion | null
    publishedBy: string | null
    now?: Date
  },
): Promise<{ id: string; payload: GatewaySnapshotPayload; signature: string; signingKeyId: string }> {
  const seqRes = await client.query<{ seq: string }>(
    'SELECT COALESCE(MAX(sequence_number), 0) + 1 AS seq FROM gateway_snapshots WHERE tenant_id IS NOT DISTINCT FROM $1',
    [input.tenantId],
  )
  const sequenceNumber = Number(seqRes.rows[0].seq)
  const policies = await loadPublishedRoutingPolicies(client, input.tenantId)
  const payload = buildSnapshotPayload({
    tenantId: input.tenantId,
    sequenceNumber,
    catalogVersion: input.catalogVersion,
    priceVersions: await loadActivePriceVersions(client, input.tenantId),
    routingPolicies: policies,
    generatedAt: input.now,
  })
  const signed = signSnapshot(payload)
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO gateway_snapshots
       (id, tenant_id, policy_version_id, sequence_number, signature, signing_key_id, payload, effective_from)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING id`,
    [
      input.tenantId,
      policies[0]?.id ?? null,
      String(sequenceNumber),
      signed.signature,
      signed.signingKeyId,
      JSON.stringify(payload),
      payload.generated_at,
    ],
  )
  return { id: inserted.rows[0].id, payload, signature: signed.signature, signingKeyId: signed.signingKeyId }
}

/**
 * Close the current active range and enable the candidate's version, then
 * publish catalog + snapshot. Caller owns the transaction.
 */
async function activateWithinTx(
  client: PoolClient,
  candidate: CandidateRow,
  opts: { now: Date; actorUserId: string | null; tenantId: string | null },
): Promise<{ versionId: string; snapshotId: string }> {
  const effectiveFrom = candidate.effective_from ?? opts.now
  if (effectiveFrom.getTime() > opts.now.getTime()) {
    throw new ActivationError(
      'not_scheduled',
      `candidate ${candidate.id} is not due until ${effectiveFrom.toISOString()}`,
    )
  }

  const meta = await versionMetaForCandidate(client, candidate.id)
  const serviceTier = meta.serviceTier

  // Serialize activations for this model.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `catalog:activate:${candidate.provider_id}:${candidate.upstream_model_id}:${candidate.region}:${serviceTier}`,
  ])

  const current = await client.query<{ id: string; effective_from: Date | null }>(
    `SELECT id, effective_from FROM provider_price_versions
     WHERE provider_id = $1 AND upstream_model_id = $2 AND region = $3 AND service_tier = $4 AND status = 'active'
     FOR UPDATE`,
    [candidate.provider_id, candidate.upstream_model_id, candidate.region, serviceTier],
  )

  if (current.rows.length) {
    const activeFrom = current.rows[0].effective_from
    // A backdated activation would overlap an already-published range.
    if (activeFrom && activeFrom.getTime() >= effectiveFrom.getTime()) {
      throw new ActivationError(
        'effective_range_conflict',
        `effective_from ${effectiveFrom.toISOString()} overlaps active range starting ${activeFrom.toISOString()}`,
      )
    }
    // History is append-only: close the range, never edit its price.
    await client.query(`UPDATE provider_price_versions SET status = 'superseded', effective_to = $2 WHERE id = $1`, [
      current.rows[0].id,
      effectiveFrom,
    ])
  }

  const versionId = meta.versionId
  await client.query(
    `UPDATE provider_price_versions
     SET status = 'active', effective_from = $2, effective_to = NULL, approved_by = $3, approved_at = $4
     WHERE id = $1`,
    [versionId, effectiveFrom, candidate.approved_by, candidate.approved_at],
  )

  // Lifecycle transition (scheduled → active) with audit, in this transaction.
  await client.query('UPDATE price_candidates SET effective_to = NULL, updated_at = now() WHERE id = $1', [
    candidate.id,
  ])
  await transitionPriceCandidate({
    candidateId: candidate.id,
    to: 'active',
    actorUserId: opts.actorUserId,
    tenantId: opts.tenantId,
    reason: 'activation job',
    client,
  })

  const catalogVersion = await publishCatalogVersion(client, opts.tenantId, opts.actorUserId)
  const snapshot = await publishSnapshot(client, {
    tenantId: opts.tenantId,
    catalogVersion,
    publishedBy: opts.actorUserId,
    now: opts.now,
  })

  await logAudit({
    actorUserId: opts.actorUserId,
    tenantId: opts.tenantId,
    action: 'catalog.price_activated',
    targetType: 'price_candidate',
    targetId: candidate.id,
    metadata: {
      versionId,
      snapshotId: snapshot.id,
      catalogVersionId: catalogVersion.id,
      effectiveFrom: effectiveFrom.toISOString(),
      highRisk: candidate.high_risk_flag,
      riskReasons: candidate.risk_reasons ?? [],
    },
    client,
  })

  return { versionId, snapshotId: snapshot.id }
}

export interface ActivateCandidateInput {
  candidateId: string
  now?: Date
  actorUserId?: string | null
  tenantId?: string | null
}

/** Activate one scheduled candidate. Idempotent: a candidate that is not due
 *  is reported as such and leaves no state change. */
export async function activateCandidate(input: ActivateCandidateInput): Promise<ActivationOutcome> {
  const now = input.now ?? new Date()
  const tenantId = input.tenantId ?? null
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const candidate = await loadCandidateForUpdate(client, input.candidateId)
    await assertCandidatePriceEvidence(client, candidate.id)
    if (candidate.status !== 'scheduled') {
      await client.query('ROLLBACK')
      return { activated: false, candidateId: input.candidateId, reason: `status is ${candidate.status}` }
    }
    if (candidate.effective_from && candidate.effective_from.getTime() > now.getTime()) {
      await client.query('ROLLBACK')
      return { activated: false, candidateId: input.candidateId, reason: 'not_due' }
    }
    const { versionId, snapshotId } = await activateWithinTx(client, candidate, {
      now,
      actorUserId: input.actorUserId ?? null,
      tenantId,
    })
    await client.query('COMMIT')
    return { activated: true, candidateId: input.candidateId, versionId, snapshotId }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** Activate every scheduled candidate whose effective time has arrived. */
export async function runActivationJob(
  input: { now?: Date; actorUserId?: string | null; tenantId?: string | null; limit?: number } = {},
): Promise<ActivationJobResult> {
  const now = input.now ?? new Date()
  const limit = input.limit ?? 100
  const due = await pool.query<{ id: string }>(
    `SELECT id FROM price_candidates
     WHERE status = 'scheduled' AND effective_from IS NOT NULL AND effective_from <= $1
     ORDER BY effective_from ASC LIMIT $2`,
    [now, limit],
  )
  const result: ActivationJobResult = { activated: [], notDue: [], failed: [] }
  for (const row of due.rows) {
    try {
      const outcome = await activateCandidate({
        candidateId: row.id,
        now,
        actorUserId: input.actorUserId ?? null,
        tenantId: input.tenantId ?? null,
      })
      if (outcome.activated) result.activated.push(row.id)
      else result.notDue.push(row.id)
    } catch (e) {
      result.failed.push({ candidateId: row.id, error: e instanceof Error ? e.message : 'activation failed' })
    }
  }
  return result
}

// ── Emergency rollback ─────────────────────────────────────────────────

export interface EmergencyRollbackInput {
  providerId: string
  modelId: string
  /** The historical version to restore. It is read, never modified. */
  targetPriceVersionId: string
  actor: Principal | null
  reason: string
  region?: string
  serviceTier?: string
  effectiveFrom?: Date
  tenantId?: string | null
}

export interface EmergencyRollbackResult {
  candidateId: string
  versionId: string
  snapshotId: string
  restoredFrom: string
}

/**
 * Emergency rollback: restore a past price by creating a NEW version that
 * copies it. The historical row is never reactivated or edited, so the audit
 * trail of what was charged when stays intact.
 */
export async function emergencyRollback(input: EmergencyRollbackInput): Promise<EmergencyRollbackResult> {
  const actor = requireCapability(input.actor, 'pricing:approve')
  const now = new Date()
  const effectiveFrom = input.effectiveFrom ?? now
  const tenantId = input.tenantId ?? actor.tenantId ?? null
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const target = await client.query<{
      id: string
      provider_id: string
      upstream_model_id: string
      currency: string
      region: string
      service_tier: string
      unit: string
      source_type: string
      source_url: string | null
      source_document_hash: string | null
      status: string
    }>(
      `SELECT id, provider_id, upstream_model_id, currency, region, service_tier, unit,
              source_type, source_url, source_document_hash, status
       FROM provider_price_versions WHERE id = $1`,
      [input.targetPriceVersionId],
    )
    if (!target.rows.length) throw new ActivationError('not_found', 'rollback target version not found')
    const source = target.rows[0]
    if (isPlaceholderPriceSource(source.source_url)) throw new PriceEvidenceError()
    if (source.status === 'rejected') {
      throw new ActivationError('invalid_rollback', 'cannot roll back to a rejected version')
    }
    if (source.provider_id !== input.providerId || source.upstream_model_id !== input.modelId) {
      throw new ActivationError('invalid_rollback', 'rollback target does not belong to this provider/model')
    }

    const comps = await client.query<{
      kind: string
      unit: string
      amount: string
      conditions: Record<string, unknown>
    }>('SELECT kind, unit, amount, conditions FROM price_components WHERE price_version_id = $1 ORDER BY kind', [
      source.id,
    ])
    if (!comps.rows.length) throw new ActivationError('invalid_rollback', 'rollback target has no components')
    const components: PriceComponent[] = comps.rows.map((c) => ({
      kind: c.kind as PriceComponent['kind'],
      unit: c.unit,
      amount: c.amount,
      conditions: c.conditions ?? {},
    }))

    const region = input.region ?? source.region
    const serviceTier = input.serviceTier ?? source.service_tier

    // Same lock key as normal activation: a rollback and an activation for the
    // same model must never interleave and produce overlapping ranges.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `catalog:activate:${input.providerId}:${input.modelId}:${region}:${serviceTier}`,
    ])

    // A new candidate, approved by the rollback actor (this IS the manual path).
    const candidateRes = await client.query<{ id: string }>(
      `INSERT INTO price_candidates
         (id, provider_id, upstream_model_id, currency, region, status, high_risk_flag, risk_reasons,
          approved_by, approved_at, effective_from)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'pending_approval', true, $5::jsonb, $6, now(), $7)
       RETURNING id`,
      [
        input.providerId,
        input.modelId,
        source.currency,
        region,
        JSON.stringify(['emergency_rollback']),
        actor.userId ?? null,
        effectiveFrom,
      ],
    )
    const candidateId = candidateRes.rows[0].id

    const versionRes = await client.query<{ id: string }>(
      `INSERT INTO provider_price_versions
         (id, provider_id, upstream_model_id, currency, region, service_tier, input_price, cached_input_price,
          cache_write_price, output_price, reasoning_price, request_price, tool_price, image_price, audio_price,
          unit, source_type, source_url, source_document_hash, fetched_at, effective_from, effective_to, status,
          approved_by, approved_at, raw_source_data)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, '0', $8, $9, $10, '0', $11, $12,
               $13, $14, $15, $16, now(), $17, NULL, 'pending', $18, now(), $19::jsonb)
       RETURNING id`,
      [
        input.providerId,
        input.modelId,
        source.currency,
        region,
        serviceTier,
        componentAmount(components, 'input'),
        componentAmount(components, 'cached_input'),
        componentAmount(components, 'output'),
        componentAmount(components, 'reasoning'),
        componentAmount(components, 'request'),
        componentAmount(components, 'image'),
        componentAmount(components, 'audio'),
        source.unit,
        source.source_type,
        source.source_url,
        source.source_document_hash,
        effectiveFrom,
        actor.userId ?? null,
        JSON.stringify({ rollbackOf: source.id, reason: input.reason }),
      ],
    )
    const versionId = versionRes.rows[0].id

    for (const component of components) {
      await client.query(
        `INSERT INTO price_components (id, price_version_id, price_candidate_id, kind, unit, amount, conditions)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb)`,
        [
          versionId,
          candidateId,
          component.kind,
          component.unit,
          component.amount,
          JSON.stringify(component.conditions ?? {}),
        ],
      )
    }

    // Approve + schedule, then run the normal activation path (which closes the
    // current range and publishes a fresh snapshot).
    await client.query(`UPDATE provider_price_versions SET status = 'approved' WHERE id = $1`, [versionId])
    await transitionPriceCandidate({
      candidateId,
      to: 'scheduled',
      actorUserId: actor.userId ?? null,
      tenantId,
      reason: `emergency rollback: ${input.reason}`,
      client,
    })
    const candidate = await loadCandidateForUpdate(client, candidateId)
    const activated = await activateWithinTx(client, candidate, {
      now,
      actorUserId: actor.userId ?? null,
      tenantId,
    })
    await logAudit({
      actorUserId: actor.userId ?? null,
      tenantId,
      action: 'catalog.price_rolled_back',
      targetType: 'price_version',
      targetId: source.id,
      metadata: { restoredAsVersionId: versionId, candidateId, reason: input.reason },
      client,
    })
    await client.query('COMMIT')
    return { candidateId, versionId, snapshotId: activated.snapshotId, restoredFrom: source.id }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
