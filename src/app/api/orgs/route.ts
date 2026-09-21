// Organization, membership and plan entitlements.
//
// Plan limits are read through the active subscription (`getEntitlements`),
// never hardcoded in the UI (PRODUCT_COMMERCIAL.md). Membership changes live in
// ./members/[id].

import { pool } from '@/db'
import { hasCapability } from '@/lib/auth/capabilities'
import { getActiveSubscription, getEntitlements } from '@/lib/plans'
import { fromMicros } from '@/lib/money'
import { jsonOk, requireContext, routeError } from '../_lib/control-plane'

export const dynamic = 'force-dynamic'

interface MemberRow {
  id: string
  user_id: string
  email: string
  name: string | null
  role: string
  created_at: Date
}

export async function GET(req: Request) {
  try {
    const ctx = await requireContext(req, 'org:read')
    const members = hasCapability(ctx.membership.role, 'member:read')
      ? await pool.query<MemberRow>(
          `SELECT m.id, m.user_id, u.email, u.name, m.role, m.created_at
             FROM organization_memberships m
             JOIN users u ON u.id = m.user_id
            WHERE m.organization_id = $1 AND m.tenant_id = $2 AND u.deleted_at IS NULL
            ORDER BY m.created_at ASC`,
          [ctx.organizationId, ctx.tenantId],
        )
      : { rows: [] as MemberRow[] }

    const subscription = await getActiveSubscription(ctx.tenantId)
    const entitlements = await getEntitlements(ctx.tenantId)

    return jsonOk({
      organization: {
        id: ctx.organizationId,
        tenantId: ctx.tenantId,
        name: ctx.membership.organizationName,
        slug: ctx.membership.organizationSlug,
      },
      members: members.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        email: row.email,
        name: row.name,
        role: row.role,
        createdAt: row.created_at.toISOString(),
        isSelf: row.user_id === ctx.principal.userId,
      })),
      subscription: subscription
        ? {
            id: subscription.id,
            planCode: subscription.planCode,
            planVersion: subscription.planVersion,
            status: subscription.status,
            effectiveFrom: subscription.effectiveFrom.toISOString(),
            currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          }
        : null,
      entitlements: entitlements.map((e) => ({
        key: e.key,
        kind: e.kind,
        limit: e.limitValue === null ? null : fromMicros(e.limitValue),
        boolean: e.booleanValue,
        description: e.description,
      })),
    })
  } catch (error) {
    return routeError(error)
  }
}
