// POST /api/internal/orders  — create an order and start a checkout
// GET  /api/internal/orders  — list a tenant's orders
//
// The console (Work Item H) calls this. Two rules are enforced here:
//   - the amount is derived server-side from the plan version. Any `amount` in
//     the request body is IGNORED (it is only tolerated so a buggy client is not
//     silently trusted). This is the amount-tampering defence.
//   - a managed_credits order is refused with 403 unless the managed_credits
//     flag is on AND the tenant's compliance record is fully approved.

import { createOrder, isOrderKind, listOrdersForTenant, type OrderKind } from '@/lib/orders'
import { isNonEmptyString, mapDomainError, ordersError, readJsonBody, requireOrdersToken } from './_shared'

export const dynamic = 'force-dynamic'

interface CreateOrderBody {
  tenant_id?: string
  kind?: string
  plan_version_id?: string
  idempotency_key?: string
  actor_user_id?: string
  provider?: string
  /** Deliberately accepted but NEVER read (amount tampering defence). */
  amount?: unknown
}

function serializeOrder(order: {
  id: string
  status: string
  kind: OrderKind
  amountMicros: bigint
  currency: string
  planVersionId: string | null
  paymentProvider: string
  externalOrderId: string | null
  createdAt: Date
  paidAt: Date | null
}) {
  return {
    id: order.id,
    status: order.status,
    kind: order.kind,
    amount_micros: order.amountMicros.toString(),
    currency: order.currency,
    plan_version_id: order.planVersionId,
    payment_provider: order.paymentProvider,
    external_order_id: order.externalOrderId,
    created_at: order.createdAt,
    paid_at: order.paidAt,
  }
}

export async function POST(req: Request): Promise<Response> {
  const denied = requireOrdersToken(req)
  if (denied) return denied

  const body = await readJsonBody<CreateOrderBody>(req)
  if (!body) return ordersError(400, 'invalid_request', 'Body must be JSON.')
  if (!isNonEmptyString(body.tenant_id)) return ordersError(400, 'invalid_request', 'tenant_id is required.')
  if (!isNonEmptyString(body.kind) || !isOrderKind(body.kind)) {
    return ordersError(400, 'invalid_request', 'kind must be subscription or managed_credits.')
  }
  if (!isNonEmptyString(body.plan_version_id)) {
    return ordersError(400, 'invalid_request', 'plan_version_id is required.')
  }
  if (!isNonEmptyString(body.idempotency_key)) {
    return ordersError(400, 'invalid_request', 'idempotency_key is required.')
  }

  try {
    const created = await createOrder({
      tenantId: body.tenant_id.trim(),
      kind: body.kind,
      planVersionId: body.plan_version_id.trim(),
      idempotencyKey: body.idempotency_key.trim(),
      actorUserId: body.actor_user_id ?? null,
      providerName: body.provider,
    })
    return Response.json(
      {
        order: serializeOrder(created.order),
        checkout: {
          provider: created.checkout.provider,
          status: created.checkout.status,
          sandbox: created.checkout.sandbox,
          external_order_id: created.checkout.externalOrderId,
          checkout_url: created.checkout.checkoutUrl,
          confirmation: created.checkout.confirmation,
        },
        replayed: created.replayed,
        // Explicit: the redirect/checkout result is not payment confirmation.
        note: 'Payment is confirmed only by a verified provider webhook.',
      },
      { status: created.replayed ? 200 : 201 },
    )
  } catch (e) {
    return mapDomainError(e)
  }
}

export async function GET(req: Request): Promise<Response> {
  const denied = requireOrdersToken(req)
  if (denied) return denied

  const url = new URL(req.url)
  const tenantId = url.searchParams.get('tenant_id')?.trim()
  if (!tenantId) return ordersError(400, 'invalid_request', 'tenant_id is required.')
  const limitRaw = Number(url.searchParams.get('limit') ?? '50')
  const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.floor(limitRaw))) : 50

  try {
    const orders = await listOrdersForTenant(tenantId, limit)
    return Response.json({ orders: orders.map(serializeOrder) })
  } catch (e) {
    return mapDomainError(e)
  }
}
