import { pool } from '@/db'
import {
  parseRoots,
  replaceRoots,
  resolveManagedProject,
  WorkspaceError,
  workspaceRouteError,
} from '@/lib/workspace/management'
import { apiError, auditControlPlane, jsonOk, readJsonBody, requireContext, routeError } from '../../_lib/control-plane'

export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(req, 'project:read')
    const { id } = await params
    await resolveManagedProject(pool, ctx, id)
    const result = await pool.query(
      'SELECT id,name,status,policy_version,created_at,updated_at FROM projects WHERE id=$1 AND tenant_id=$2 AND organization_id=$3',
      [id, ctx.tenantId, ctx.organizationId],
    )
    if (!result.rows[0]) return apiError(404, 'not_found', '项目不存在')
    const [members, connections, roots] = await Promise.all([
      pool.query(
        'SELECT pm.user_id,pm.role,u.email FROM project_memberships pm JOIN users u ON u.id=pm.user_id WHERE pm.project_id=$1 AND pm.tenant_id=$2',
        [id, ctx.tenantId],
      ),
      pool.query(
        'SELECT id,provider,mode,status,credential_fingerprint,last_heartbeat_at,revoked_at FROM owned_connections WHERE project_id=$1 AND tenant_id=$2',
        [id, ctx.tenantId],
      ),
      pool.query(
        'SELECT root FROM project_workspace_roots WHERE project_id=$1 AND tenant_id=$2 AND organization_id=$3 ORDER BY root',
        [id, ctx.tenantId, ctx.organizationId],
      ),
    ])
    return jsonOk({
      project: { ...result.rows[0], workspaceRoots: roots.rows.map((r) => r.root) },
      members: members.rows,
      connections: connections.rows,
    })
  } catch (error) {
    return routeError(error)
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(req, 'project:update')
    const { id } = await params
    const body = await readJsonBody<{
      name?: unknown
      expectedVersion?: unknown
      archived?: unknown
      workspaceRoots?: unknown
    }>(req)
    if (!body || (body.name === undefined && body.workspaceRoots === undefined && body.archived === undefined))
      return apiError(400, 'invalid_request', '没有可更新的字段')
    if (
      body.name !== undefined &&
      (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120)
    )
      return apiError(400, 'invalid_name', '项目名称不能为空且不超过 120 个字符')
    if (
      body.expectedVersion !== undefined &&
      (typeof body.expectedVersion !== 'number' ||
        !Number.isSafeInteger(body.expectedVersion) ||
        body.expectedVersion < 1 ||
        body.expectedVersion > 2147483647)
    )
      return apiError(400, 'invalid_version', '项目版本无效')
    if (body.archived !== undefined && typeof body.archived !== 'boolean')
      return apiError(400, 'invalid_request', '归档参数无效')
    const roots = parseRoots(body.workspaceRoots)
    const client = await pool.connect()
    let project: { id: string; policy_version: number }
    try {
      await client.query('BEGIN')
      await client.query('SELECT id FROM projects WHERE id=$1 AND tenant_id=$2 AND organization_id=$3 FOR UPDATE', [
        id,
        ctx.tenantId,
        ctx.organizationId,
      ])
      await resolveManagedProject(client, ctx, id, true)
      const result = await client.query(
        `UPDATE projects SET name=COALESCE($4,name),archived_at=CASE WHEN $5::boolean THEN now() WHEN $5::boolean=false THEN NULL ELSE archived_at END,
         status=CASE WHEN $5::boolean THEN 'archived' WHEN $5::boolean=false THEN 'active' ELSE status END,updated_at=now(),policy_version=policy_version+1
         WHERE id=$1 AND tenant_id=$2 AND organization_id=$3 AND (archived_at IS NULL OR $5::boolean=false) AND ($6::integer IS NULL OR policy_version=$6)
         RETURNING id,policy_version`,
        [
          id,
          ctx.tenantId,
          ctx.organizationId,
          typeof body.name === 'string' ? body.name.trim() : null,
          body.archived ?? null,
          body.expectedVersion ?? null,
        ],
      )
      if (!result.rows[0]) throw new WorkspaceError('version_conflict', '项目已被其他人修改，请刷新后重试', 409)
      if (body.archived === true) await replaceRoots(client, ctx, id, [])
      else if (roots) await replaceRoots(client, ctx, id, roots)
      project = result.rows[0]
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    await auditControlPlane(
      ctx,
      'project.updated',
      { type: 'project', id },
      { archived: body.archived ?? null, workspaceRootsChanged: roots !== undefined || body.archived === true },
    )
    return jsonOk({ project })
  } catch (error) {
    return workspaceRouteError(error)
  }
}
