import { pool } from '@/db'
import type { PoolClient } from 'pg'
import type { ControlPlaneContext } from '@/app/api/_lib/control-plane'
import { AuthzError, hasCapability, type Role } from '@/lib/auth/capabilities'

const notFound = (): never => {
  throw new AuthzError('not_found', '密钥不存在或已撤销', 404)
}

/** Keep one transaction through the mutation; management includes archived projects. */
export async function lockManagedApiKey(client: PoolClient, ctx: ControlPlaneContext, id: string): Promise<void> {
  const key = (
    await client.query<{ project_id: string | null; created_by: string | null }>(
      `SELECT project_id,created_by FROM downstream_api_keys
       WHERE id=$1 AND tenant_id=$2 AND organization_id=$3 AND deleted_at IS NULL FOR UPDATE`,
      [id, ctx.tenantId, ctx.organizationId],
    )
  ).rows[0]
  if (!key) notFound()

  // Match Project writes (project first), then membership writes (organization first).
  if (key.project_id) {
    const project = await client.query(
      'SELECT id FROM projects WHERE id=$1 AND tenant_id=$2 AND organization_id=$3 FOR SHARE',
      [key.project_id, ctx.tenantId, ctx.organizationId],
    )
    if (!project.rows.length) notFound()
  }
  const organization = await client.query(
    `SELECT id FROM organizations WHERE id=$1 AND tenant_id=$2 AND status='active' AND deleted_at IS NULL FOR SHARE`,
    [ctx.organizationId, ctx.tenantId],
  )
  if (!organization.rows.length) notFound()
  const member = (
    await client.query<{ role: Role }>(
      'SELECT role FROM organization_memberships WHERE organization_id=$1 AND tenant_id=$2 AND user_id=$3 FOR SHARE',
      [ctx.organizationId, ctx.tenantId, ctx.session.userId],
    )
  ).rows[0]
  if (!member || !hasCapability(member.role, 'apikey:revoke')) throw new AuthzError('forbidden', '没有执行此操作的权限')
  if (['owner', 'admin'].includes(member.role)) return
  if (!key.project_id) {
    if (key.created_by !== ctx.session.userId) notFound()
    return
  }
  const membership = await client.query(
    'SELECT id FROM project_memberships WHERE project_id=$1 AND tenant_id=$2 AND user_id=$3 FOR SHARE',
    [key.project_id, ctx.tenantId, ctx.session.userId],
  )
  if (!membership.rows.length) notFound()
}

export async function withManagedApiKeyWrite<T>(
  ctx: ControlPlaneContext,
  id: string,
  write: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  let discardClient = false
  try {
    await client.query('BEGIN')
    await lockManagedApiKey(client, ctx, id)
    const result = await write(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      discardClient = true
    }
    throw error
  } finally {
    client.release(discardClient)
  }
}
