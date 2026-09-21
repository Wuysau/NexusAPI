import { getActiveSubscription, getEntitlement } from '@/lib/plans'
import { assertOwnerAuthority, parseMemberRole, withOrganizationAdmin } from '@/lib/workspace/members'
import { WorkspaceError, workspaceRouteError } from '@/lib/workspace/management'
import { apiError, auditControlPlane, jsonOk, readJsonBody, requireContext } from '../../_lib/control-plane'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const ctx = await requireContext(req, 'member:invite')
    const body = await readJsonBody<{ email?: unknown; role?: unknown }>(req)
    if (
      typeof body?.email !== 'string' ||
      body.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())
    )
      return apiError(400, 'invalid_email', '请输入有效的注册邮箱')
    const email = body.email.trim().toLowerCase()
    const role = parseMemberRole(body.role)
    const member = await withOrganizationAdmin(ctx, 'member:invite', async (client, actor) => {
      assertOwnerAuthority(actor, role)
      const user = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(email)=$1 AND status='active' AND deleted_at IS NULL`,
        [email],
      )
      if (!user.rows[0])
        throw new WorkspaceError('account_unavailable', '该邮箱没有可添加的已注册账号，请先完成注册', 404)
      const existing = await client.query('SELECT id FROM organization_memberships WHERE tenant_id=$1 AND user_id=$2', [
        ctx.tenantId,
        user.rows[0].id,
      ])
      if (existing.rows.length) throw new WorkspaceError('member_exists', '该账号已是此组织的成员', 409)
      const entitlement = await getEntitlement(ctx.tenantId, 'members', new Date(), client)
      const subscription = await getActiveSubscription(ctx.tenantId, new Date(), client)
      // Standalone workspaces already allow governance without a SaaS subscription.
      // Published subscriptions enforce actual grants and limits; never invent defaults.
      if (subscription && (!entitlement || (entitlement.kind === 'boolean' && !entitlement.booleanValue)))
        throw new WorkspaceError('entitlement_missing', '当前 Nexus 计划未开通成员席位', 403)
      if (entitlement?.kind === 'limit' && entitlement.limitValue !== null) {
        const count = await client.query<{ count: string }>(
          'SELECT count(*)::text count FROM organization_memberships WHERE tenant_id=$1',
          [ctx.tenantId],
        )
        if ((BigInt(count.rows[0].count) + 1n) * 1000000n > entitlement.limitValue)
          throw new WorkspaceError('member_limit', '当前 Nexus 计划的成员席位已用尽', 409)
      }
      return (
        await client.query(
          `INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role,created_by)
        VALUES($1,$2,$3,$4,$5) RETURNING id,role`,
          [ctx.organizationId, ctx.tenantId, user.rows[0].id, role, ctx.session.userId],
        )
      ).rows[0]
    })
    await auditControlPlane(ctx, 'member.added', { type: 'membership', id: member.id }, { role })
    return jsonOk({ member }, 201)
  } catch (error) {
    return workspaceRouteError(error)
  }
}
