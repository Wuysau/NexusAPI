import { pool } from '@/db'
import {
  parseRoots,
  replaceRoots,
  workspaceRouteError,
  workspaceParams,
  projectVisibility,
} from '@/lib/workspace/management'
import { apiError, auditControlPlane, jsonOk, readJsonBody, requireContext, routeError } from '../_lib/control-plane'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const ctx = await requireContext(req, 'project:read')
    const status = new URL(req.url).searchParams.get('status') ?? 'active'
    if (!['active', 'archived', 'all'].includes(status)) return apiError(400, 'invalid_status', '项目状态无效')
    const result = await pool.query(
      `SELECT p.id,p.name,p.status,p.policy_version,p.created_at,p.updated_at,
        (SELECT count(*)::int FROM project_memberships pm WHERE pm.tenant_id=$1 AND pm.project_id=p.id) member_count,
        (SELECT count(*)::int FROM owned_connections oc WHERE oc.tenant_id=$1 AND oc.project_id=p.id AND oc.revoked_at IS NULL) connection_count,
        ARRAY(SELECT root FROM project_workspace_roots r WHERE r.tenant_id=$1 AND r.organization_id=$2 AND r.project_id=p.id ORDER BY root) workspace_roots,
        observed.events,observed.sessions,observed.last_activity
       FROM projects p LEFT JOIN LATERAL (
        SELECT count(*)::text events,count(DISTINCT external_session_id)::text sessions,max(occurred_at) last_activity
        FROM external_observed_usage e WHERE e.tenant_id=$1 AND e.organization_id=$2 AND e.project_id=p.id
       ) observed ON true WHERE ${projectVisibility}
         AND ($5='all' OR ($5='active' AND p.archived_at IS NULL) OR ($5='archived' AND p.archived_at IS NOT NULL)) ORDER BY p.created_at DESC`,
      [...workspaceParams(ctx), status],
    )
    return jsonOk({
      projects: result.rows.map((r) => ({
        ...r,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        policyVersion: r.policy_version,
        memberCount: r.member_count,
        connectionCount: r.connection_count,
        workspaceRoots: r.workspace_roots,
        observedEvents: r.events,
        observedSessions: r.sessions,
        lastObservedAt: r.last_activity?.toISOString() ?? null,
      })),
    })
  } catch (error) {
    return routeError(error)
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireContext(req, 'project:create')
    const body = await readJsonBody<{ name?: unknown; workspaceRoots?: unknown }>(req)
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name || name.length > 120) return apiError(400, 'invalid_name', '项目名称不能为空且不超过 120 个字符')
    const roots = parseRoots(body?.workspaceRoots)
    const client = await pool.connect()
    let project: { id: string; name: string }
    try {
      await client.query('BEGIN')
      project = (
        await client.query(
          'INSERT INTO projects(tenant_id,organization_id,name,created_by) VALUES($1,$2,$3,$4) RETURNING id,name',
          [ctx.tenantId, ctx.organizationId, name, ctx.session.userId],
        )
      ).rows[0]
      await client.query(
        "INSERT INTO project_memberships(tenant_id,project_id,user_id,role) VALUES($1,$2,$3,'owner')",
        [ctx.tenantId, project.id, ctx.session.userId],
      )
      if (roots) await replaceRoots(client, ctx, project.id, roots)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    await auditControlPlane(ctx, 'project.created', { type: 'project', id: project.id }, { name })
    return jsonOk({ project }, 201)
  } catch (error) {
    return workspaceRouteError(error)
  }
}
