import { pool } from '@/db'
import { connectionVisibility, resolveManagedProject, workspaceParams } from '@/lib/workspace/management'
import {
  apiError,
  auditControlPlane,
  jsonOk,
  readJsonBody,
  requireContext,
  routeError,
} from '../../../_lib/control-plane'
export const dynamic = 'force-dynamic'
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(req, 'project:read')
    const { id } = await params
    const body = await readJsonBody<{ connectionId?: unknown; operation?: unknown; model?: unknown }>(req)
    const connectionId = typeof body?.connectionId === 'string' ? body.connectionId : ''
    const operation = typeof body?.operation === 'string' ? body.operation : 'chat'
    if (!connectionId) return apiError(400, 'invalid_request', '请选择连接')
    await resolveManagedProject(pool, ctx, id)
    const project = await pool.query(`SELECT id FROM projects WHERE id=$1 AND tenant_id=$2 AND archived_at IS NULL`, [
      id,
      ctx.tenantId,
    ])
    if (!project.rows[0]) return apiError(404, 'not_found', '项目不存在')
    const connection = await pool.query(
      `SELECT c.id,c.provider,c.mode,c.status,c.capabilities,c.revoked_at,c.last_heartbeat_at
       FROM owned_connections c WHERE ${connectionVisibility} AND c.id=$5`,
      [...workspaceParams(ctx), connectionId],
    )
    if (!connection.rows[0]) return apiError(404, 'not_found', '连接不存在')
    const c = connection.rows[0]
    const denied = c.revoked_at || c.status === 'revoked'
    const allowed =
      !denied && (Array.isArray(c.capabilities?.operations) ? c.capabilities.operations.includes(operation) : true)
    const decision = allowed
      ? { allowed: true }
      : { allowed: false, reason: denied ? 'connection_revoked' : 'operation_not_supported' }
    await auditControlPlane(
      ctx,
      'policy.previewed',
      { type: 'project', id },
      { connectionId, operation, model: typeof body?.model === 'string' ? body.model : null, decision },
    )
    return jsonOk({
      projectId: id,
      connection: { id: c.id, provider: c.provider, mode: c.mode, status: c.status },
      decision,
      alternatives: allowed ? [] : ['Select an active connection with the requested capability'],
    })
  } catch (error) {
    return routeError(error)
  }
}
