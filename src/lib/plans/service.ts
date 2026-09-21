// Versioned plans, entitlements and subscriptions (Work Item G).
//
// PRODUCT_COMMERCIAL.md is binding here:
//   - plan limits live in plan_versions + entitlements and are published; a UI
//     must read them through this module and never hardcode a limit.
//   - a subscription binds a plan VERSION, so an old invoice can be reproduced.
//   - a published plan version is immutable; changing a price/limit creates a
//     new version.
//   - upgrades/downgrades take effect at an explicit effective time: the new
//     subscription row starts at T and the previous row is closed at T, so
//     "entitlements as of T" is deterministic.
//
// Entitlement lookup is fail-closed: no active subscription ⇒ no entitlements,
// and requireEntitlement() denies with 403.

import { pool } from '@/db'
import type { Micros } from '@/lib/money'
import type { PoolClient } from 'pg'
import type { Queryable } from '@/lib/billing/pipeline'

// ── Entitlement keys ──────────────────────────────────────────────────
// Named capabilities a plan version can grant. Kept as constants so callers do
// not scatter string literals; the UI reads the published values via the API.
export const ENTITLEMENT_KEYS = {
  members: 'members',
  apiKeys: 'api_keys',
  byokChannels: 'byok_channels',
  auditRetentionDays: 'audit_retention_days',
  advancedRouting: 'advanced_routing',
  managedCredits: 'managed_credits',
} as const

export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[keyof typeof ENTITLEMENT_KEYS]

export type PlanErrorCode =
  | 'plan_not_found'
  | 'plan_version_not_found'
  | 'plan_version_not_published'
  | 'duplicate_plan_code'
  | 'entitlement_missing'
  | 'effective_time_in_past'
  | 'invalid_input'

export class PlanError extends Error {
  readonly status: number
  readonly code: PlanErrorCode

  constructor(code: PlanErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'PlanError'
    this.code = code
    this.status = status ?? (code === 'entitlement_missing' ? 403 : code === 'plan_not_found' ? 404 : 400)
  }
}

// ── Records ───────────────────────────────────────────────────────────

export interface PlanRecord {
  id: string
  code: string
  name: string
  description: string | null
  tier: string
  status: string
}

export interface PlanVersionRecord {
  id: string
  planId: string
  planCode: string
  version: number
  status: string
  currency: string
  priceMicros: Micros
  billingInterval: string
  includedCreditsMicros: Micros
  trialDays: number
  effectiveFrom: Date | null
  effectiveTo: Date | null
  publishedAt: Date | null
}

export interface EntitlementRecord {
  id: string
  planVersionId: string
  key: string
  kind: 'boolean' | 'limit'
  limitValue: Micros | null
  booleanValue: boolean | null
  description: string | null
}

export interface SubscriptionRecord {
  id: string
  tenantId: string
  organizationId: string | null
  planVersionId: string
  planCode: string
  planVersion: number
  status: string
  effectiveFrom: Date
  effectiveTo: Date | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
}

export interface PublishPlanVersionInput {
  planId: string
  currency?: string
  priceMicros: Micros
  billingInterval?: 'month' | 'year'
  includedCreditsMicros?: Micros
  trialDays?: number
  entitlements?: {
    key: string
    kind?: 'boolean' | 'limit'
    limitValue?: Micros | null
    booleanValue?: boolean | null
    description?: string
  }[]
  publishedBy?: string | null
}

// ── Plan / version lifecycle ──────────────────────────────────────────

export async function createPlan(
  input: { code: string; name: string; description?: string; tier?: string },
  client?: PoolClient,
): Promise<PlanRecord> {
  const query: Queryable = client ?? pool
  const code = input.code.trim()
  if (!code) throw new PlanError('invalid_input', 'plan code is required')
  const existing = await query.query<{ id: string }>(`SELECT id FROM plans WHERE code = $1 LIMIT 1`, [code])
  if (existing.rows.length) {
    throw new PlanError('duplicate_plan_code', `plan code '${code}' already exists`, 409)
  }
  const result = await query.query<{
    id: string
    code: string
    name: string
    description: string | null
    tier: string
    status: string
  }>(
    `INSERT INTO plans (id, code, name, description, tier, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active')
     RETURNING id, code, name, description, tier, status`,
    [code, input.name.trim(), input.description ?? null, input.tier ?? 'team'],
  )
  return result.rows[0]
}

/**
 * Publish a new immutable version of a plan. The version number is allocated
 * from the current maximum inside the transaction, so concurrent publishes
 * cannot collide (the unique (plan_id, version) index is the backstop).
 */
export async function publishPlanVersion(
  input: PublishPlanVersionInput,
  client?: PoolClient,
): Promise<PlanVersionRecord> {
  if (input.priceMicros < 0n || (input.includedCreditsMicros ?? 0n) < 0n) {
    throw new PlanError('invalid_input', 'price and included credits must not be negative')
  }
  if (client) return publishOnClient(client, input)
  const conn = await pool.connect()
  try {
    await conn.query('BEGIN')
    const record = await publishOnClient(conn, input)
    await conn.query('COMMIT')
    return record
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    conn.release()
  }
}

async function publishOnClient(client: PoolClient, input: PublishPlanVersionInput): Promise<PlanVersionRecord> {
  // Serialize version allocation per plan.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`plan:${input.planId}`])
  const plan = await client.query<{ id: string; code: string }>(`SELECT id, code FROM plans WHERE id = $1 LIMIT 1`, [
    input.planId,
  ])
  if (!plan.rows.length) throw new PlanError('plan_not_found', `plan ${input.planId} not found`, 404)

  const next = await client.query<{ version: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM plan_versions WHERE plan_id = $1`,
    [input.planId],
  )
  const version = next.rows[0].version
  const inserted = await client.query<{
    id: string
    plan_id: string
    version: number
    status: string
    currency: string
    price_micros: string
    billing_interval: string
    included_credits_micros: string
    trial_days: number
    effective_from: Date | null
    effective_to: Date | null
    published_at: Date | null
  }>(
    `INSERT INTO plan_versions (id, plan_id, version, status, currency, price_micros, billing_interval,
                                included_credits_micros, trial_days, effective_from, published_at, published_by)
     VALUES (gen_random_uuid(), $1, $2, 'published', $3, $4, $5, $6, $7, now(), now(), $8)
     RETURNING id, plan_id, version, status, currency, price_micros, billing_interval,
               included_credits_micros, trial_days, effective_from, effective_to, published_at`,
    [
      input.planId,
      version,
      input.currency ?? 'USD',
      input.priceMicros.toString(),
      input.billingInterval ?? 'month',
      (input.includedCreditsMicros ?? 0n).toString(),
      input.trialDays ?? 0,
      input.publishedBy ?? null,
    ],
  )
  const row = inserted.rows[0]

  for (const ent of input.entitlements ?? []) {
    const kind = ent.kind ?? 'limit'
    if (kind === 'limit' && (ent.limitValue === undefined || ent.limitValue === null)) {
      throw new PlanError('invalid_input', `entitlement '${ent.key}' of kind limit needs a limitValue`)
    }
    if (kind === 'boolean' && ent.booleanValue === undefined) {
      throw new PlanError('invalid_input', `entitlement '${ent.key}' of kind boolean needs a booleanValue`)
    }
    await client.query(
      `INSERT INTO entitlements (id, plan_version_id, key, kind, limit_value, boolean_value, description)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
      [
        row.id,
        ent.key,
        kind,
        ent.limitValue === undefined || ent.limitValue === null ? null : ent.limitValue.toString(),
        ent.booleanValue ?? null,
        ent.description ?? null,
      ],
    )
  }

  return toPlanVersionRecord(row, plan.rows[0].code)
}

/** Published plan versions, for the pricing page / console. Never hardcoded. */
export async function listPublishedPlanVersions(planCode?: string, client?: PoolClient): Promise<PlanVersionRecord[]> {
  const query: Queryable = client ?? pool
  const params: string[] = []
  let filter = ''
  if (planCode) {
    params.push(planCode)
    filter = `AND p.code = $${params.length}`
  }
  const result = await query.query<PlanVersionRowWithCode>(
    `SELECT pv.id, pv.plan_id, p.code, pv.version, pv.status, pv.currency, pv.price_micros,
            pv.billing_interval, pv.included_credits_micros, pv.trial_days,
            pv.effective_from, pv.effective_to, pv.published_at
       FROM plan_versions pv
       JOIN plans p ON p.id = pv.plan_id
      WHERE pv.status = 'published' ${filter}
      ORDER BY p.code ASC, pv.version DESC`,
    params,
  )
  return result.rows.map((r) => toPlanVersionRecord(r, r.code))
}

export async function getPlanVersion(planVersionId: string, client?: PoolClient): Promise<PlanVersionRecord | null> {
  const query: Queryable = client ?? pool
  const result = await query.query<PlanVersionRowWithCode>(
    `SELECT pv.id, pv.plan_id, p.code, pv.version, pv.status, pv.currency, pv.price_micros,
            pv.billing_interval, pv.included_credits_micros, pv.trial_days,
            pv.effective_from, pv.effective_to, pv.published_at
       FROM plan_versions pv
       JOIN plans p ON p.id = pv.plan_id
      WHERE pv.id = $1
      LIMIT 1`,
    [planVersionId],
  )
  const row = result.rows[0]
  return row ? toPlanVersionRecord(row, row.code) : null
}

/** Entitlements attached to one plan version (used by the version detail API). */
export async function listEntitlements(planVersionId: string, client?: PoolClient): Promise<EntitlementRecord[]> {
  const query: Queryable = client ?? pool
  const result = await query.query<EntitlementRow>(
    `SELECT id, plan_version_id, key, kind, limit_value, boolean_value, description
       FROM entitlements WHERE plan_version_id = $1 ORDER BY key ASC`,
    [planVersionId],
  )
  return result.rows.map(toEntitlementRecord)
}

// ── Subscriptions & entitlement resolution ────────────────────────────

/**
 * The subscription in force for a tenant at time T. Overlapping ranges are
 * prevented by scheduleSubscriptionChange; a later effective_from wins.
 */
export async function getActiveSubscription(
  tenantId: string,
  at: Date = new Date(),
  client?: PoolClient,
): Promise<SubscriptionRecord | null> {
  const query: Queryable = client ?? pool
  const result = await query.query<SubscriptionRow>(
    `SELECT s.id, s.tenant_id, s.organization_id, s.plan_version_id, p.code AS plan_code,
            pv.version AS plan_version, s.status, s.effective_from, s.effective_to,
            s.current_period_end, s.cancel_at_period_end
       FROM subscriptions s
       JOIN plan_versions pv ON pv.id = s.plan_version_id
       JOIN plans p ON p.id = pv.plan_id
      WHERE s.tenant_id = $1
        AND s.status IN ('trialing', 'active', 'past_due')
        AND s.effective_from <= $2
        AND (s.effective_to IS NULL OR s.effective_to > $2)
      ORDER BY s.effective_from DESC, s.created_at DESC
      LIMIT 1`,
    [tenantId, at],
  )
  const row = result.rows[0]
  return row ? toSubscriptionRecord(row) : null
}

/** Entitlements the tenant holds at time T, resolved through its subscription. */
export async function getEntitlements(
  tenantId: string,
  at: Date = new Date(),
  client?: PoolClient,
): Promise<EntitlementRecord[]> {
  const sub = await getActiveSubscription(tenantId, at, client)
  if (!sub) return []
  return listEntitlements(sub.planVersionId, client)
}

export async function getEntitlement(
  tenantId: string,
  key: string,
  at: Date = new Date(),
  client?: PoolClient,
): Promise<EntitlementRecord | null> {
  const list = await getEntitlements(tenantId, at, client)
  return list.find((e) => e.key === key) ?? null
}

/**
 * Deny-by-default entitlement check. No active subscription, or a plan that
 * does not grant the key, is a 403 — never an implicit allow.
 */
export async function requireEntitlement(
  tenantId: string,
  key: string,
  at: Date = new Date(),
  client?: PoolClient,
): Promise<EntitlementRecord> {
  const ent = await getEntitlement(tenantId, key, at, client)
  if (!ent) {
    throw new PlanError('entitlement_missing', `tenant is not entitled to '${key}'`, 403)
  }
  return ent
}

export interface ScheduleSubscriptionInput {
  tenantId: string
  organizationId?: string | null
  planVersionId: string
  /** When the change takes effect. Must not be in the past beyond clock skew. */
  effectiveFrom: Date
  status?: 'trialing' | 'active' | 'past_due'
  currentPeriodEnd?: Date | null
  createdBy?: string | null
}

/**
 * Schedule an upgrade/downgrade. The previous open subscription is closed at
 * exactly `effectiveFrom` and a new row begins there, so a lookup "as of T" is
 * unambiguous and a future change does not affect today's entitlements.
 */
export async function scheduleSubscriptionChange(
  input: ScheduleSubscriptionInput,
  client?: PoolClient,
): Promise<SubscriptionRecord> {
  const skewMs = 60_000
  if (input.effectiveFrom.getTime() < Date.now() - skewMs) {
    throw new PlanError('effective_time_in_past', 'subscription effective time must not be in the past')
  }
  const version = await getPlanVersion(input.planVersionId, client)
  if (!version) throw new PlanError('plan_version_not_found', `plan version ${input.planVersionId} not found`, 404)
  if (version.status !== 'published') {
    throw new PlanError('plan_version_not_published', `plan version ${input.planVersionId} is not published`)
  }

  if (client) return scheduleOnClient(client, input, version)
  const conn = await pool.connect()
  try {
    await conn.query('BEGIN')
    const record = await scheduleOnClient(conn, input, version)
    await conn.query('COMMIT')
    return record
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    conn.release()
  }
}

async function scheduleOnClient(
  client: PoolClient,
  input: ScheduleSubscriptionInput,
  version: PlanVersionRecord,
): Promise<SubscriptionRecord> {
  // Serialize subscription changes per tenant.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`subscriptions:${input.tenantId}`])

  const existing = await client.query<SubscriptionRow>(
    `SELECT s.id, s.tenant_id, s.organization_id, s.plan_version_id, p.code AS plan_code,
            pv.version AS plan_version, s.status, s.effective_from, s.effective_to,
            s.current_period_end, s.cancel_at_period_end
       FROM subscriptions s
       JOIN plan_versions pv ON pv.id = s.plan_version_id
       JOIN plans p ON p.id = pv.plan_id
      WHERE s.tenant_id = $1 AND s.plan_version_id = $2 AND s.effective_from = $3
      LIMIT 1`,
    [input.tenantId, input.planVersionId, input.effectiveFrom],
  )
  if (existing.rows.length) return toSubscriptionRecord(existing.rows[0])

  await client.query(
    `UPDATE subscriptions
        SET effective_to = $2, updated_at = now()
      WHERE tenant_id = $1
        AND status IN ('trialing', 'active', 'past_due')
        AND effective_from < $2
        AND (effective_to IS NULL OR effective_to > $2)`,
    [input.tenantId, input.effectiveFrom],
  )

  const inserted = await client.query<SubscriptionRow>(
    `INSERT INTO subscriptions (id, tenant_id, organization_id, plan_version_id, status,
                                effective_from, current_period_end, created_by)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
     RETURNING id, tenant_id, organization_id, plan_version_id, status, effective_from, effective_to,
               current_period_end, cancel_at_period_end`,
    [
      input.tenantId,
      input.organizationId ?? null,
      input.planVersionId,
      input.status ?? 'active',
      input.effectiveFrom,
      input.currentPeriodEnd ?? null,
      input.createdBy ?? null,
    ],
  )
  const row = inserted.rows[0]
  return toSubscriptionRecord({ ...row, plan_code: version.planCode, plan_version: version.version })
}

/** Interval → default period end (used when a paid order activates a plan). */
export function periodEndFor(interval: string, from: Date): Date {
  const end = new Date(from)
  if (interval === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1)
  else end.setUTCMonth(end.getUTCMonth() + 1)
  return end
}

// ── Row mapping ───────────────────────────────────────────────────────

interface PlanVersionRowBase {
  id: string
  plan_id: string
  version: number
  status: string
  currency: string
  price_micros: string
  billing_interval: string
  included_credits_micros: string
  trial_days: number
  effective_from: Date | null
  effective_to: Date | null
  published_at: Date | null
}

interface PlanVersionRowWithCode extends PlanVersionRowBase {
  code: string
}

interface EntitlementRow {
  id: string
  plan_version_id: string
  key: string
  kind: 'boolean' | 'limit'
  limit_value: string | null
  boolean_value: boolean | null
  description: string | null
}

interface SubscriptionRow {
  id: string
  tenant_id: string
  organization_id: string | null
  plan_version_id: string
  plan_code?: string
  plan_version?: number
  status: string
  effective_from: Date
  effective_to: Date | null
  current_period_end: Date | null
  cancel_at_period_end: boolean
}

function toPlanVersionRecord(r: PlanVersionRowBase, planCode: string): PlanVersionRecord {
  return {
    id: r.id,
    planId: r.plan_id,
    planCode,
    version: r.version,
    status: r.status,
    currency: r.currency,
    priceMicros: BigInt(r.price_micros),
    billingInterval: r.billing_interval,
    includedCreditsMicros: BigInt(r.included_credits_micros),
    trialDays: r.trial_days,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    publishedAt: r.published_at,
  }
}

export function toEntitlementRecord(r: EntitlementRow): EntitlementRecord {
  return {
    id: r.id,
    planVersionId: r.plan_version_id,
    key: r.key,
    kind: r.kind,
    limitValue: r.limit_value === null ? null : BigInt(r.limit_value),
    booleanValue: r.boolean_value,
    description: r.description,
  }
}

function toSubscriptionRecord(r: SubscriptionRow): SubscriptionRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    organizationId: r.organization_id,
    planVersionId: r.plan_version_id,
    planCode: r.plan_code ?? '',
    planVersion: r.plan_version ?? 0,
    status: r.status,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    currentPeriodEnd: r.current_period_end,
    cancelAtPeriodEnd: r.cancel_at_period_end,
  }
}
