// Payment webhook processing (Work Item G).
//
// INVARIANT #15: an external callback is verified, time-windowed, idempotent by
// event id and replay-resistant, and a client-side redirect is NOT evidence of
// payment. The order is settled only here.
//
// Everything that settles money happens in ONE database transaction:
//   lock order → verify amount → record payment → post ledger → mark paid →
//   activate subscription (plan orders) → enqueue outbox event.
// A duplicate or concurrent delivery of the same event therefore cannot double
// credit: the row lock serialises handlers, and the ledger idempotency key is
// derived from the order id.

import { safeLogAudit } from '@/lib/audit'
import { ensureSystemLedgerAccount, ensureWalletLedgerAccount, postTransaction } from '@/lib/db/ledger'
import { PaymentError, getPaymentProvider, paymentErrorStatus, type VerifiedPaymentEvent } from '@/lib/payments'
import {
  activateSubscriptionForOrder,
  orderOutboxKey,
  orderRechargeKey,
  paymentEventKey,
  withTransaction,
  type OrderRecord,
} from './service'
import { OrderError } from './errors'
import { resolveRequestIds, REQUEST_ID_HEADER } from '@/lib/middleware/request-id'
import { applySecurityHeaders } from '@/lib/middleware/security-headers'
import type { PoolClient } from 'pg'

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
  kind: 'subscription' | 'managed_credits'
  plan_version_id: string | null
  created_at: Date
  paid_at: Date | null
  metadata: Record<string, unknown>
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
    idempotencyKey: null,
    metadata: r.metadata ?? {},
    createdAt: r.created_at,
    paidAt: r.paid_at,
  }
}

export type WebhookOutcomeStatus = 'paid' | 'failed' | 'duplicate' | 'ignored'

export interface WebhookOutcome {
  status: number
  body: Record<string, unknown>
}

/**
 * Verify and apply a provider webhook. Returns a Response for the route.
 * Never throws: provider/order failures are mapped to contracted HTTP codes.
 */
export async function processPaymentWebhook(providerName: string, req: Request): Promise<Response> {
  const ids = resolveRequestIds(req)
  let event: VerifiedPaymentEvent
  let provider: ReturnType<typeof getPaymentProvider>
  try {
    provider = getPaymentProvider(providerName)
    event = await provider.verifyWebhook(req)
  } catch (e) {
    if (e instanceof PaymentError) {
      return errorResponse(paymentErrorStatus(e), e.code, e.message, ids)
    }
    return errorResponse(500, 'internal_error', 'Webhook could not be verified.', ids)
  }

  if (event.type === 'ignored') {
    const res = Response.json({ received: true, status: 'ignored' })
    stampHeaders(res, ids)
    return res
  }
  if (!event.orderId) {
    return errorResponse(400, 'malformed_event', 'Webhook does not identify an order.', ids)
  }

  try {
    const outcome = await withTransaction<WebhookOutcome>((client) => applyOnClient(client, provider.name, event))
    // Audit is supplementary; the outbox row written in the transaction is the
    // durable money record.
    await safeLogAudit({
      tenantId: (outcome.body.tenant_id as string | undefined) ?? null,
      action: `payment.webhook.${outcome.body.status}`,
      targetType: 'order',
      targetId: event.orderId ?? undefined,
      metadata: {
        provider: provider.name,
        eventId: event.eventId,
        eventType: event.type,
        status: outcome.body.status,
        amountMicros: event.amount.toString(),
        currency: event.currency,
      },
    })
    const res = Response.json(outcome.body, { status: outcome.status })
    stampHeaders(res, ids)
    return res
  } catch (e) {
    if (e instanceof OrderError) {
      return errorResponse(e.status, e.code, e.message, ids)
    }
    // Do not acknowledge arbitrary unique violations: the transaction rolled
    // back, so Stripe must retry. Legitimate duplicates use the row-lock guard.
    return errorResponse(500, 'internal_error', 'Webhook processing failed.', ids)
  }
}

async function applyOnClient(
  client: PoolClient,
  providerName: string,
  event: VerifiedPaymentEvent,
): Promise<WebhookOutcome> {
  const locked = await client.query<OrderRow>(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [event.orderId])
  const row = locked.rows[0]
  if (!row) {
    throw new OrderError('order_not_found', `order ${event.orderId} not found`, 404)
  }
  const order = toOrderRecord(row)
  const base = { order_id: order.id, tenant_id: order.tenantId, kind: order.kind }

  if (
    order.paymentProvider !== providerName ||
    event.provider !== providerName ||
    (event.tenantId !== undefined && event.tenantId !== order.tenantId) ||
    (event.mode !== undefined && order.metadata.checkoutMode !== event.mode)
  ) {
    throw new OrderError('payment_identity_mismatch', 'Payment identity does not match this order.', 400)
  }
  // A webhook can arrive before checkout persistence. Fail retryably instead
  // of crediting an unbound session, or falsely acknowledging the callback.
  if (!order.externalOrderId)
    throw new OrderError('payment_provider_error', 'Checkout session is not persisted yet; retry delivery.', 409)
  if (event.externalOrderId !== null && event.externalOrderId !== order.externalOrderId) {
    throw new OrderError('payment_identity_mismatch', 'Payment session does not match this order.', 400)
  }

  // The provider-reported amount must match the server-side order. A tampered
  // webhook amount is rejected outright and never credited.
  if (event.amount !== order.amountMicros || event.currency !== order.currency) {
    throw new OrderError(
      'amount_mismatch',
      `webhook amount ${event.amount} ${event.currency} does not match order ${order.amountMicros} ${order.currency}`,
      400,
    )
  }

  // Event-id idempotency backstop (in addition to the order-status guard).
  const already = await client.query<{ id: string }>(
    `SELECT id FROM payments WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [order.tenantId, paymentEventKey(providerName, event.eventId)],
  )
  if (already.rows.length) {
    return { status: 200, body: { received: true, status: 'duplicate', ...base } }
  }

  // Out-of-order / terminal state: never regress a paid or refunded order, and
  // never resurrect a failed one.
  if (order.status === 'paid') {
    const label = event.type === 'payment.succeeded' ? 'duplicate' : 'ignored'
    return { status: 200, body: { received: true, status: label, reason: 'order_already_paid', ...base } }
  }
  if (order.status === 'refunded' || order.status === 'cancelled') {
    return { status: 200, body: { received: true, status: 'ignored', reason: `order_${order.status}`, ...base } }
  }
  if (order.status === 'failed') {
    return { status: 200, body: { received: true, status: 'ignored', reason: 'order_already_failed', ...base } }
  }
  if (order.status !== 'pending') {
    return { status: 200, body: { received: true, status: 'ignored', reason: `order_${order.status}`, ...base } }
  }

  // Stale delivery: an event that predates the order cannot be its settlement.
  if (event.occurredAt.getTime() < order.createdAt.getTime() - 5 * 60 * 1000) {
    return { status: 200, body: { received: true, status: 'ignored', reason: 'stale_event', ...base } }
  }

  if (event.type === 'payment.failed') {
    await recordPayment(client, order, providerName, event, 'failed')
    await client.query(`UPDATE orders SET status = 'failed' WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`, [
      order.tenantId,
      order.id,
    ])
    await enqueueOutbox(client, order, 'order.failed', { amountMicros: event.amount.toString() })
    return { status: 200, body: { received: true, status: 'failed', ...base } }
  }

  // payment.succeeded → settle.
  const ledgerTransactionId = await postRecharge(client, order)
  const updated = await client.query(
    `UPDATE orders SET status = 'paid', paid_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
      RETURNING id`,
    [order.tenantId, order.id],
  )
  if (!updated.rows.length) {
    // A concurrent handler settled it between our lock read and update; the
    // ledger key already guarantees a single recharge.
    return { status: 200, body: { received: true, status: 'duplicate', reason: 'lost_race', ...base } }
  }

  const subscriptionActivation = await activateSubscriptionForOrder(client, order)
  await recordPayment(client, order, providerName, event, 'completed')
  await enqueueOutbox(client, order, 'order.paid', {
    amountMicros: event.amount.toString(),
    currency: order.currency,
    ledgerTransactionId,
    subscriptionActivation,
  })

  return {
    status: 200,
    body: {
      received: true,
      status: 'paid',
      ledger_transaction_id: ledgerTransactionId,
      amount_micros: event.amount.toString(),
      currency: order.currency,
      subscription_activation: subscriptionActivation,
      ...base,
    },
  }
}

/**
 * Post the recharge for a paid order.
 *   - managed_credits: debit clearing, credit the tenant wallet (funds become
 *     spendable credits). This is the ONLY kind that touches a wallet.
 *   - subscription: debit clearing, credit revenue — a plan fee is Nexus
 *     revenue, not wallet balance (ADR-0004 keeps the two modes separate).
 * Idempotent on `order_recharge:<orderId>`.
 */
async function postRecharge(client: PoolClient, order: OrderRecord): Promise<string | null> {
  if (order.amountMicros <= 0n) return null
  // The ledger's tenant lock must cover first-account bootstrap too. Two
  // different paid orders may otherwise both observe missing system accounts
  // before postTransaction takes this same lock.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [order.tenantId])
  const clearingAccountId = await ensureSystemLedgerAccount(order.tenantId, 'clearing', order.currency, client)
  const creditAccountId =
    order.kind === 'managed_credits'
      ? await ensureWalletLedgerAccount(order.tenantId, order.walletId, order.currency, client)
      : await ensureSystemLedgerAccount(order.tenantId, 'revenue', order.currency, client)

  const posted = await postTransaction(
    {
      tenantId: order.tenantId,
      type: 'recharge',
      currency: order.currency,
      idempotencyKey: orderRechargeKey(order.id),
      postings: [
        { accountId: clearingAccountId, amount: order.amountMicros, entryType: 'debit' },
        { accountId: creditAccountId, amount: order.amountMicros, entryType: 'credit' },
      ],
      referenceType: 'order',
      referenceId: order.id,
      description: order.kind === 'managed_credits' ? 'managed credit purchase' : 'subscription payment',
    },
    client,
  )
  return posted.id
}

async function recordPayment(
  client: PoolClient,
  order: OrderRecord,
  providerName: string,
  event: VerifiedPaymentEvent,
  status: 'completed' | 'failed',
): Promise<void> {
  await client.query(
    `INSERT INTO payments (id, tenant_id, order_id, payment_provider, external_payment_id, amount, currency,
                           status, idempotency_key, metadata, completed_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
    [
      order.tenantId,
      order.id,
      providerName,
      event.eventId,
      event.amount.toString(),
      event.currency,
      status,
      paymentEventKey(providerName, event.eventId),
      JSON.stringify({ eventType: event.type, occurredAt: event.occurredAt.toISOString(), raw: event.raw }),
      status === 'completed' ? event.occurredAt : null,
    ],
  )
}

async function enqueueOutbox(
  client: PoolClient,
  order: OrderRecord,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (id, tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key)
     VALUES (gen_random_uuid(), $1, 'order', $2, $3, $4::jsonb, $5)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
    [
      order.tenantId,
      order.id,
      eventType,
      JSON.stringify({ orderId: order.id, tenantId: order.tenantId, kind: order.kind, ...payload }),
      orderOutboxKey(order.id, eventType.replace('order.', '')),
    ],
  )
}

/**
 * Map an order/payment error code to the public API error type (G4 alignment
 * with docs/contracts/api-errors.md). The webhook surface is an external callback,
 * but it still returns the contracted error shape so a client correlating a
 * webhook failure with a support ticket sees the same structure.
 */
function errorTypeFor(code: string): string {
  if (code === 'internal_error') return 'service_unavailable_error'
  if (code === 'unauthorized' || code === 'invalid_signature') return 'authentication_error'
  if (code === 'order_not_found' || code === 'malformed_event' || code === 'amount_mismatch')
    return 'invalid_request_error'
  return 'invalid_request_error'
}

function errorResponse(status: number, code: string, message: string, ids?: { requestId: string }): Response {
  const res = Response.json(
    {
      error: {
        code,
        message,
        type: errorTypeFor(code),
        param: null,
        request_id: ids?.requestId ?? '',
      },
    },
    { status },
  )
  if (ids) stampHeaders(res, ids)
  return res
}

/** Stamp request-id + security headers on a webhook response. */
function stampHeaders(res: Response, ids: { requestId: string }): void {
  res.headers.set(REQUEST_ID_HEADER, ids.requestId)
  applySecurityHeaders(res.headers)
}
