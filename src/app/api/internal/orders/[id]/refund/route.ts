// POST /api/internal/orders/[id]/refund
//
// Refunds a paid order. The ledger history is never modified: a compensating
// `refund` transaction that reverses the original recharge is posted instead
// (INVARIANT #3). A second refund of the same order is refused with 409.

import { refundOrder } from '@/lib/orders'
import { mapDomainError, ordersError, readJsonBody, requireOrdersToken } from '../../_shared'

export const dynamic = 'force-dynamic'

interface RefundBody {
  tenant_id?: string
  reason?: string
  actor_user_id?: string
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = requireOrdersToken(req)
  if (denied) return denied

  const { id } = await context.params
  const orderId = id?.trim()
  if (!orderId) return ordersError(400, 'invalid_request', 'order id is required.')

  const body = await readJsonBody<RefundBody>(req)
  if (!body) return ordersError(400, 'invalid_request', 'Body must be JSON.')
  const tenantId = body.tenant_id?.trim()
  if (!tenantId) return ordersError(400, 'invalid_request', 'tenant_id is required.')

  try {
    const refunded = await refundOrder({
      tenantId,
      orderId,
      reason: body.reason ?? '',
      actorUserId: body.actor_user_id ?? null,
    })
    return Response.json({
      order_id: refunded.orderId,
      status: refunded.status,
      amount_micros: refunded.amountMicros.toString(),
      currency: refunded.currency,
      ledger_transaction_id: refunded.ledgerTransactionId,
      refund: {
        provider: refunded.refund.provider,
        status: refunded.refund.status,
        sandbox: refunded.refund.sandbox,
        refund_id: refunded.refund.refundId,
      },
    })
  } catch (e) {
    return mapDomainError(e)
  }
}
