import { pool } from '@/db'
import { AuthzError } from '@/lib/auth/capabilities'
import { connectionVisibility, workspaceParams } from '@/lib/workspace/management'
import { auditControlPlane, jsonOk, requireHighRiskContext, routeError } from '../../_lib/control-plane'
export const dynamic = 'force-dynamic'
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireHighRiskContext(req, 'credential:disable')
    const { id } = await params
    const client = await pool.connect()
    let connection: { id: string; status: string; revoked_at: Date }
    try {
      await client.query('BEGIN')
      const visible = await client.query(
        `SELECT c.id FROM owned_connections c WHERE ${connectionVisibility} AND c.id=$5 AND c.revoked_at IS NULL FOR UPDATE OF c`,
        [...workspaceParams(ctx), id],
      )
      if (!visible.rows.length) throw new AuthzError('tenant_isolation', '连接不存在或已撤销', 404)
      connection = (
        await client.query(
          "UPDATE owned_connections SET status='revoked',revoked_at=now(),updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING id,status,revoked_at",
          [id, ctx.tenantId],
        )
      ).rows[0]
      await client.query(
        'UPDATE connector_leases SET revoked_at=now() WHERE connection_id=$1 AND tenant_id=$2 AND revoked_at IS NULL',
        [id, ctx.tenantId],
      )
      await client.query('UPDATE connector_identities SET revoked_at=now() WHERE connection_id=$1 AND tenant_id=$2', [
        id,
        ctx.tenantId,
      ])
      await client.query('DELETE FROM connector_pairings WHERE connection_id=$1 AND tenant_id=$2', [id, ctx.tenantId])
      await client.query(
        `UPDATE channels SET enabled=false,updated_at=now() WHERE tenant_id=$1 AND metadata->>'connection_id'=$2 AND metadata->>'transport'='local_sidecar'`,
        [ctx.tenantId, id],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    await auditControlPlane(ctx, 'connection.revoked', { type: 'connection', id })
    return jsonOk({ connection })
  } catch (error) {
    return routeError(error)
  }
}
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return PATCH(req, { params })
}
