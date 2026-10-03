import { pool } from '@/db'
import type { PoolClient } from 'pg'
import type { Role } from '@/lib/auth/capabilities'
import { requireContext, routeError, apiError, type ControlPlaneContext } from '../_lib/control-plane'
import { resolveQuotaProject, type QuotaAccessDatabase } from '@/lib/quota/access'
import { TaskRuntimeError } from '@/lib/task-runtime/configuration'
import type { TaskScope } from '@/lib/task-runtime/store'
import { RoutingPolicyError, type RoutingPolicy } from '@/lib/task-runtime/router'
import { connectionVisibility } from '@/lib/workspace/management'

export function taskError(error: unknown) {
  if (error instanceof TaskRuntimeError)
    return apiError(error.status, error.code, '任务操作未完成，请检查配置、权限和当前状态')
  if (error instanceof RoutingPolicyError) return apiError(400, 'invalid_routing_policy', '资源策略参数无效')
  return routeError(error)
}
export async function projectScope(
  req: Request,
  projectId: unknown,
  write = false,
): Promise<{ ctx: ControlPlaneContext; scope: TaskScope; role: Role }> {
  const ctx = await requireContext(req, write ? 'project:update' : 'project:read')
  if (typeof projectId !== 'string' || !projectId || projectId.length > 128)
    throw new TaskRuntimeError('project_required')
  const currentProject = await resolveQuotaProject(pool, ctx, projectId, { write })
  return {
    ctx,
    scope: { tenantId: ctx.tenantId, organizationId: ctx.organizationId, projectId },
    role: currentProject.role,
  }
}
export async function taskScope(req: Request, id: string) {
  const ctx = await requireContext(req, 'project:update')
  const row = (
    await pool.query('SELECT project_id FROM nexus_tasks WHERE tenant_id=$1 AND organization_id=$2 AND id=$3', [
      ctx.tenantId,
      ctx.organizationId,
      id,
    ])
  ).rows[0]
  if (!row) throw new TaskRuntimeError('task_not_found', 404)
  await resolveQuotaProject(pool, ctx, row.project_id, { write: true })
  return {
    ctx,
    scope: { tenantId: ctx.tenantId, organizationId: ctx.organizationId, projectId: row.project_id } as TaskScope,
  }
}

/** Keep current project authority locked through a Control Plane write. */
export async function withProjectWrite<T>(
  ctx: ControlPlaneContext,
  scope: TaskScope,
  write: (client: PoolClient, role: Role) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  let discardClient = false
  try {
    await client.query('BEGIN')
    const currentProject = await resolveQuotaProject(client, ctx, scope.projectId, { write: true, lock: true })
    const result = await write(client, currentProject.role)
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

/** HTTP resource visibility; local execution retains its independent profile authority. */
export async function visibleTaskPolicy(
  db: QuotaAccessDatabase,
  ctx: ControlPlaneContext,
  currentRole: Role,
  policy: RoutingPolicy,
): Promise<RoutingPolicy> {
  if (!policy.candidates.length) return policy
  const visible = await db.query<{ id: string }>(
    `SELECT c.id FROM owned_connections c WHERE ${connectionVisibility} AND c.id=ANY($5::text[])`,
    [
      ctx.tenantId,
      ctx.organizationId,
      ctx.session.userId,
      ['owner', 'admin', 'billing'].includes(currentRole),
      policy.candidates.map((candidate) => candidate.connectionId),
    ],
  )
  const ids = new Set(visible.rows.map((connection) => connection.id))
  return { ...policy, candidates: policy.candidates.filter((candidate) => ids.has(candidate.connectionId)) }
}
