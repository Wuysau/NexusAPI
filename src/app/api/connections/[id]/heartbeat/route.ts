import { pool } from '@/db'
import { connectionVisibility, workspaceParams } from '@/lib/workspace/management'
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
    const ctx = await requireContext(req, 'credential:create')
    const { id } = await params
    const connection = await pool.query(
      `SELECT c.mode FROM owned_connections c WHERE ${connectionVisibility} AND c.id=$5 AND c.revoked_at IS NULL`,
      [...workspaceParams(ctx), id],
    )
    if (!connection.rows[0]) return apiError(404, 'not_found', '连接不存在或已撤销')
    if (connection.rows[0]?.mode === 'local_sidecar')
      return apiError(403, 'connector_identity_required', '本地连接器心跳必须使用独立连接器身份和租约接口')
    const body = await readJsonBody<{ status?: unknown; capabilities?: unknown }>(req)
    const status = typeof body?.status === 'string' ? body.status : 'healthy'
    const result = await pool.query(
      `UPDATE owned_connections c SET status=$6,last_heartbeat_at=now(),updated_at=now(),capabilities=CASE WHEN $7::jsonb='{}'::jsonb THEN c.capabilities ELSE $7::jsonb END WHERE ${connectionVisibility} AND c.id=$5 AND c.revoked_at IS NULL AND c.mode<>'local_sidecar' RETURNING c.id,c.status,c.last_heartbeat_at`,
      [...workspaceParams(ctx), id, status, JSON.stringify(body?.capabilities ?? {})],
    )
    if (!result.rows[0]) return apiError(404, 'not_found', '连接不存在或已撤销')
    await auditControlPlane(ctx, 'connection.heartbeat', { type: 'connection', id }, { status })
    return jsonOk({ connection: result.rows[0] })
  } catch (error) {
    return routeError(error)
  }
}
