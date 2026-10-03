import type { PoolClient } from 'pg'
import { AuthzError, hasCapability, type Role } from '@/lib/auth/capabilities'
import type { QuotaAccessDatabase } from '@/lib/quota/access'
import { apiError, routeError } from '@/app/api/_lib/control-plane'
import { normalizeWorkspace } from '@/lib/observer/workspace'
import type { ControlPlaneContext } from '@/app/api/_lib/control-plane'

export const privilegedWorkspace = (ctx: ControlPlaneContext) =>
  ['owner', 'admin', 'billing'].includes(ctx.membership.role)
export const workspaceParams = (ctx: ControlPlaneContext) => [
  ctx.tenantId,
  ctx.organizationId,
  ctx.session.userId,
  privilegedWorkspace(ctx),
]
export const projectVisibility = `(p.tenant_id=$1 AND p.organization_id=$2 AND ($4::boolean OR EXISTS
  (SELECT 1 FROM project_memberships access WHERE access.tenant_id=$1 AND access.project_id=p.id AND access.user_id=$3)))`
export const connectionVisibility = `(c.tenant_id=$1 AND (
  (c.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM projects p WHERE p.id=c.project_id AND ${projectVisibility}))
  OR (c.project_id IS NULL AND ($4::boolean OR c.owner_user_id=$3))))`
export const observedVisibility = `(e.tenant_id=$1 AND e.organization_id=$2 AND ($4::boolean OR EXISTS
  (SELECT 1 FROM project_memberships access WHERE access.tenant_id=$1 AND access.project_id=e.project_id AND access.user_id=$3)))`

/** Current workspace authority; locking callers must keep one transaction through the mutation. */
export async function resolveWorkspaceRole(
  db: QuotaAccessDatabase,
  ctx: ControlPlaneContext,
  write = false,
): Promise<Role> {
  const actor = await db.query<{ role: Role }>(
    `SELECT m.role FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id AND o.tenant_id=m.tenant_id
     WHERE m.tenant_id=$1 AND m.organization_id=$2 AND m.user_id=$3 AND o.status='active' AND o.deleted_at IS NULL${write ? ' FOR SHARE OF m,o' : ''}`,
    [ctx.tenantId, ctx.organizationId, ctx.session.userId],
  )
  const role = actor.rows[0]?.role
  if (!role || !hasCapability(role, write ? 'project:update' : 'project:read'))
    throw new AuthzError('tenant_isolation', '项目不存在')
  return role
}

/** Management can inspect/recover archived projects; quota access remains active-only. */
export async function resolveManagedProject(
  db: QuotaAccessDatabase,
  ctx: ControlPlaneContext,
  id: string,
  write = false,
): Promise<Role> {
  const role = await resolveWorkspaceRole(db, ctx, write)
  const project = await db.query(`SELECT p.id FROM projects p WHERE ${projectVisibility} AND p.id=$5`, [
    ctx.tenantId,
    ctx.organizationId,
    ctx.session.userId,
    ['owner', 'admin', 'billing'].includes(role),
    id,
  ])
  if (!project.rows.length) throw new AuthzError('tenant_isolation', '项目不存在')
  return role
}

export function parseRoots(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  try {
    if (!Array.isArray(value) || value.length > 20 || value.some((v) => typeof v !== 'string')) throw new Error()
    return [...new Set(value.map((v: string) => normalizeWorkspace(v.trim())))]
  } catch {
    throw new WorkspaceError('invalid_workspace_roots', '工作目录须为绝对路径，最多 20 个', 400)
  }
}
export async function replaceRoots(client: PoolClient, ctx: ControlPlaneContext, projectId: string, roots: string[]) {
  await client.query(
    'DELETE FROM project_workspace_roots WHERE tenant_id=$1 AND organization_id=$2 AND project_id=$3',
    [ctx.tenantId, ctx.organizationId, projectId],
  )
  for (const root of roots)
    await client.query(
      'INSERT INTO project_workspace_roots(tenant_id,organization_id,project_id,root) VALUES($1,$2,$3,$4)',
      [ctx.tenantId, ctx.organizationId, projectId, root],
    )
}
export class WorkspaceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message)
  }
}
export function workspaceRouteError(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
    return apiError(409, 'workspace_conflict', '该工作目录已属于其他项目，请选择不同目录')
  if (error instanceof WorkspaceError) return apiError(error.status, error.code, error.message)
  return routeError(error)
}
