import type { PoolClient } from 'pg'
import { pool } from '@/db'
import { AuthzError, hasCapability, type Capability, type Role } from '@/lib/auth/capabilities'
import type { ControlPlaneContext } from '@/app/api/_lib/control-plane'
import { WorkspaceError } from './management'

export const organizationRoles = ['owner', 'admin', 'billing', 'developer', 'viewer'] as const
export function parseMemberRole(value: unknown): Role {
  if (typeof value !== 'string' || !organizationRoles.includes(value as (typeof organizationRoles)[number]))
    throw new WorkspaceError('invalid_role', '请选择有效的组织角色', 400)
  return value as Role
}

// Serialize membership mutations and recheck authority after acquiring the lock.
export async function withOrganizationAdmin<T>(
  ctx: ControlPlaneContext,
  capability: Capability,
  action: (client: PoolClient, role: Role) => Promise<T>,
) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const org = await client.query(
      `SELECT id FROM organizations WHERE id=$1 AND tenant_id=$2 AND status='active' AND deleted_at IS NULL FOR UPDATE`,
      [ctx.organizationId, ctx.tenantId],
    )
    if (!org.rows.length) throw new AuthzError('tenant_isolation', '组织不存在')
    const actor = await client.query<{ role: Role }>(
      'SELECT role FROM organization_memberships WHERE organization_id=$1 AND tenant_id=$2 AND user_id=$3',
      [ctx.organizationId, ctx.tenantId, ctx.session.userId],
    )
    const role = actor.rows[0]?.role
    if (!role || !hasCapability(role, capability)) throw new AuthzError('forbidden', '没有执行此操作的权限')
    const result = await action(client, role)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export function assertOwnerAuthority(actor: Role, ...roles: (string | undefined)[]) {
  if (actor !== 'owner' && roles.includes('owner')) throw new AuthzError('forbidden', '只有所有者可以管理所有者角色')
}

export async function changeMember(ctx: ControlPlaneContext, id: string, role?: Role) {
  return withOrganizationAdmin(ctx, role ? 'member:update-role' : 'member:remove', async (client, actor) => {
    const result = await client.query<{ user_id: string; role: string }>(
      'SELECT user_id,role FROM organization_memberships WHERE id=$1 AND organization_id=$2 AND tenant_id=$3 FOR UPDATE',
      [id, ctx.organizationId, ctx.tenantId],
    )
    const member = result.rows[0]
    if (!member) throw new WorkspaceError('not_found', '成员不存在', 404)
    if (member.user_id === ctx.session.userId)
      throw new WorkspaceError('self_change', '不能修改自己的角色或移除自己', 409)
    assertOwnerAuthority(actor, member.role, role)
    if (member.role === 'owner' && role !== 'owner') {
      const owners = await client.query<{ count: string }>(
        `SELECT count(*)::text count FROM organization_memberships WHERE organization_id=$1 AND tenant_id=$2 AND role='owner'`,
        [ctx.organizationId, ctx.tenantId],
      )
      if (BigInt(owners.rows[0].count) <= 1n) throw new WorkspaceError('last_owner', '组织必须至少保留一名所有者', 409)
    }
    if (role) {
      await client.query(
        'UPDATE organization_memberships SET role=$4 WHERE id=$1 AND organization_id=$2 AND tenant_id=$3',
        [id, ctx.organizationId, ctx.tenantId, role],
      )
    } else {
      await client.query(
        `DELETE FROM project_memberships pm USING projects p
        WHERE pm.project_id=p.id AND pm.tenant_id=$1 AND p.tenant_id=$1 AND p.organization_id=$2 AND pm.user_id=$3`,
        [ctx.tenantId, ctx.organizationId, member.user_id],
      )
      await client.query('DELETE FROM organization_memberships WHERE id=$1 AND organization_id=$2 AND tenant_id=$3', [
        id,
        ctx.organizationId,
        ctx.tenantId,
      ])
    }
    return { from: member.role, to: role ?? null }
  })
}
