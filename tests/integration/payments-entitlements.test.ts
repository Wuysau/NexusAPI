// Integration tests for Work Item G — payments, plans, entitlements, orders.
//
// Requires a real Postgres (DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db).
// Resets the public schema and applies migrations 0000, 0001, 0002 and the
// journaled 0004 (commercial tables + orders.kind). Migration 0003 is the
// pre-existing unjournaled worker-outbox migration and is not needed here.
//
// Coverage (deliverable 7):
//   1. forgery            — bad/missing signature → 401, order untouched
//   2. replay             — same event id → 200, no second credit
//   3. out-of-order       — failed after succeeded → ignored, no regression
//   4. concurrent webhook — two concurrent deliveries → exactly one credit
//   5. amount tampering   — browser amount ignored, server recomputes
//   6. duplicate refund   — blocked; original recharge entry unchanged
//   7. upgrade/downgrade  — takes effect only at its effective time
//   8. entitlement overreach — no active subscription → 403
//   9. managed credits off — flag/compliance gate → 403
// Plus: checkout never confirms payment, amount-mismatched webhook rejected,
// tenant isolation of the internal orders API.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/app_db'
process.env.DATABASE_URL = DATABASE_URL
process.env.MOCK_PAYMENT_WEBHOOK_SECRET = 'integration-test-mock-webhook-secret-0123456789'
process.env.INTERNAL_ORDERS_TOKEN = 'integration-test-orders-token-0123456789'

import { pool as appPool } from '@/db'
import { getWalletBalance } from '@/lib/db/ledger'
import {
  createPlan,
  publishPlanVersion,
  listPublishedPlanVersions,
  listEntitlements,
  getActiveSubscription,
  getEntitlements,
  getEntitlement,
  requireEntitlement,
  scheduleSubscriptionChange,
  PlanError,
  type PlanVersionRecord,
} from '@/lib/plans'
import { managedCreditsStatus } from '@/lib/plans/managed-credits'
import { createOrder, refundOrder, orderRechargeKey, orderRefundKey, type OrderRecord } from '@/lib/orders'
import { buildSandboxWebhookRequest, MOCK_WEBHOOK_SECRET_ENV, type SandboxWebhookEvent } from '@/lib/payments'
import { POST as webhookPOST } from '@/app/api/webhooks/payments/[provider]/route'
import { GET as ordersGET, POST as ordersPOST } from '@/app/api/internal/orders/route'
import { POST as refundPOST } from '@/app/api/internal/orders/[id]/refund/route'

const testPool = new Pool({ connectionString: DATABASE_URL })
const WEBHOOK_SECRET = process.env[MOCK_WEBHOOK_SECRET_ENV] as string
const ORDERS_TOKEN = process.env.INTERNAL_ORDERS_TOKEN as string

function readMigration(name: string): string {
  return readFileSync(join(process.cwd(), 'drizzle', name), 'utf-8')
}

async function resetDatabase(): Promise<void> {
  const client = await testPool.connect()
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE')
    await client.query('CREATE SCHEMA public')
    await client.query('GRANT ALL ON SCHEMA public TO postgres')
    await client.query('GRANT ALL ON SCHEMA public TO public')
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    await client.query(readMigration('0000_left_nekra.sql'))
    await client.query(readMigration('0001_greedy_shape.sql'))
    await client.query(readMigration('0002_auth_secret_plane.sql'))
    await client.query(readMigration('0004_commercial_plans_payments.sql'))
  } finally {
    client.release()
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────

interface Tenant {
  id: string
  tenantId: string
}

async function seedTenant(prefix: string): Promise<Tenant> {
  const id = `org-${prefix}-${randomUUID()}`
  const result = await testPool.query<{ id: string; tenant_id: string }>(
    `INSERT INTO organizations (id, name, slug, status)
     VALUES ($1, $2, $3, 'active') RETURNING id, tenant_id`,
    [id, prefix, `${prefix}-${randomUUID()}`],
  )
  return { id: result.rows[0].id, tenantId: result.rows[0].tenant_id }
}

async function seedPlanVersion(opts: {
  code: string
  priceMicros?: bigint
  includedCreditsMicros?: bigint
  billingInterval?: 'month' | 'year'
  entitlements?: {
    key: string
    kind?: 'boolean' | 'limit'
    limitValue?: bigint | null
    booleanValue?: boolean | null
  }[]
}): Promise<PlanVersionRecord> {
  const code = `${opts.code}-${randomUUID().slice(0, 8)}`
  const plan = await createPlan({ code, name: code, tier: 'team' })
  return publishPlanVersion({
    planId: plan.id,
    priceMicros: opts.priceMicros ?? 0n,
    includedCreditsMicros: opts.includedCreditsMicros ?? 0n,
    billingInterval: opts.billingInterval ?? 'month',
    entitlements: opts.entitlements,
  })
}

async function setManagedCreditsFlag(enabled: boolean): Promise<void> {
  await testPool.query(
    `INSERT INTO feature_flags (key, enabled, description, updated_at)
     VALUES ('managed_credits', $1, 'test toggle', now())
     ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [enabled],
  )
}

/** Enable managed credits for a tenant (flag + fully approved compliance). */
async function enableManagedCredits(tenantId: string): Promise<void> {
  await setManagedCreditsFlag(true)
  await approveTenantCompliance(tenantId)
}

async function approveTenantCompliance(
  tenantId: string,
  statuses: Partial<Record<'contract' | 'payment' | 'tax' | 'region', string>> = {},
): Promise<void> {
  const s = { contract: 'approved', payment: 'approved', tax: 'approved', region: 'approved', ...statuses }
  await testPool.query(
    `INSERT INTO tenant_compliance (id, tenant_id, contract_status, payment_status, tax_status, region_status, region)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'CN')
     ON CONFLICT (tenant_id) DO UPDATE SET contract_status = EXCLUDED.contract_status,
       payment_status = EXCLUDED.payment_status, tax_status = EXCLUDED.tax_status, region_status = EXCLUDED.region_status`,
    [tenantId, s.contract, s.payment, s.tax, s.region],
  )
}

function successEvent(order: OrderRecord, overrides: Partial<SandboxWebhookEvent> = {}): SandboxWebhookEvent {
  return {
    id: `evt_${randomUUID()}`,
    type: 'payment.succeeded',
    orderId: order.id,
    amount: order.amountMicros,
    currency: order.currency,
    ...overrides,
  }
}

function webhookRequest(event: SandboxWebhookEvent, opts: { secret?: string; timestamp?: number } = {}): Request {
  return buildSandboxWebhookRequest(event, {
    secret: opts.secret ?? WEBHOOK_SECRET,
    timestamp: opts.timestamp,
  })
}

async function deliver(event: SandboxWebhookEvent, opts?: { secret?: string; timestamp?: number }): Promise<Response> {
  return webhookPOST(webhookRequest(event, opts), { params: Promise.resolve({ provider: 'mock' }) })
}

function ordersRequest(
  method: 'GET' | 'POST',
  body?: unknown,
  opts: { token?: string | null; query?: string } = {},
): Request {
  const headers: Record<string, string> = {}
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? ORDERS_TOKEN}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return new Request(`http://localhost/api/internal/orders${opts.query ?? ''}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function countRows(sql: string, params: unknown[] = []): Promise<number> {
  const r = await testPool.query<{ n: string }>(sql, params)
  return Number(r.rows[0].n)
}

async function ledgerTransactionsFor(tenantId: string, idempotencyKey: string) {
  return testPool.query<{ id: string; type: string }>(
    `SELECT id, type FROM ledger_transactions WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey],
  )
}

// ── Suite ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  await resetDatabase()
})

beforeEach(async () => {
  // Managed credits default OFF for every test; a test opts in explicitly.
  await testPool.query(`DELETE FROM feature_flags WHERE key = 'managed_credits'`)
})

afterAll(async () => {
  await appPool.end().catch(() => {})
  await testPool.end()
})

// ── 1. Plans, versions, entitlements ──────────────────────────────────

describe('versioned plans and entitlements', () => {
  it('publishes immutable versions and exposes them for the UI (no hardcoded limits)', async () => {
    const plan = await createPlan({ code: `team-${randomUUID().slice(0, 8)}`, name: 'Team', tier: 'team' })
    const v1 = await publishPlanVersion({
      planId: plan.id,
      priceMicros: 50_000_000n,
      includedCreditsMicros: 10_000_000n,
      entitlements: [
        { key: 'api_keys', kind: 'limit', limitValue: 5n },
        { key: 'byok_channels', kind: 'boolean', booleanValue: true },
      ],
    })
    const v2 = await publishPlanVersion({
      planId: plan.id,
      priceMicros: 90_000_000n,
      entitlements: [{ key: 'api_keys', kind: 'limit', limitValue: 50n }],
    })

    expect(v1.version).toBe(1)
    expect(v2.version).toBe(2)
    expect(v1.priceMicros).toBe(50_000_000n)
    expect(v1.includedCreditsMicros).toBe(10_000_000n)
    expect(v1.status).toBe('published')

    const published = await listPublishedPlanVersions(plan.code)
    expect(published.map((v) => v.version)).toEqual([2, 1])

    const ents = await listEntitlements(v2.id)
    expect(ents).toHaveLength(1)
    expect(ents[0].limitValue).toBe(50n)

    // v1 keeps its own entitlement set — history is reproducible.
    const v1Ents = await listEntitlements(v1.id)
    expect(v1Ents.map((e) => e.key).sort()).toEqual(['api_keys', 'byok_channels'])
  })

  it('denies entitlement access with 403 when the tenant has no active subscription (overreach)', async () => {
    const tenant = await seedTenant('no-sub')
    const version = await seedPlanVersion({
      code: 'team',
      entitlements: [{ key: 'api_keys', kind: 'limit', limitValue: 5n }],
    })
    expect(version).toBeTruthy()

    expect(await getActiveSubscription(tenant.tenantId)).toBeNull()
    expect(await getEntitlements(tenant.tenantId)).toEqual([])
    await expect(requireEntitlement(tenant.tenantId, 'api_keys')).rejects.toBeInstanceOf(PlanError)
    await expect(requireEntitlement(tenant.tenantId, 'api_keys')).rejects.toMatchObject({ status: 403 })
  })

  it('applies upgrade/downgrade only at its effective time', async () => {
    const versionA = await seedPlanVersion({
      code: 'team',
      entitlements: [{ key: 'api_keys', kind: 'limit', limitValue: 5n }],
    })
    const versionB = await seedPlanVersion({
      code: 'enterprise',
      entitlements: [{ key: 'api_keys', kind: 'limit', limitValue: 50n }],
    })

    // Tenant 1: a FUTURE upgrade must not change today's entitlements.
    const futureTenant = await seedTenant('future-upgrade')
    await scheduleSubscriptionChange({
      tenantId: futureTenant.tenantId,
      organizationId: futureTenant.id,
      planVersionId: versionA.id,
      effectiveFrom: new Date(Date.now() - 1000),
    })
    const inOneHour = new Date(Date.now() + 60 * 60 * 1000)
    await scheduleSubscriptionChange({
      tenantId: futureTenant.tenantId,
      organizationId: futureTenant.id,
      planVersionId: versionB.id,
      effectiveFrom: inOneHour,
    })
    expect((await getEntitlement(futureTenant.tenantId, 'api_keys'))?.limitValue).toBe(5n)
    expect(
      (await getEntitlement(futureTenant.tenantId, 'api_keys', new Date(inOneHour.getTime() + 1000)))?.limitValue,
    ).toBe(50n)

    // Tenant 2: an immediate downgrade takes effect now.
    const nowTenant = await seedTenant('now-downgrade')
    await scheduleSubscriptionChange({
      tenantId: nowTenant.tenantId,
      organizationId: nowTenant.id,
      planVersionId: versionB.id,
      effectiveFrom: new Date(Date.now() - 1000),
    })
    expect((await getEntitlement(nowTenant.tenantId, 'api_keys'))?.limitValue).toBe(50n)
    await scheduleSubscriptionChange({
      tenantId: nowTenant.tenantId,
      organizationId: nowTenant.id,
      planVersionId: versionA.id,
      effectiveFrom: new Date(),
    })
    expect((await getEntitlement(nowTenant.tenantId, 'api_keys'))?.limitValue).toBe(5n)
  })

  it('refuses a subscription change whose effective time is in the past', async () => {
    const tenant = await seedTenant('past-change')
    const version = await seedPlanVersion({ code: 'team' })
    await expect(
      scheduleSubscriptionChange({
        tenantId: tenant.tenantId,
        planVersionId: version.id,
        effectiveFrom: new Date(Date.now() - 60 * 60 * 1000),
      }),
    ).rejects.toMatchObject({ code: 'effective_time_in_past' })
  })
})

// ── 2. Managed-credit gate (ADR-0004) ─────────────────────────────────

describe('managed-credit enablement gate', () => {
  async function managedOrder(tenant: Tenant, version: PlanVersionRecord): Promise<Response> {
    return ordersPOST(
      ordersRequest('POST', {
        tenant_id: tenant.tenantId,
        kind: 'managed_credits',
        plan_version_id: version.id,
        idempotency_key: `idem-${randomUUID()}`,
      }),
    )
  }

  it('is OFF by default (no flag row) and checkout is 403', async () => {
    const tenant = await seedTenant('mc-off')
    const version = await seedPlanVersion({ code: 'team', includedCreditsMicros: 10_000_000n })
    const res = await managedOrder(tenant, version)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('managed_credits_not_enabled')
  })

  it('stays 403 when the flag is on but no compliance record exists', async () => {
    const tenant = await seedTenant('mc-no-compliance')
    const version = await seedPlanVersion({ code: 'team', includedCreditsMicros: 10_000_000n })
    await setManagedCreditsFlag(true)
    expect((await managedCreditsStatus(tenant.tenantId)).enabled).toBe(false)
    expect((await managedOrder(tenant, version)).status).toBe(403)
  })

  it('stays 403 when any compliance check is not approved', async () => {
    const tenant = await seedTenant('mc-partial')
    const version = await seedPlanVersion({ code: 'team', includedCreditsMicros: 10_000_000n })
    await setManagedCreditsFlag(true)
    await approveTenantCompliance(tenant.tenantId, { tax: 'pending' })
    const res = await managedOrder(tenant, version)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.reasons).toContain('tax_status:pending')
  })

  it('allows checkout only when flag + contract/payment/tax/region are all approved', async () => {
    const tenant = await seedTenant('mc-approved')
    const version = await seedPlanVersion({ code: 'team', includedCreditsMicros: 10_000_000n })
    await setManagedCreditsFlag(true)
    await approveTenantCompliance(tenant.tenantId)
    const res = await managedOrder(tenant, version)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.order.kind).toBe('managed_credits')
    expect(body.order.amount_micros).toBe('10000000')
    expect(body.checkout.sandbox).toBe(true)
    expect(body.checkout.status).toBe('sandbox')
  })

  it('does not gate BYOK subscription orders (BYOK-first default)', async () => {
    const tenant = await seedTenant('byok-order')
    const version = await seedPlanVersion({ code: 'team', priceMicros: 50_000_000n })
    const res = await ordersPOST(
      ordersRequest('POST', {
        tenant_id: tenant.tenantId,
        kind: 'subscription',
        plan_version_id: version.id,
        idempotency_key: `idem-${randomUUID()}`,
      }),
    )
    expect(res.status).toBe(201)
  })
})

// ── 3. Orders: server-side amount, checkout is not payment ────────────

describe('orders', () => {
  it('ignores a browser-supplied amount and recomputes from the plan version', async () => {
    const tenant = await seedTenant('tamper')
    const version = await seedPlanVersion({ code: 'team', priceMicros: 50_000_000n })

    const res = await ordersPOST(
      ordersRequest('POST', {
        tenant_id: tenant.tenantId,
        kind: 'subscription',
        plan_version_id: version.id,
        idempotency_key: `idem-${randomUUID()}`,
        amount: '1', // tampered: must be ignored
        amount_micros: 1,
      }),
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.order.amount_micros).toBe('50000000')
    expect(body.order.status).toBe('pending')
    expect(body.checkout.confirmation).toBe('webhook_only')

    const persisted = await testPool.query<{ amount: string }>(`SELECT amount FROM orders WHERE id = $1`, [
      body.order.id,
    ])
    expect(persisted.rows[0].amount).toBe('50000000')
  })

  it('replays an order idempotently for the same idempotency key', async () => {
    const tenant = await seedTenant('idem')
    await enableManagedCredits(tenant.tenantId)
    const version = await seedPlanVersion({ code: 'team', includedCreditsMicros: 5_000_000n })
    const key = `idem-${randomUUID()}`
    const first = await createOrder({
      tenantId: tenant.tenantId,
      kind: 'managed_credits',
      planVersionId: version.id,
      idempotencyKey: key,
    })
    const second = await createOrder({
      tenantId: tenant.tenantId,
      kind: 'managed_credits',
      planVersionId: version.id,
      idempotencyKey: key,
    })
    expect(second.replayed).toBe(true)
    expect(second.order.id).toBe(first.order.id)
    expect(await countRows(`SELECT count(*)::text AS n FROM orders WHERE tenant_id = $1`, [tenant.tenantId])).toBe(1)
  })

  it('requires the internal bearer token and scopes GET by tenant', async () => {
    const tenantA = await seedTenant('isolation-a')
    const tenantB = await seedTenant('isolation-b')
    const version = await seedPlanVersion({ code: 'team', includedCreditsMicros: 5_000_000n })
    await createOrder({
      tenantId: tenantA.tenantId,
      kind: 'subscription',
      planVersionId: version.id,
      idempotencyKey: `idem-${randomUUID()}`,
    })

    const unauth = await ordersGET(
      ordersRequest('GET', undefined, { token: null, query: `?tenant_id=${tenantA.tenantId}` }),
    )
    expect(unauth.status).toBe(401)

    const listA = await ordersGET(ordersRequest('GET', undefined, { query: `?tenant_id=${tenantA.tenantId}` }))
    expect(listA.status).toBe(200)
    expect((await listA.json()).orders).toHaveLength(1)

    const listB = await ordersGET(ordersRequest('GET', undefined, { query: `?tenant_id=${tenantB.tenantId}` }))
    expect((await listB.json()).orders).toHaveLength(0)
  })
})

// ── 4. Webhook: forgery, replay, out-of-order, concurrency ────────────

describe('payment webhooks', () => {
  async function pendingOrder(kind: 'subscription' | 'managed_credits' = 'managed_credits') {
    const tenant = await seedTenant('wh')
    // Managed-credit orders require the flag + approved compliance.
    if (kind === 'managed_credits') await enableManagedCredits(tenant.tenantId)
    const version = await seedPlanVersion({
      code: kind,
      priceMicros: 50_000_000n,
      includedCreditsMicros: 20_000_000n,
    })
    const created = await createOrder({
      tenantId: tenant.tenantId,
      kind,
      planVersionId: version.id,
      idempotencyKey: `idem-${randomUUID()}`,
    })
    return { tenant, version, order: created.order }
  }

  it('rejects a forged signature with 401 and leaves the order pending', async () => {
    const { tenant, order } = await pendingOrder()
    const res = await deliver(successEvent(order), { secret: 'synthetic-different-secret-entirely' })
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('invalid_signature')
    expect(
      await countRows(`SELECT count(*)::text AS n FROM ledger_transactions WHERE tenant_id=$1`, [tenant.tenantId]),
    ).toBe(0)
    expect(await countRows(`SELECT count(*)::text AS n FROM orders WHERE id=$1 AND status='pending'`, [order.id])).toBe(
      1,
    )
  })

  it('rejects a missing signature and an expired timestamp', async () => {
    const { order } = await pendingOrder()
    const missing = new Request('http://localhost/api/webhooks/payments/mock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'evt_x', type: 'payment.succeeded', data: { order_id: order.id } }),
    })
    const missingRes = await webhookPOST(missing, { params: Promise.resolve({ provider: 'mock' }) })
    expect(missingRes.status).toBe(401)

    const expired = await deliver(successEvent(order), { timestamp: Math.floor(Date.now() / 1000) - 3600 })
    expect(expired.status).toBe(401)
    expect((await expired.json()).error.code).toBe('timestamp_out_of_window')
  })

  it('rejects an amount-mismatched webhook and never credits it', async () => {
    const { tenant, order } = await pendingOrder()
    const res = await deliver(successEvent(order, { amount: order.amountMicros + 1n }))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('amount_mismatch')
    expect(
      await countRows(`SELECT count(*)::text AS n FROM ledger_transactions WHERE tenant_id=$1`, [tenant.tenantId]),
    ).toBe(0)
    expect(await countRows(`SELECT count(*)::text AS n FROM orders WHERE id=$1 AND status='pending'`, [order.id])).toBe(
      1,
    )
  })

  it('settles a paid managed-credit order in one transaction (ledger + payment + outbox)', async () => {
    const { tenant, order } = await pendingOrder()
    const wallet = await testPool.query<{ id: string }>(`SELECT wallet_id AS id FROM orders WHERE id=$1`, [order.id])
    const walletId = wallet.rows[0].id

    const res = await deliver(successEvent(order))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('paid')
    expect(body.ledger_transaction_id).toBeTruthy()

    expect(await countRows(`SELECT count(*)::text AS n FROM orders WHERE id=$1 AND status='paid'`, [order.id])).toBe(1)
    expect(
      await countRows(`SELECT count(*)::text AS n FROM payments WHERE order_id=$1 AND status='completed'`, [order.id]),
    ).toBe(1)
    expect(
      await countRows(
        `SELECT count(*)::text AS n FROM outbox_events WHERE aggregate_id=$1 AND event_type='order.paid'`,
        [order.id],
      ),
    ).toBe(1)
    expect((await ledgerTransactionsFor(tenant.tenantId, orderRechargeKey(order.id))).rows).toHaveLength(1)
    expect(await getWalletBalance(tenant.tenantId, walletId)).toBe(order.amountMicros)
  })

  it('is idempotent: the same event delivered twice credits once', async () => {
    const { tenant, order } = await pendingOrder()
    const wallet = await testPool.query<{ id: string }>(`SELECT wallet_id AS id FROM orders WHERE id=$1`, [order.id])
    const walletId = wallet.rows[0].id
    const event = successEvent(order)

    const first = await deliver(event)
    expect(first.status).toBe(200)
    const second = await deliver(event)
    expect(second.status).toBe(200)
    expect((await second.json()).status).toBe('duplicate')

    expect(await countRows(`SELECT count(*)::text AS n FROM payments WHERE order_id=$1`, [order.id])).toBe(1)
    expect((await ledgerTransactionsFor(tenant.tenantId, orderRechargeKey(order.id))).rows).toHaveLength(1)
    expect(await getWalletBalance(tenant.tenantId, walletId)).toBe(order.amountMicros)
  })

  it('ignores an out-of-order failure after the order was paid', async () => {
    const { order } = await pendingOrder()
    await deliver(successEvent(order))
    const lateFailure = await deliver({
      id: `evt_${randomUUID()}`,
      type: 'payment.failed',
      orderId: order.id,
      amount: order.amountMicros,
      currency: order.currency,
      occurredAt: new Date(Date.now() - 30_000),
    })
    expect(lateFailure.status).toBe(200)
    expect((await lateFailure.json()).status).toBe('ignored')
    expect(await countRows(`SELECT count(*)::text AS n FROM orders WHERE id=$1 AND status='paid'`, [order.id])).toBe(1)
  })

  it('marks a pending order failed on a failure event without touching the ledger', async () => {
    const { tenant, order } = await pendingOrder()
    const res = await deliver({
      id: `evt_${randomUUID()}`,
      type: 'payment.failed',
      orderId: order.id,
      amount: order.amountMicros,
      currency: order.currency,
    })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('failed')
    expect(await countRows(`SELECT count(*)::text AS n FROM orders WHERE id=$1 AND status='failed'`, [order.id])).toBe(
      1,
    )
    expect(
      await countRows(`SELECT count(*)::text AS n FROM ledger_transactions WHERE tenant_id=$1`, [tenant.tenantId]),
    ).toBe(0)
  })

  it('settles a subscription order: no wallet credit, revenue posted, subscription active', async () => {
    const tenant = await seedTenant('sub-pay')
    const version = await seedPlanVersion({
      code: 'team',
      priceMicros: 50_000_000n,
      entitlements: [
        { key: 'api_keys', kind: 'limit', limitValue: 5n },
        { key: 'byok_channels', kind: 'boolean', booleanValue: true },
      ],
    })
    const created = await createOrder({
      tenantId: tenant.tenantId,
      kind: 'subscription',
      planVersionId: version.id,
      idempotencyKey: `idem-${randomUUID()}`,
    })
    const res = await deliver(successEvent(created.order))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('paid')

    const wallet = await testPool.query<{ wallet_id: string }>(`SELECT wallet_id FROM orders WHERE id=$1`, [
      created.order.id,
    ])
    // The plan fee is revenue, not wallet balance.
    expect(await getWalletBalance(tenant.tenantId, wallet.rows[0].wallet_id)).toBe(0n)

    const recharge = await testPool.query<{ type: string }>(
      `SELECT type FROM ledger_transactions WHERE tenant_id=$1 AND idempotency_key=$2`,
      [tenant.tenantId, orderRechargeKey(created.order.id)],
    )
    expect(recharge.rows[0].type).toBe('recharge')

    const sub = await getActiveSubscription(tenant.tenantId)
    expect(sub).not.toBeNull()
    expect(sub?.planVersionId).toBe(version.id)
    expect((await getEntitlement(tenant.tenantId, 'api_keys'))?.limitValue).toBe(5n)
    expect((await getEntitlement(tenant.tenantId, 'byok_channels'))?.booleanValue).toBe(true)
  })

  it('settles exactly once under two concurrent deliveries of the same event', async () => {
    const { tenant, order } = await pendingOrder()
    const wallet = await testPool.query<{ id: string }>(`SELECT wallet_id AS id FROM orders WHERE id=$1`, [order.id])
    const walletId = wallet.rows[0].id
    const event = successEvent(order)

    const [a, b] = await Promise.all([deliver(event), deliver(event)])
    expect([a.status, b.status]).toEqual([200, 200])

    expect(await countRows(`SELECT count(*)::text AS n FROM payments WHERE order_id=$1`, [order.id])).toBe(1)
    expect((await ledgerTransactionsFor(tenant.tenantId, orderRechargeKey(order.id))).rows).toHaveLength(1)
    expect(await getWalletBalance(tenant.tenantId, walletId)).toBe(order.amountMicros)
    expect(
      await countRows(
        `SELECT count(*)::text AS n FROM ledger_postings lp JOIN ledger_transactions lt ON lt.id=lp.transaction_id
          WHERE lt.tenant_id=$1 AND lt.idempotency_key=$2`,
        [tenant.tenantId, orderRechargeKey(order.id)],
      ),
    ).toBe(2)
  })

  it('returns 404 for an unknown provider and for an unknown order', async () => {
    const { order } = await pendingOrder()
    const unknownProvider = await webhookPOST(webhookRequest(successEvent(order)), {
      params: Promise.resolve({ provider: 'stripe' }),
    })
    expect(unknownProvider.status).toBe(404)

    const ghost = successEvent(order, { orderId: randomUUID() })
    const unknownOrder = await deliver(ghost)
    expect(unknownOrder.status).toBe(404)
  })
})

// ── 5. Refunds ────────────────────────────────────────────────────────

describe('refunds', () => {
  async function paidManagedCreditOrder() {
    const tenant = await seedTenant('refund')
    await enableManagedCredits(tenant.tenantId)
    const version = await seedPlanVersion({ code: 'team', includedCreditsMicros: 20_000_000n })
    const created = await createOrder({
      tenantId: tenant.tenantId,
      kind: 'managed_credits',
      planVersionId: version.id,
      idempotencyKey: `idem-${randomUUID()}`,
    })
    await deliver(successEvent(created.order))
    const wallet = await testPool.query<{ wallet_id: string }>(`SELECT wallet_id FROM orders WHERE id=$1`, [
      created.order.id,
    ])
    return { tenant, order: created.order, walletId: wallet.rows[0].wallet_id }
  }

  it('posts a compensating entry and never modifies the original recharge', async () => {
    const { tenant, order, walletId } = await paidManagedCreditOrder()
    expect(await getWalletBalance(tenant.tenantId, walletId)).toBe(order.amountMicros)

    const original = await ledgerTransactionsFor(tenant.tenantId, orderRechargeKey(order.id))
    const originalId = original.rows[0].id
    const before = await testPool.query(
      `SELECT id, amount, entry_type FROM ledger_postings WHERE transaction_id=$1 ORDER BY id`,
      [originalId],
    )

    const real = await refundPOST(
      new Request(`http://localhost/api/internal/orders/${order.id}/refund`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ORDERS_TOKEN}` },
        body: JSON.stringify({ tenant_id: tenant.tenantId, reason: 'customer request' }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    )
    expect(real.status).toBe(200)
    const body = await real.json()
    expect(body.status).toBe('refunded')
    expect(body.ledger_transaction_id).toBeTruthy()

    // Original entry untouched (INVARIANT #3).
    const after = await testPool.query(
      `SELECT id, amount, entry_type FROM ledger_postings WHERE transaction_id=$1 ORDER BY id`,
      [originalId],
    )
    expect(after.rows).toEqual(before.rows)

    // A NEW refund transaction exists and reverses the wallet credit.
    const refundTx = await ledgerTransactionsFor(tenant.tenantId, orderRefundKey(order.id))
    expect(refundTx.rows).toHaveLength(1)
    expect(refundTx.rows[0].type).toBe('refund')
    expect(await getWalletBalance(tenant.tenantId, walletId)).toBe(0n)

    expect(
      await countRows(`SELECT count(*)::text AS n FROM orders WHERE id=$1 AND status='refunded'`, [order.id]),
    ).toBe(1)
    expect(
      await countRows(
        `SELECT count(*)::text AS n FROM outbox_events WHERE aggregate_id=$1 AND event_type='order.refunded'`,
        [order.id],
      ),
    ).toBe(1)
  })

  it('blocks a duplicate refund and does not debit the wallet twice', async () => {
    const { tenant, order, walletId } = await paidManagedCreditOrder()
    await refundOrder({ tenantId: tenant.tenantId, orderId: order.id, reason: 'first' })

    await expect(refundOrder({ tenantId: tenant.tenantId, orderId: order.id, reason: 'again' })).rejects.toMatchObject({
      code: 'duplicate_refund',
      status: 409,
    })

    expect(
      await countRows(`SELECT count(*)::text AS n FROM ledger_transactions WHERE tenant_id=$1 AND idempotency_key=$2`, [
        tenant.tenantId,
        orderRefundKey(order.id),
      ]),
    ).toBe(1)
    expect(await getWalletBalance(tenant.tenantId, walletId)).toBe(0n)
  })

  it('refuses to refund an order that was never paid', async () => {
    const tenant = await seedTenant('refund-unpaid')
    await enableManagedCredits(tenant.tenantId)
    const version = await seedPlanVersion({ code: 'team', includedCreditsMicros: 20_000_000n })
    const created = await createOrder({
      tenantId: tenant.tenantId,
      kind: 'managed_credits',
      planVersionId: version.id,
      idempotencyKey: `idem-${randomUUID()}`,
    })
    await expect(
      refundOrder({ tenantId: tenant.tenantId, orderId: created.order.id, reason: 'nope' }),
    ).rejects.toMatchObject({ code: 'order_not_refundable' })
  })

  it('is tenant-scoped: another tenant cannot refund the order', async () => {
    const { order } = await paidManagedCreditOrder()
    const stranger = await seedTenant('stranger')
    await expect(
      refundOrder({ tenantId: stranger.tenantId, orderId: order.id, reason: 'theft' }),
    ).rejects.toMatchObject({ code: 'order_not_found', status: 404 })
  })
})

// ── 6. Payment provider safety ────────────────────────────────────────

describe('mock provider safety', () => {
  it('never reports a checkout as paid — only a webhook settles', async () => {
    const tenant = await seedTenant('sandbox')
    await enableManagedCredits(tenant.tenantId)
    const version = await seedPlanVersion({ code: 'team', includedCreditsMicros: 20_000_000n })
    const created = await createOrder({
      tenantId: tenant.tenantId,
      kind: 'managed_credits',
      planVersionId: version.id,
      idempotencyKey: `idem-${randomUUID()}`,
    })
    expect(created.checkout.sandbox).toBe(true)
    expect(created.checkout.status).not.toBe('paid')
    expect(created.order.status).toBe('pending')
    expect(created.order.kind).toBe('managed_credits')
  })
})
