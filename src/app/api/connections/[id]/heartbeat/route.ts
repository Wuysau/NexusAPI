import { pool } from '@/db'
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
    const ctx = await requireContext(req, 'credential:read')
    const { id } = await params
    const connection = await pool.query('SELECT mode FROM owned_connections WHERE id=$1 AND tenant_id=$2', [
      id,
      ctx.tenantId,
    ])
    if (connection.rows[0]?.mode === 'local_sidecar')
      return apiError(403, 'connector_identity_required', '本地连接器心跳必须使用独立连接器身份和租约接口')
    const body = await readJsonBody<{ status?: unknown; capabilities?: unknown }>(req)
    const status = typeof body?.status === 'string' ? body.status : 'healthy'
    const result = await pool.query(
      `UPDATE owned_connections SET status=$3,last_heartbeat_at=now(),updated_at=now(),capabilities=CASE WHEN $4::jsonb='{}'::jsonb THEN capabilities ELSE $4::jsonb END WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL RETURNING id,status,last_heartbeat_at`,
      [id, ctx.tenantId, status, JSON.stringify(body?.capabilities ?? {})],
    )
    if (!result.rows[0]) return apiError(404, 'not_found', '连接不存在或已撤销')
    await auditControlPlane(ctx, 'connection.heartbeat', { type: 'connection', id }, { status })
    return jsonOk({ connection: result.rows[0] })
  } catch (error) {
    return routeError(error)
  }
}
