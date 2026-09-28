import { pool } from '@/db'
import { AuthzError } from '@/lib/auth/capabilities'
import { resolveQuotaProject } from '@/lib/quota/access'
import { connectionVisibility, privilegedWorkspace, workspaceParams } from '@/lib/workspace/management'
import {
  apiError,
  auditControlPlane,
  jsonOk,
  readJsonBody,
  requireContext,
  routeError,
} from '../../../_lib/control-plane'

export const dynamic = 'force-dynamic'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(req, 'project:update')
    const body = await readJsonBody<Record<string, unknown>>(req)
    if (
      !body ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !Object.hasOwn(body, 'projectId') ||
      (body.projectId !== null &&
        (typeof body.projectId !== 'string' || !body.projectId.trim() || body.projectId.length > 128))
    )
      return apiError(400, 'invalid_project', '请选择有效的项目或取消绑定')
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : null
    const { id } = await params
    const client = await pool.connect()
    let previousProjectId: string | null
    try {
      await client.query('BEGIN')
      const current = (
        await client.query<{ id: string; owner_user_id: string | null; project_id: string | null }>(
          `SELECT c.id,c.owner_user_id,c.project_id FROM owned_connections c
           WHERE ${connectionVisibility} AND c.id=$5 AND c.revoked_at IS NULL FOR UPDATE OF c`,
          [...workspaceParams(ctx), id],
        )
      ).rows[0]
      if (!current || (current.owner_user_id !== ctx.session.userId && !privilegedWorkspace(ctx)))
        throw new AuthzError('tenant_isolation', '连接不存在或已撤销', 404)
      previousProjectId = current.project_id
      if (projectId) await resolveQuotaProject(client, ctx, projectId, { write: true, lock: true })
      await client.query('UPDATE owned_connections SET project_id=$1,updated_at=now() WHERE id=$2 AND tenant_id=$3', [
        projectId,
        id,
        ctx.tenantId,
      ])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    await auditControlPlane(
      ctx,
      'connection.project_updated',
      { type: 'connection', id },
      { previousProjectId, projectId },
    )
    return jsonOk({ connection: { id, projectId } })
  } catch (error) {
    return routeError(error)
  }
}
