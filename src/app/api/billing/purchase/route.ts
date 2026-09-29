import { createOrder, OrderError } from '@/lib/orders'
import { PaymentError, stripeConfiguration } from '@/lib/payments'
import { PlanError } from '@/lib/plans'
import { apiError, jsonOk, readJsonBody, requireContext, routeError } from '../../_lib/control-plane'

export const dynamic = 'force-dynamic'
export async function POST(req: Request) {
  try {
    const ctx = await requireContext(req, 'billing:manage')
    const body = await readJsonBody<Record<string, unknown>>(req)
    if (
      !body ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !['planVersionId', 'idempotencyKey'].includes(key)) ||
      typeof body.planVersionId !== 'string' ||
      !body.planVersionId.trim() ||
      body.planVersionId.length > 100 ||
      typeof body.idempotencyKey !== 'string' ||
      !/^[a-zA-Z0-9_-]{16,100}$/.test(body.idempotencyKey)
    )
      return apiError(400, 'invalid_request', '仅接受套餐版本与购买幂等键；价格和租户由服务器确定。', req)
    if (!stripeConfiguration().configured)
      return apiError(503, 'provider_not_configured', '管理员尚未配置 Stripe 支付。', req)
    const created = await createOrder({
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      actorUserId: ctx.principal.userId,
      kind: 'subscription',
      planVersionId: body.planVersionId,
      idempotencyKey: `browser:${body.idempotencyKey}`,
      providerName: 'stripe',
    })
    return jsonOk(
      {
        order: { id: created.order.id, status: created.order.status },
        checkout: {
          url: created.checkout.checkoutUrl,
          mode: created.checkout.mode,
          expiresAt: created.checkout.expiresAt,
          confirmation: created.checkout.confirmation,
        },
        replayed: created.replayed,
      },
      created.replayed ? 200 : 201,
      req,
    )
  } catch (error) {
    if (error instanceof PaymentError || error instanceof OrderError || error instanceof PlanError)
      return apiError(error.status, error.code, error.message, req)
    return routeError(error, req)
  }
}
