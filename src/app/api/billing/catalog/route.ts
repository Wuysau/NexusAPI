import { listPublishedPlanVersions, listEntitlements } from '@/lib/plans'
import { microsToMinorUnits, stripeConfiguration } from '@/lib/payments'
import { fromMicros } from '@/lib/money'
import { jsonOk, requireContext, routeError } from '../../_lib/control-plane'

export const dynamic = 'force-dynamic'
export async function GET(req: Request) {
  try {
    const ctx = await requireContext(req, 'billing:read')
    const payment = stripeConfiguration()
    const versions = await listPublishedPlanVersions()
    const current = new Map<string, (typeof versions)[number]>()
    for (const version of versions) {
      if (
        (version.effectiveFrom && version.effectiveFrom.getTime() > Date.now()) ||
        (version.effectiveTo && version.effectiveTo.getTime() <= Date.now())
      )
        continue
      if (!current.has(version.planId)) current.set(version.planId, version)
    }
    const plans = await Promise.all(
      [...current.values()].map(async (version) => {
        let unavailableReason: string | null = null
        try {
          microsToMinorUnits(version.priceMicros, version.currency)
        } catch {
          unavailableReason = '此价格或币种暂不支持在线支付，请联系管理员。'
        }
        return {
          id: version.id,
          code: version.planCode,
          version: version.version,
          amount: fromMicros(version.priceMicros),
          currency: version.currency,
          interval: version.billingInterval,
          purchasable: payment.configured && unavailableReason === null,
          unavailableReason,
          entitlements: (await listEntitlements(version.id)).map((entry) => ({
            key: entry.key,
            value: entry.kind === 'boolean' ? entry.booleanValue : (entry.limitValue?.toString() ?? null),
            description: entry.description,
          })),
        }
      }),
    )
    return jsonOk({ payment, canPurchase: ctx.capabilities.includes('billing:manage'), plans }, 200, req)
  } catch (error) {
    return routeError(error, req)
  }
}
