// Orders, checkout and refunds (Work Item G).
//
// Money rules implemented here:
//   - The order amount is ALWAYS recomputed server-side from the plan version.
//     A browser-supplied amount is accepted in the request shape only so it can
//     be ignored; it is never read (INVARIANT #15, requirement 2).
//   - A payment is settled ONLY by a verified webhook. createCheckout never
//     marks an order paid.
//   - A refund references the original recharge transaction and posts a
//     compensating entry in the same append-only ledger. History is never
//     modified (INVARIANT #3).
//   - Managed-credit orders are gated by the managed_credits flag plus a fully
//     approved tenant_compliance record (ADR-0004).
//
// Ledger idempotency keys are derived from the order id, so a duplicate webhook,
// a retried settlement or a concurrent handler converge on one entry.

import { pool } from '@/db'
import { safeLogAudit } from '@/lib/audit'
import { ensureSystemLedgerAccount, ensureWalletLedgerAccount, postTransaction } from '@/lib/db/ledger'
import { findLedgerTransactionByIdempotencyKey } from '@/lib/db/repositories'
import { getPaymentProvider, type CheckoutResult, type PaymentProvider, type RefundResult } from '@/lib/payments'
import { periodEndFor, getPlanVersion, scheduleSubscriptionChange, type PlanVersionRecord } from '@/lib/plans'
import { assertManagedCreditsEnabled } from '@/lib/plans/managed-credits'
import { OrderError } from './errors'
import type { PoolClient } from 'pg'

export { OrderError } from './errors'
export type { OrderErrorCode } from './errors'

export type OrderKind = 'subscription' | 'managed_credits'

export const ORDER_KINDS: readonly OrderKind[] = ['subscription', 'managed_credits']

export function isOrderKind(value: unknown): value is OrderKind {
  return value === 'subscription' || value === 'managed_credits'
}

// ── Ledger idempotency keys ───────────────────────────────────────────
export const orderRechargeKey = (orderId: string): string => `order_recharge:${orderId}`
export const orderRefundKey = (orderId: string): string => `order_refund:${orderId}`
export const paymentEventKey = (provider: string, eventId: string): string => `payment_event:${provider}:${eventId}`
export const orderOutboxKey = (orderId: string, event: string): string => `order_outbox:${event}:${orderId}`

export interface OrderRecord {
  id: string
  tenantId: string
  organizationId: string
  walletId: string
  amountMicros: bigint
  currency: string
  paymentProvider: string
  externalOrderId: string | null
  status: string
  kind: OrderKind
  planVersionId: string | null
  idempotencyKey: string | null
  metadata: Record<string, unknown>
  createdAt: Date
  paidAt: Date | null
}

interface OrderRow {
  id: string
  tenant_id: string
  organization_id: string
  wallet_id: string
  amount: string | number
  currency: string
  payment_provider: string
  external_order_id: string | null
  status: string
  kind: OrderKind
  plan_version_id: string | null
  idempotency_key: string | null
  metadata: Record<string, unknown>
  created_at: Date
  paid_at: Date | null
}

function toOrderRecord(r: OrderRow): OrderRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    organizationId: r.organization_id,
    walletId: r.wallet_id,
    amountMicros: BigInt(r.amount),
    currency: r.currency,
    paymentProvider: r.payment_provider,
    externalOrderId: r.external_order_id,
    status: r.status,
    kind: r.kind,
    planVersionId: r.plan_version_id,
    idempotencyKey: r.idempotency_key,
    metadata: r.metadata ?? {},
    createdAt: r.created_at,
    paidAt: r.paid_at,
  }
}

/**
 * The authoritative order amount for a plan version. Both order kinds derive it
 * from the version — never from the caller.
 *   - subscription:     the plan fee.
 *   - managed_credits:  the credit package the version grants.
 */
export function serverOrderAmount(kind: OrderKind, version: PlanVersionRecord): bigint {
  return kind === 'subscription' ? version.priceMicros : version.includedCreditsMicros
}

// ── Order creation + checkout ─────────────────────────────────────────

export interface CreateOrderInput {
  tenantId: string
  organizationId?: string
  kind: OrderKind
  planVersionId: string
  idempotencyKey: string
  actorUserId?: string | null
  providerName?: string
}

export interface CreatedOrder {
  order: OrderRecord
  checkout: CheckoutResult
  replayed: boolean
}

export async function createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
  const tenantId = input.tenantId?.trim()
  const idempotencyKey = input.idempotencyKey?.trim()
  if (!tenantId) throw new OrderError('invalid_input', 'tenant_id is required')
  if (!idempotencyKey) throw new OrderError('invalid_input', 'idempotency_key is required')
  if (!isOrderKind(input.kind)) throw new OrderError('invalid_input', 'kind must be subscription or managed_credits')

  // Managed credits are a controlled capability: deny before doing anything.
  if (input.kind === 'managed_credits') {
    await assertManagedCreditsEnabled(tenantId)
  }

  const provider = getPaymentProvider(input.providerName ?? 'mock')

  // 1) Resolve/deduplicate and persist the pending order (short transaction,
  //    no external I/O inside it).
  let created: { row: OrderRow; replayed: boolean }
  try {
    created = await withTransaction(async (client) => {
      const replayed = await client.query<OrderRow>(
        `SELECT * FROM orders WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
        [tenantId, idempotencyKey],
      )
      if (replayed.rows.length) {
        return { row: replayed.rows[0], replayed: true }
      }

      const org = await client.query<{ id: string }>(
        `SELECT id FROM organizations WHERE tenant_id = $1 AND deleted_at IS NULL AND ($2::text IS NULL OR id = $2) LIMIT 1`,
        [tenantId, input.organizationId ?? null],
      )
      if (!org.rows.length) throw new OrderError('tenant_not_found', `tenant ${tenantId} not found`, 404)

      const version = await getPlanVersion(input.planVersionId, client)
      if (!version) throw new OrderError('plan_version_not_found', `plan version ${input.planVersionId} not found`, 404)
      if (version.status !== 'published') {
        throw new OrderError('plan_version_not_published', `plan version ${input.planVersionId} is not published`, 409)
      }
      if (
        (version.effectiveFrom && version.effectiveFrom.getTime() > Date.now()) ||
        (version.effectiveTo && version.effectiveTo.getTime() <= Date.now())
      ) {
        throw new OrderError('plan_version_not_published', 'Plan version is outside its purchase window.', 409)
      }

      const amount = serverOrderAmount(input.kind, version)
      const wallet = await ensureWallet(client, tenantId, org.rows[0].id, version.currency)

      const inserted = await client.query<OrderRow>(
        `INSERT INTO orders (id, organization_id, tenant_id, wallet_id, amount, currency, payment_provider,
                           status, idempotency_key, kind, plan_version_id, metadata)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10::jsonb)
       RETURNING *`,
        [
          org.rows[0].id,
          tenantId,
          wallet.id,
          amount.toString(),
          version.currency,
          provider.name,
          idempotencyKey,
          input.kind,
          version.id,
          JSON.stringify({ planCode: version.planCode, planVersion: version.version, checkoutMode: provider.mode }),
        ],
      )
      return { row: inserted.rows[0], replayed: false }
    })
  } catch (e) {
    // Concurrent creation with the same idempotency key: the unique index wins,
    // and the loser converges on the same order instead of failing.
    if (!isUniqueViolation(e)) throw e
    const existing = await pool.query<OrderRow>(
      `SELECT * FROM orders WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
      [tenantId, idempotencyKey],
    )
    if (!existing.rows.length) throw e
    created = { row: existing.rows[0], replayed: true }
  }

  const order = toOrderRecord(created.row)
  if (
    order.kind !== input.kind ||
    order.planVersionId !== input.planVersionId ||
    order.paymentProvider !== provider.name ||
    (input.organizationId && order.organizationId !== input.organizationId)
  ) {
    throw new OrderError('duplicate_idempotency_key', 'Idempotency key is already bound to a different purchase.', 409)
  }
  if (provider.mode && order.metadata.checkoutMode !== provider.mode) {
    throw new OrderError(
      'payment_provider_error',
      'This order belongs to a different payment mode. Contact billing support.',
      409,
    )
  }
  if (created.replayed && (order.externalOrderId || order.status !== 'pending')) {
    return { order, checkout: storedCheckout(order), replayed: true }
  }
  // Stripe retains idempotency keys for at least 24h. Never create a second
  // processor session after an ambiguous checkout has aged beyond that bound.
  if (created.replayed && Date.now() - order.createdAt.getTime() > 23 * 60 * 60 * 1000) {
    throw new OrderError(
      'payment_provider_error',
      'Checkout recovery window expired. Contact billing support before retrying.',
      409,
    )
  }

  // 2) Ask the provider to prepare a checkout. This is deliberately outside the
  //    DB transaction, and its result is never treated as payment success.
  const checkout = await provider.createCheckout({
    orderId: order.id,
    amount: order.amountMicros,
    currency: order.currency,
    tenantId,
  })

  await pool.query(
    `UPDATE orders SET external_order_id = $3, metadata = metadata || $4::jsonb WHERE id = $1 AND tenant_id = $2`,
    [order.id, tenantId, checkout.externalOrderId, JSON.stringify({ checkout })],
  )

  await safeLogAudit({
    actorUserId: input.actorUserId ?? null,
    tenantId,
    action: 'order.created',
    targetType: 'order',
    targetId: order.id,
    metadata: {
      kind: input.kind,
      planVersionId: order.planVersionId,
      amountMicros: order.amountMicros.toString(),
      currency: order.currency,
      provider: provider.name,
      sandbox: checkout.sandbox,
    },
  })

  return {
    order: { ...order, externalOrderId: checkout.externalOrderId },
    checkout,
    replayed: created.replayed,
  }
}

export async function listOrdersForTenant(tenantId: string, limit = 50): Promise<OrderRecord[]> {
  const result = await pool.query<OrderRow>(
    `SELECT * FROM orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit],
  )
  return result.rows.map(toOrderRecord)
}

export async function getOrder(tenantId: string, orderId: string): Promise<OrderRecord | null> {
  const result = await pool.query<OrderRow>(`SELECT * FROM orders WHERE tenant_id = $1 AND id = $2 LIMIT 1`, [
    tenantId,
    orderId,
  ])
  const row = result.rows[0]
  return row ? toOrderRecord(row) : null
}

// ── Refunds ───────────────────────────────────────────────────────────

export interface RefundOrderInput {
  tenantId: string
  orderId: string
  reason: string
  actorUserId?: string | null
}

export interface RefundedOrder {
  orderId: string
  status: 'refunded'
  ledgerTransactionId: string
  amountMicros: bigint
  currency: string
  refund: RefundResult
  replayed: boolean
}

/**
 * Refund a paid order. The original recharge transaction is left untouched; a
 * NEW `refund` transaction reverses it, so the ledger remains append-only and
 * auditable. The (tenant, order status) row lock plus the deterministic
 * `order_refund:<orderId>` idempotency key make duplicate refunds impossible
 * even under concurrency.
 */
export async function refundOrder(input: RefundOrderInput): Promise<RefundedOrder> {
  const tenantId = input.tenantId?.trim()
  const orderId = input.orderId?.trim()
  if (!tenantId || !orderId) throw new OrderError('invalid_input', 'tenant_id and order_id are required')
  const reason = (input.reason ?? '').trim() || 'customer request'

  const existingOrder = await getOrder(tenantId, orderId)
  if (!existingOrder) throw new OrderError('order_not_found', `order ${orderId} not found`, 404)
  if (existingOrder.status === 'refunded') {
    throw new OrderError('duplicate_refund', 'order has already been refunded', 409)
  }
  if (existingOrder.status !== 'paid') {
    throw new OrderError('order_not_refundable', `order status '${existingOrder.status}' cannot be refunded`, 409)
  }

  const original = await findLedgerTransactionByIdempotencyKey(tenantId, orderRechargeKey(orderId))
  if (!original) {
    throw new OrderError(
      'missing_original_transaction',
      'the original recharge transaction is missing; refusing to compensate blind',
      500,
    )
  }

  // Ask the processor first. Sandbox returns `sandbox`; a real provider would
  // return `pending` until its own confirmation arrives, which this work item
  // does not yet model — a `pending` result is not treated as final.
  const provider = getPaymentProvider(existingOrder.paymentProvider)
  const refund = await provider.refund({
    originalTransactionId: original.id,
    amount: existingOrder.amountMicros,
    reason,
    orderId,
    currency: existingOrder.currency,
    tenantId,
    idempotencyKey: orderRefundKey(orderId),
  })
  if (refund.status === 'failed') {
    throw new OrderError('payment_provider_error', 'payment provider rejected the refund', 502)
  }
  if (refund.status === 'pending') {
    throw new OrderError('payment_provider_error', 'refund is pending provider confirmation', 409)
  }

  const result = await withTransaction(async (client) => {
    const locked = await client.query<OrderRow>(`SELECT * FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
      tenantId,
      orderId,
    ])
    const order = locked.rows[0]
    if (!order) throw new OrderError('order_not_found', `order ${orderId} not found`, 404)
    if (order.status === 'refunded') throw new OrderError('duplicate_refund', 'order has already been refunded', 409)
    if (order.status !== 'paid') {
      throw new OrderError('order_not_refundable', `order status '${order.status}' cannot be refunded`, 409)
    }

    const amount = BigInt(order.amount)
    const currency = order.currency

    // Compensating entry, mirroring how the recharge was posted. The original
    // entry is never updated (INVARIANT #3).
    if (amount > 0n) {
      const clearingAccountId = await ensureSystemLedgerAccount(tenantId, 'clearing', currency, client)
      if (order.kind === 'managed_credits') {
        const walletAccountId = await ensureWalletLedgerAccount(tenantId, order.wallet_id, currency, client)
        await postTransaction(
          {
            tenantId,
            type: 'refund',
            currency,
            idempotencyKey: orderRefundKey(orderId),
            postings: [
              { accountId: walletAccountId, amount, entryType: 'debit' },
              { accountId: clearingAccountId, amount, entryType: 'credit' },
            ],
            referenceType: 'order',
            referenceId: orderId,
            description: `refund: ${reason}`,
            createdBy: input.actorUserId ?? undefined,
          },
          client,
        )
      } else {
        const revenueAccountId = await ensureSystemLedgerAccount(tenantId, 'revenue', currency, client)
        await postTransaction(
          {
            tenantId,
            type: 'refund',
            currency,
            idempotencyKey: orderRefundKey(orderId),
            postings: [
              { accountId: revenueAccountId, amount, entryType: 'debit' },
              { accountId: clearingAccountId, amount, entryType: 'credit' },
            ],
            referenceType: 'order',
            referenceId: orderId,
            description: `refund: ${reason}`,
            createdBy: input.actorUserId ?? undefined,
          },
          client,
        )
      }
    }

    const updated = await client.query(
      `UPDATE orders
          SET status = 'refunded',
              metadata = metadata || $3::jsonb
        WHERE tenant_id = $1 AND id = $2 AND status = 'paid'
        RETURNING id`,
      [
        tenantId,
        orderId,
        JSON.stringify({
          refund: {
            provider: refund.provider,
            status: refund.status,
            refundId: refund.refundId,
            amountMicros: amount.toString(),
            reason,
            originalTransactionId: original.id,
          },
        }),
      ],
    )
    if (!updated.rows.length) {
      throw new OrderError('duplicate_refund', 'order has already been refunded', 409)
    }

    await client.query(
      `INSERT INTO outbox_events (id, tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key)
       VALUES (gen_random_uuid(), $1, 'order', $2, 'order.refunded', $3::jsonb, $4)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
      [
        tenantId,
        orderId,
        JSON.stringify({ orderId, tenantId, amountMicros: amount.toString(), currency, reason }),
        orderOutboxKey(orderId, 'refunded'),
      ],
    )

    const refundTx = await findLedgerTransactionByIdempotencyKey(tenantId, orderRefundKey(orderId), client)
    return { transactionId: refundTx?.id ?? '', amount, currency }
  })

  await safeLogAudit({
    actorUserId: input.actorUserId ?? null,
    tenantId,
    action: 'order.refunded',
    targetType: 'order',
    targetId: orderId,
    metadata: {
      amountMicros: result.amount.toString(),
      currency: result.currency,
      reason,
      originalTransactionId: original.id,
      provider: refund.provider,
      sandbox: refund.sandbox,
    },
  })

  return {
    orderId,
    status: 'refunded',
    ledgerTransactionId: result.transactionId,
    amountMicros: result.amount,
    currency: result.currency,
    refund,
    replayed: false,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

interface WalletRow {
  id: string
}

async function ensureWallet(
  client: PoolClient,
  tenantId: string,
  organizationId: string,
  currency: string,
): Promise<WalletRow> {
  const existing = await client.query<WalletRow>(
    `SELECT id FROM wallet_accounts WHERE tenant_id = $1 AND currency = $2 LIMIT 1`,
    [tenantId, currency],
  )
  if (existing.rows.length) return existing.rows[0]
  const inserted = await client.query<WalletRow>(
    `INSERT INTO wallet_accounts (id, organization_id, tenant_id, currency, status)
     VALUES (gen_random_uuid(), $1, $2, $3, 'active')
     ON CONFLICT (tenant_id, currency) DO UPDATE SET currency = EXCLUDED.currency
     RETURNING id`,
    [organizationId, tenantId, currency],
  )
  return inserted.rows[0]
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505'
}

function storedCheckout(order: OrderRecord): CheckoutResult {
  const stored = (order.metadata.checkout ?? {}) as Partial<CheckoutResult>
  const provider = stored.provider ?? order.paymentProvider
  return {
    provider,
    status: (stored.status as CheckoutResult['status']) ?? 'pending',
    sandbox: stored.sandbox === true,
    externalOrderId: order.externalOrderId,
    checkoutUrl:
      order.status === 'pending' && (!stored.expiresAt || stored.expiresAt > Date.now() / 1000)
        ? (stored.checkoutUrl ?? null)
        : null,
    confirmation: 'webhook_only',
    expiresAt: stored.expiresAt,
    mode: stored.mode,
  }
}

/** Exposed for the webhook module: activate the plan a paid subscription bought. */
export async function activateSubscriptionForOrder(
  client: PoolClient,
  order: OrderRecord,
  actorUserId?: string | null,
): Promise<'active' | 'reconciliation_required' | null> {
  if (order.kind !== 'subscription' || !order.planVersionId) return null
  // Stripe delivers across orders out of sequence. A server-created purchase
  // has deterministic precedence (creation timestamp, ID as tie-break), not
  // webhook arrival time or Stripe's second-resolution event timestamp.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`subscriptions:${order.tenantId}`])
  const newer = await client.query<{ id: string }>(
    `SELECT id FROM orders WHERE tenant_id=$1 AND kind='subscription' AND paid_at IS NOT NULL
       AND (created_at,id) > (SELECT created_at,id FROM orders WHERE tenant_id=$1 AND id=$2)
     ORDER BY created_at DESC,id DESC LIMIT 1`,
    [order.tenantId, order.id],
  )
  if (newer.rows[0]) {
    const reconciliation = await client.query<{ id: string }>(
      `INSERT INTO reconciliation_cases (id,tenant_id,status,reason,expected_amount,actual_amount,currency,resolution)
       VALUES (gen_random_uuid(),$1,'open','subscription_payment_superseded',$2,$2,$3,$4) RETURNING id`,
      [
        order.tenantId,
        order.amountMicros.toString(),
        order.currency,
        `Paid order ${order.id} requires fulfillment/refund review: newer paid purchase ${newer.rows[0].id} retains plan precedence. No automatic refund or wallet credit.`,
      ],
    )
    await client.query('UPDATE orders SET metadata=metadata || $3::jsonb WHERE tenant_id=$1 AND id=$2', [
      order.tenantId,
      order.id,
      JSON.stringify({
        subscriptionActivation: {
          status: 'reconciliation_required',
          caseId: reconciliation.rows[0].id,
          supersededByOrderId: newer.rows[0].id,
        },
      }),
    ])
    return 'reconciliation_required'
  }
  const version = await getPlanVersion(order.planVersionId, client)
  if (!version) throw new OrderError('plan_version_not_found', `plan version ${order.planVersionId} not found`, 404)
  const now = new Date()
  const periodEnd = periodEndFor(version.billingInterval, now)
  const subscription = await scheduleSubscriptionChange(
    {
      tenantId: order.tenantId,
      organizationId: order.organizationId,
      planVersionId: version.id,
      effectiveFrom: now,
      status: 'active',
      currentPeriodEnd: periodEnd,
      createdBy: actorUserId ?? null,
    },
    client,
  )
  // Hosted Checkout is a one-time purchase, not a recurring Stripe
  // subscription. Make the paid access end explicit for entitlement queries.
  await client.query('UPDATE subscriptions SET effective_to = $3 WHERE id = $1 AND tenant_id = $2', [
    subscription.id,
    order.tenantId,
    periodEnd,
  ])
  await client.query('UPDATE orders SET metadata=metadata || $3::jsonb WHERE tenant_id=$1 AND id=$2', [
    order.tenantId,
    order.id,
    JSON.stringify({ subscriptionActivation: { status: 'active', subscriptionId: subscription.id } }),
  ])
  return 'active'
}

/** Used by the webhook module to type-check the provider it is handling. */
export function resolveProvider(name: string): PaymentProvider {
  return getPaymentProvider(name)
}
