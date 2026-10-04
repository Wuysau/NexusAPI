import { pool } from '@/db'
import type { PoolClient } from 'pg'
import type { ControlPlaneContext } from '@/app/api/_lib/control-plane'
import { AuthzError, hasCapability, type Role } from '@/lib/auth/capabilities'

const notFound = (): never => {
  throw new AuthzError('not_found', '密钥不存在或已撤销', 404)
}

function requireUnexpiredSession(expiresAt: Date): void {
  if (expiresAt.getTime() <= Date.now()) throw new AuthzError('unauthenticated', '请先登录')
}

/** Lock user, then current session before resource locks; retain both through commit. */
async function lockActiveKeyActorAndSession(client: PoolClient, ctx: ControlPlaneContext): Promise<Date> {
  const actor = await client.query(
    "SELECT id FROM users WHERE id=$1 AND status='active' AND deleted_at IS NULL FOR SHARE",
    [ctx.session.userId],
  )
  if (!actor.rows.length) throw new AuthzError('unauthenticated', '请先登录')
  const session = (
    await client.query<{ expires_at: Date }>(
      'SELECT expires_at FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL FOR SHARE',
      [ctx.session.id, ctx.session.userId],
    )
  ).rows[0]
  if (!session) throw new AuthzError('unauthenticated', '请先登录')
  requireUnexpiredSession(session.expires_at)
  return session.expires_at
}

async function lockKeyAuthority(
  client: PoolClient,
  ctx: ControlPlaneContext,
  projectId: string | null,
  capability: 'apikey:create' | 'apikey:revoke',
): Promise<Role> {
  const missing = (): never => {
    if (capability === 'apikey:create') throw new AuthzError('tenant_isolation', '项目不存在')
    return notFound()
  }
  let archived = false
  // Match Project writes (project first), then membership writes (organization first).
  if (projectId) {
    const project = (
      await client.query<{ archived_at: Date | null }>(
        'SELECT archived_at FROM projects WHERE id=$1 AND tenant_id=$2 AND organization_id=$3 FOR SHARE',
        [projectId, ctx.tenantId, ctx.organizationId],
      )
    ).rows[0]
    if (!project) missing()
    archived = project.archived_at !== null
  }
  const organization = await client.query(
    `SELECT id FROM organizations WHERE id=$1 AND tenant_id=$2 AND status='active' AND deleted_at IS NULL FOR SHARE`,
    [ctx.organizationId, ctx.tenantId],
  )
  if (!organization.rows.length) missing()
  const member = (
    await client.query<{ role: Role }>(
      'SELECT role FROM organization_memberships WHERE organization_id=$1 AND tenant_id=$2 AND user_id=$3 FOR SHARE',
      [ctx.organizationId, ctx.tenantId, ctx.session.userId],
    )
  ).rows[0]
  if (!member || !hasCapability(member.role, capability)) throw new AuthzError('forbidden', '没有执行此操作的权限')
  if (projectId && !['owner', 'admin'].includes(member.role)) {
    const membership = await client.query(
      'SELECT id FROM project_memberships WHERE project_id=$1 AND tenant_id=$2 AND user_id=$3 FOR SHARE',
      [projectId, ctx.tenantId, ctx.session.userId],
    )
    if (!membership.rows.length) missing()
  }
  // Check archive eligibility only after resource visibility; management permits recovery.
  if (capability === 'apikey:create' && archived) throw new AuthzError('project_not_found', '项目不存在', 404)
  return member.role
}

/** Creation uses the existing issuance transaction; inactive unarchived behavior is retained. */
export async function lockApiKeyCreation(
  client: PoolClient,
  ctx: ControlPlaneContext,
  projectId: string | null,
): Promise<void> {
  const expiresAt = await lockActiveKeyActorAndSession(client, ctx)
  await lockKeyAuthority(client, ctx, projectId, 'apikey:create')
  requireUnexpiredSession(expiresAt)
}

/** Keep one transaction through the mutation; management includes archived projects. */
export async function lockManagedApiKey(client: PoolClient, ctx: ControlPlaneContext, id: string): Promise<void> {
  const expiresAt = await lockActiveKeyActorAndSession(client, ctx)
  const key = (
    await client.query<{ project_id: string | null; created_by: string | null }>(
      `SELECT project_id,created_by FROM downstream_api_keys
       WHERE id=$1 AND tenant_id=$2 AND organization_id=$3 AND deleted_at IS NULL FOR UPDATE`,
      [id, ctx.tenantId, ctx.organizationId],
    )
  ).rows[0]
  if (!key) notFound()
  const role = await lockKeyAuthority(client, ctx, key.project_id, 'apikey:revoke')
  if (!key.project_id && !['owner', 'admin'].includes(role) && key.created_by !== ctx.session.userId) notFound()
  requireUnexpiredSession(expiresAt)
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
