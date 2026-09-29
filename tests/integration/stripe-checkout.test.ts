import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pool } from '@/db'
import { createPlan, publishPlanVersion, getActiveSubscription } from '@/lib/plans'
import { createOrder, processPaymentWebhook, refundOrder } from '@/lib/orders'
import { createSession } from '@/lib/auth/sessions'
import { getWalletBalance } from '@/lib/db/ledger'
import { canReleasePurchaseKey } from '@/lib/payments/purchase-state'
import { POST as purchase } from '@/app/api/billing/purchase/route'
import { GET as catalog } from '@/app/api/billing/catalog/route'

let tenant: { id: string; tenant_id: string }
let versionId: string
let userId: string
let cookie: string
let orderNumber = 0
const secret = 'whsec_integration_fixture'
const sessions = new Map<string, Record<string, unknown>>()
beforeAll(async () => {
  // This suite destroys its schema. Fail before connecting unless the caller
  // explicitly selected a disposable test/CI database; never load .env.local.
  const url = new URL(process.env.DATABASE_URL ?? 'http://invalid')
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !/(?:test|ci)/i.test(url.pathname))
    throw new Error('Stripe integration requires an explicitly named test/CI DATABASE_URL.')
  await pool.query(
    'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS pgcrypto',
  )
  for (const file of [
    '0000_left_nekra.sql',
    '0001_greedy_shape.sql',
    '0002_auth_secret_plane.sql',
    '0004_commercial_plans_payments.sql',
  ])
    await pool.query(readFileSync(join(process.cwd(), 'drizzle', file), 'utf8'))
})
beforeEach(async () => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_integration_fixture')
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', secret)
  vi.stubEnv('STRIPE_MODE', 'test')
  vi.stubEnv('STRIPE_CHECKOUT_ORIGIN', 'https://merchant.example')
  sessions.clear()
  tenant = (
    await pool.query(
      "INSERT INTO organizations (id,name,slug,status) VALUES (gen_random_uuid(),'Stripe test',$1,'active') RETURNING id,tenant_id",
      [randomUUID()],
    )
  ).rows[0]
  userId = (
    await pool.query(
      "INSERT INTO users (id,email,password_hash,status) VALUES (gen_random_uuid(),$1,'fixture-unused-password-hash','active') RETURNING id",
      [`${randomUUID()}@example.test`],
    )
  ).rows[0].id
  await pool.query(
    "INSERT INTO organization_memberships (id,organization_id,tenant_id,user_id,role) VALUES (gen_random_uuid(),$1,$2,$3,'owner')",
    [tenant.id, tenant.tenant_id, userId],
  )
  const session = await createSession({ userId })
  cookie = `nexus_session=${session.token}; nexus_csrf=fixture-csrf`
  const plan = await createPlan({ code: `stripe-${randomUUID()}`, name: 'Fixture' })
  versionId = (
    await publishPlanVersion({
      planId: plan.id,
      priceMicros: 12_000_000n,
      entitlements: [{ key: 'members', kind: 'limit', limitValue: 5n }],
    })
  ).id
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = new URLSearchParams(String(init?.body))
    const idempotency = new Headers(init?.headers).get('idempotency-key')!
    let response = sessions.get(idempotency)
    if (!response) {
      response = {
        object: 'checkout.session',
        id: `cs_test_${++orderNumber}`,
        mode: 'payment',
        status: 'open',
        payment_status: 'unpaid',
        url: `https://checkout.stripe.com/c/pay/session-${orderNumber}`,
        livemode: false,
        expires_at: Math.floor(Date.now() / 1000) + 86400,
        amount_total: Number(body.get('line_items[0][price_data][unit_amount]')),
        currency: body.get('line_items[0][price_data][currency]'),
        client_reference_id: body.get('client_reference_id'),
        metadata: { order_id: body.get('metadata[order_id]'), tenant_id: body.get('metadata[tenant_id]') },
      }
      sessions.set(idempotency, response)
    }
    return Response.json(response)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
afterAll(async () => {
  await pool.end()
})
function request(body: unknown, opts: { cookie?: string; csrf?: string } = {}) {
  return new Request('https://merchant.example/api/billing/purchase', {
    method: 'POST',
    headers: {
      cookie: opts.cookie ?? cookie,
      'x-csrf-token': opts.csrf ?? 'fixture-csrf',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}
function input(key = randomUUID()) {
  return {
    tenantId: tenant.tenant_id,
    organizationId: tenant.id,
    planVersionId: versionId,
    kind: 'subscription' as const,
    idempotencyKey: key,
    providerName: 'stripe',
    actorUserId: userId,
  }
}
function webhook(
  orderId: string,
  change: Record<string, unknown> = {},
  opts: { id?: string; timestamp?: number; signature?: string; type?: string } = {},
) {
  const session = sessions.get(`nexus-checkout:${orderId}`)!
  const body = JSON.stringify({
    id: opts.id ?? `evt_${randomUUID()}`,
    type: opts.type ?? 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object: { ...session, status: 'complete', payment_status: 'paid', ...change } },
  })
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000)
  const signature = opts.signature ?? createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return new Request('https://merchant.example/api/webhooks/payments/stripe', {
    method: 'POST',
    headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
    body,
  })
}
async function status(orderId: string) {
  return (await pool.query('SELECT status FROM orders WHERE id=$1', [orderId])).rows[0].status
}
async function ledgerCount(orderId: string) {
  return Number(
    (await pool.query('SELECT count(*) FROM ledger_transactions WHERE reference_id=$1', [orderId])).rows[0].count,
  )
}

describe('Stripe checkout settlement and retry isolation', () => {
  it('concurrent distinct purchases converge to the newer paid plan and retain both ledger transactions', async () => {
    const older = await createOrder(input())
    const plan = await createPlan({ code: `concurrent-${randomUUID()}`, name: 'Concurrent plan' })
    const newerVersion = await publishPlanVersion({ planId: plan.id, priceMicros: 24_000_000n })
    const newer = await createOrder({ ...input(), planVersionId: newerVersion.id })
    const responses = await Promise.all([
      processPaymentWebhook('stripe', webhook(newer.order.id)),
      processPaymentWebhook('stripe', webhook(older.order.id)),
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect((await getActiveSubscription(tenant.tenant_id))?.planVersionId).toBe(newerVersion.id)
    expect(await ledgerCount(older.order.id)).toBe(1)
    expect(await ledgerCount(newer.order.id)).toBe(1)
  })
  it('a newer unpaid checkout does not block the older successfully paid purchase', async () => {
    const older = await createOrder(input())
    const newer = await createOrder(input())
    expect((await processPaymentWebhook('stripe', webhook(older.order.id))).status).toBe(200)
    expect((await getActiveSubscription(tenant.tenant_id))?.planVersionId).toBe(versionId)
    expect(await status(newer.order.id)).toBe('pending')
    expect(
      Number(
        (await pool.query('SELECT count(*) FROM reconciliation_cases WHERE tenant_id=$1', [tenant.tenant_id])).rows[0]
          .count,
      ),
    ).toBe(0)
  })
  it('reconciles an older paid purchase without replacing a newer paid plan on reversed callbacks', async () => {
    const older = await createOrder(input())
    const nextPlan = await createPlan({ code: `newer-${randomUUID()}`, name: 'Newer plan' })
    const nextVersion = await publishPlanVersion({ planId: nextPlan.id, priceMicros: 24_000_000n })
    const newer = await createOrder({ ...input(), planVersionId: nextVersion.id })
    const recent = await processPaymentWebhook('stripe', webhook(newer.order.id))
    expect(recent.status).toBe(200)
    expect((await processPaymentWebhook('stripe', webhook(older.order.id))).status).toBe(200)
    expect((await getActiveSubscription(tenant.tenant_id))?.planVersionId).toBe(nextVersion.id)
    expect(await ledgerCount(older.order.id)).toBe(1)
    expect(await ledgerCount(newer.order.id)).toBe(1)
    const row = (await pool.query('SELECT status,metadata FROM orders WHERE id=$1', [older.order.id])).rows[0]
    expect(row.status).toBe('paid')
    expect(row.metadata.subscriptionActivation).toMatchObject({
      status: 'reconciliation_required',
      supersededByOrderId: newer.order.id,
    })
    const cases = await pool.query('SELECT status FROM reconciliation_cases WHERE id=$1 AND tenant_id=$2', [
      row.metadata.subscriptionActivation.caseId,
      tenant.tenant_id,
    ])
    expect(cases.rows).toEqual([{ status: 'open' }])
    await processPaymentWebhook('stripe', webhook(older.order.id))
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM reconciliation_cases WHERE tenant_id=$1 AND reason='subscription_payment_superseded'",
            [tenant.tenant_id],
          )
        ).rows[0].count,
      ),
    ).toBe(1)
  })
  it('retains browser retry identity when checkout expired but the payment outcome is pending', async () => {
    const params = input()
    const first = await createOrder(params)
    await pool.query("UPDATE orders SET metadata=jsonb_set(metadata,'{checkout,expiresAt}',to_jsonb(1)) WHERE id=$1", [
      first.order.id,
    ])
    const recovered = await createOrder(params)
    expect(recovered.order.status).toBe('pending')
    expect(recovered.checkout.checkoutUrl).toBeNull()
    expect(canReleasePurchaseKey(recovered.order.status)).toBe(false)
    expect(canReleasePurchaseKey('unknown')).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    // A delayed original callback still settles that same order exactly once.
    expect((await processPaymentWebhook('stripe', webhook(first.order.id))).status).toBe(200)
    const settled = await createOrder(params)
    expect(settled.order.id).toBe(first.order.id)
    expect(canReleasePurchaseKey(settled.order.status)).toBe(true)
    expect(await ledgerCount(first.order.id)).toBe(1)
  })
  it('does not recreate aged ambiguous checkout or reuse an order across test/live modes', async () => {
    const params = input()
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ambiguous network failure'))
    await expect(createOrder(params)).rejects.toMatchObject({ code: 'processor_error' })
    await pool.query(
      "UPDATE orders SET created_at=now()-interval '25 hours' WHERE tenant_id=$1 AND idempotency_key=$2",
      [tenant.tenant_id, params.idempotencyKey],
    )
    await expect(createOrder(params)).rejects.toMatchObject({ code: 'payment_provider_error', status: 409 })
    expect(fetch).toHaveBeenCalledTimes(1)
    const fresh = input()
    await createOrder(fresh)
    vi.stubEnv('STRIPE_MODE', 'live')
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_fixture')
    await expect(createOrder(fresh)).rejects.toMatchObject({ code: 'payment_provider_error', status: 409 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('never settles on checkout, survives concurrent retries, rejects changed idempotency payload', async () => {
    const params = input()
    const [first, second] = await Promise.all([createOrder(params), createOrder(params)])
    expect(first.order.id).toBe(second.order.id)
    expect(first.checkout.checkoutUrl).toBe(second.checkout.checkoutUrl)
    expect(sessions.size).toBe(1)
    expect(await status(first.order.id)).toBe('pending')
    expect(await ledgerCount(first.order.id)).toBe(0)
    await expect(createOrder({ ...params, planVersionId: randomUUID() })).rejects.toMatchObject({
      code: 'duplicate_idempotency_key',
    })
  })
  it('recovers provider failure on the same pending order and same deterministic key', async () => {
    const params = input()
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'))
    await expect(createOrder(params)).rejects.toMatchObject({ code: 'processor_error' })
    const pending = (
      await pool.query('SELECT id FROM orders WHERE tenant_id=$1 AND idempotency_key=$2', [
        tenant.tenant_id,
        params.idempotencyKey,
      ])
    ).rows[0]
    const recovered = await createOrder(params)
    expect(recovered.order.id).toBe(pending.id)
    expect(recovered.replayed).toBe(true)
    expect(recovered.checkout.checkoutUrl).toContain('https://checkout.stripe.com/')
  })
  it('rejects forged/stale callbacks, wrong amount/currency/session/tenant/provider without ledger changes', async () => {
    const { order } = await createOrder(input())
    expect((await processPaymentWebhook('stripe', webhook(order.id, {}, { signature: '0'.repeat(64) }))).status).toBe(
      401,
    )
    expect(
      (await processPaymentWebhook('stripe', webhook(order.id, {}, { timestamp: Math.floor(Date.now() / 1000) - 301 })))
        .status,
    ).toBe(401)
    for (const change of [
      { amount_total: 1199 },
      { currency: 'eur' },
      { id: 'cs_test_other' },
      { metadata: { order_id: order.id, tenant_id: randomUUID() } },
    ])
      expect((await processPaymentWebhook('stripe', webhook(order.id, change))).status).toBe(400)
    await pool.query("UPDATE orders SET payment_provider='mock' WHERE id=$1", [order.id])
    expect((await processPaymentWebhook('stripe', webhook(order.id))).status).toBe(400)
    expect(await status(order.id)).toBe('pending')
    expect(await ledgerCount(order.id)).toBe(0)
  })
  it('settles duplicate/concurrent callbacks exactly once and sets finite paid entitlement period', async () => {
    const { order } = await createOrder(input())
    const [a, b] = await Promise.all([
      processPaymentWebhook('stripe', webhook(order.id, {}, { id: 'evt_concurrent' })),
      processPaymentWebhook('stripe', webhook(order.id, {}, { id: 'evt_concurrent' })),
    ])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(await status(order.id)).toBe('paid')
    expect(await ledgerCount(order.id)).toBe(1)
    expect((await processPaymentWebhook('stripe', webhook(order.id))).status).toBe(200)
    expect(await ledgerCount(order.id)).toBe(1)
    const active = await getActiveSubscription(tenant.tenant_id)
    expect(active?.effectiveTo).toEqual(active?.currentPeriodEnd)
    expect(
      await getActiveSubscription(tenant.tenant_id, new Date(active!.currentPeriodEnd!.getTime() + 1000)),
    ).toBeNull()
    expect(await getWalletBalance(tenant.tenant_id, order.walletId)).toBe(0n)
  })
  it('rejects early webhook retryably until session persistence and ignores unpaid completion', async () => {
    const { order } = await createOrder(input())
    await pool.query('UPDATE orders SET external_order_id=NULL WHERE id=$1', [order.id])
    expect((await processPaymentWebhook('stripe', webhook(order.id))).status).toBe(409)
    expect(await ledgerCount(order.id)).toBe(0)
    await pool.query('UPDATE orders SET external_order_id=$2 WHERE id=$1', [order.id, order.externalOrderId])
    expect(
      (await (await processPaymentWebhook('stripe', webhook(order.id, { payment_status: 'unpaid' }))).json()).status,
    ).toBe('ignored')
    expect(await status(order.id)).toBe('pending')
    expect((await processPaymentWebhook('stripe', webhook(order.id))).status).toBe(200)
  })
  it('does not falsely complete unsupported Stripe refunds', async () => {
    const { order } = await createOrder(input())
    await processPaymentWebhook('stripe', webhook(order.id))
    await expect(
      refundOrder({ tenantId: tenant.tenant_id, orderId: order.id, reason: 'fixture' }),
    ).rejects.toMatchObject({ code: 'refund_not_supported' })
    expect(await status(order.id)).toBe('paid')
    expect(await ledgerCount(order.id)).toBe(1)
  })
})
describe('Authenticated browser purchase boundary', () => {
  it('uses session tenant, organization and actor and returns only hosted checkout', async () => {
    const response = await purchase(request({ planVersionId: versionId, idempotencyKey: randomUUID() }))
    expect(response.status).toBe(201)
    const body = await response.json()
    const row = (await pool.query('SELECT * FROM orders WHERE id=$1', [body.order.id])).rows[0]
    expect(row.tenant_id).toBe(tenant.tenant_id)
    expect(row.organization_id).toBe(tenant.id)
    expect(row.amount).toBe('12000000')
    expect(row.status).toBe('pending')
    expect(JSON.stringify(body)).not.toContain('sk_test_')
    expect(body.checkout.confirmation).toBe('webhook_only')
    const audit = await pool.query(
      "SELECT actor_user_id FROM audit_events WHERE target_id=$1 AND action='order.created'",
      [body.order.id],
    )
    expect(audit.rows[0].actor_user_id).toBe(userId)
  })
  it('rejects browser overrides, invalid JSON shape, missing login and missing CSRF', async () => {
    const body = { planVersionId: versionId, idempotencyKey: randomUUID() }
    for (const injected of [
      { tenantId: 'other' },
      { organizationId: 'other' },
      { actorUserId: 'other' },
      { amount: '1' },
      { currency: 'EUR' },
      { provider: 'mock' },
    ])
      expect((await purchase(request({ ...body, ...injected }))).status).toBe(400)
    expect((await purchase(request(null))).status).toBe(400)
    expect((await purchase(request(body, { cookie: '' }))).status).toBe(401)
    expect((await purchase(request(body, { csrf: '' }))).status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['viewer', 'developer'])('rejects %s even when UI is bypassed', async (role) => {
    await pool.query('UPDATE organization_memberships SET role=$1 WHERE user_id=$2', [role, userId])
    expect((await purchase(request({ planVersionId: versionId, idempotencyKey: randomUUID() }))).status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('requires published plans and keeps identical keys isolated per tenant', async () => {
    const key = randomUUID()
    const first = await createOrder(input(key))
    const foreign = (
      await pool.query(
        "INSERT INTO organizations (id,name,slug,status) VALUES (gen_random_uuid(),'Foreign',$1,'active') RETURNING id,tenant_id",
        [randomUUID()],
      )
    ).rows[0]
    await expect(createOrder({ ...input(key), organizationId: foreign.id })).rejects.toMatchObject({
      code: 'duplicate_idempotency_key',
    })
    const second = await createOrder({ ...input(key), tenantId: foreign.tenant_id, organizationId: foreign.id })
    expect(second.order.id).not.toBe(first.order.id)
    const draft = await pool.query(
      "INSERT INTO plan_versions (id,plan_id,version,status,currency,price_micros) SELECT gen_random_uuid(),plan_id,2,'draft','USD',12000000 FROM plan_versions WHERE id=$1 RETURNING id",
      [versionId],
    )
    expect((await purchase(request({ planVersionId: draft.rows[0].id, idempotencyKey: randomUUID() }))).status).toBe(
      409,
    )
  })
  it('reports safe configured/unconfigured catalog state and fails closed without merchant settings', async () => {
    const response = await catalog(new Request('https://merchant.example/api/billing/catalog', { headers: { cookie } }))
    const body = await response.json()
    expect(body.payment).toMatchObject({ configured: true, mode: 'test' })
    expect(body.plans.find((plan: { id: string }) => plan.id === versionId).amount).toBe('12.000000')
    expect(JSON.stringify(body)).not.toContain(secret)
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    expect((await purchase(request({ planVersionId: versionId, idempotencyKey: randomUUID() }))).status).toBe(503)
    const disabled = await (
      await catalog(new Request('https://merchant.example/api/billing/catalog', { headers: { cookie } }))
    ).json()
    expect(disabled.payment).toMatchObject({ configured: false, mode: null })
  })
})
