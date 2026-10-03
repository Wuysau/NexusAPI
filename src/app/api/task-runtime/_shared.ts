import { pool } from '@/db'
import type { PoolClient } from 'pg'
import { requireContext, routeError, apiError, type ControlPlaneContext } from '../_lib/control-plane'
import { resolveQuotaProject } from '@/lib/quota/access'
import { TaskRuntimeError } from '@/lib/task-runtime/configuration'
import type { TaskScope } from '@/lib/task-runtime/store'
import { RoutingPolicyError } from '@/lib/task-runtime/router'

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
): Promise<{ ctx: ControlPlaneContext; scope: TaskScope }> {
  const ctx = await requireContext(req, write ? 'project:update' : 'project:read')
  if (typeof projectId !== 'string' || !projectId || projectId.length > 128)
    throw new TaskRuntimeError('project_required')
  await resolveQuotaProject(pool, ctx, projectId, { write })
  return { ctx, scope: { tenantId: ctx.tenantId, organizationId: ctx.organizationId, projectId } }
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
  write: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  let discardClient = false
  try {
    await client.query('BEGIN')
    await resolveQuotaProject(client, ctx, scope.projectId, { write: true, lock: true })
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
