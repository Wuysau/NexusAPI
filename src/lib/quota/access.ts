import { AuthzError, type Role } from '@/lib/auth/capabilities'

export interface QuotaAccessDatabase {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
}
export interface QuotaAccessContext {
  tenantId: string
  organizationId: string
  session: { userId: string }
}
export interface QuotaAccessOptions {
  write?: boolean
  lock?: boolean
}
export interface QuotaConnection {
  id: string
  tenant_id: string
  owner_user_id: string | null
  project_id: string | null
  provider: string
  mode: string
  status: string
  revoked_at: Date | null
  role: Role
}
export interface QuotaProject {
  id: string
  tenant_id: string
  organization_id: string
  name: string
  role: Role
}
const notFound = (): never => {
  throw new AuthzError('tenant_isolation', 'Not found', 404)
}
const privileged = (role: Role) => ['owner', 'admin', 'billing'].includes(role)

async function organizationRole(
  client: QuotaAccessDatabase,
  ctx: QuotaAccessContext,
  options: QuotaAccessOptions,
): Promise<Role> {
  const row = (
    await client.query<{ role: Role }>(
      `SELECT m.role FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id AND o.tenant_id=m.tenant_id
     WHERE m.user_id=$1 AND m.tenant_id=$2 AND m.organization_id=$3 AND o.status='active' AND o.deleted_at IS NULL${options.lock ? ' FOR SHARE OF m,o' : ''}`,
      [ctx.session.userId, ctx.tenantId, ctx.organizationId],
    )
  ).rows[0]
  if (!row || !['owner', 'admin', 'billing', 'developer', 'viewer'].includes(row.role)) notFound()
  if (options.write && !['owner', 'admin', 'developer'].includes(row.role)) notFound()
  return row.role
}

async function currentProject(
  client: QuotaAccessDatabase,
  ctx: QuotaAccessContext,
  id: string,
  role: Role,
  options: QuotaAccessOptions,
): Promise<QuotaProject> {
  const row = (
    await client.query<Omit<QuotaProject, 'role'>>(
      `SELECT id,tenant_id,organization_id,name FROM projects WHERE id=$1 AND tenant_id=$2 AND organization_id=$3
     AND status='active' AND archived_at IS NULL${options.lock ? ' FOR SHARE' : ''}`,
      [id, ctx.tenantId, ctx.organizationId],
    )
  ).rows[0]
  if (!row) notFound()
  if (!privileged(role)) {
    const membership = await client.query(
      `SELECT id FROM project_memberships WHERE project_id=$1 AND tenant_id=$2 AND user_id=$3${options.lock ? ' FOR SHARE' : ''}`,
      [id, ctx.tenantId, ctx.session.userId],
    )
    if (!membership.rows.length) notFound()
  }
  return { ...row, role }
}

/** Locking callers must use one transaction for authorization, observation and audit. */
export async function resolveQuotaConnection(
  client: QuotaAccessDatabase,
  ctx: QuotaAccessContext,
  id: string,
  options: QuotaAccessOptions = {},
): Promise<QuotaConnection> {
  // Connection first: revocation takes the same first lock before changing its binding/state.
  const connection = (
    await client.query<Omit<QuotaConnection, 'role'>>(
      `SELECT id,tenant_id,owner_user_id,project_id,provider,mode,status,revoked_at FROM owned_connections
     WHERE id=$1 AND tenant_id=$2${options.lock ? ' FOR UPDATE' : ''}`,
      [id, ctx.tenantId],
    )
  ).rows[0]
  if (!connection || connection.revoked_at || ['revoked', 'expired', 'blocked'].includes(connection.status)) notFound()
  const role = await organizationRole(client, ctx, options)
  if (connection.project_id) await currentProject(client, ctx, connection.project_id, role, options)
  else if (!privileged(role) && connection.owner_user_id !== ctx.session.userId) notFound()
  return { ...connection, role }
}

/** Current quota binding authorization; deleted historical Projects never grant quota access. */
export async function resolveQuotaProject(
  client: QuotaAccessDatabase,
  ctx: QuotaAccessContext,
  id: string,
  options: QuotaAccessOptions = {},
): Promise<QuotaProject> {
  const role = await organizationRole(client, ctx, options)
  return currentProject(client, ctx, id, role, options)
}
