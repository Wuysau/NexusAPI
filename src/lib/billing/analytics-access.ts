import { AuthzError } from '@/lib/auth/capabilities'

export interface AnalyticsAccessQuery {
  scope?: 'organization' | 'tenant'
  organizationId?: string
  projectId?: string
}
export interface AnalyticsAccessContext {
  tenantId: string
  organizationId: string
  session: { userId: string }
}
export interface AnalyticsAccess {
  tenantId: string
  organizations: Array<{ organizationId: string; allProjects: boolean; projectIds: string[] }>
  financialOrganizationId: string | null
}
interface Queryable {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
}
export async function resolveAnalyticsAccess(
  client: Queryable,
  ctx: AnalyticsAccessContext,
  query: AnalyticsAccessQuery,
): Promise<AnalyticsAccess> {
  const deny = (): never => {
    throw new AuthzError('tenant_isolation', 'Not found', 404)
  }
  const memberships = await client.query<{ organization_id: string; role: string }>(
    `SELECT m.organization_id,m.role FROM organization_memberships m
     JOIN organizations o ON o.id=m.organization_id AND o.tenant_id=m.tenant_id
     WHERE m.user_id=$1 AND m.tenant_id=$2 AND o.status='active' AND o.deleted_at IS NULL
     ORDER BY m.organization_id`,
    [ctx.session.userId, ctx.tenantId],
  )
  const selectedOrg = query.organizationId ?? (query.scope === 'tenant' ? null : ctx.organizationId)
  const membershipsInScope = memberships.rows.filter(
    (row) => selectedOrg === null || row.organization_id === selectedOrg,
  )
  if (selectedOrg !== null && membershipsInScope.length === 0) deny()
  const projects = await client.query<{ id: string; organization_id: string }>(
    `SELECT p.id,p.organization_id FROM project_memberships pm
     JOIN projects p ON p.id=pm.project_id AND p.tenant_id=pm.tenant_id
     WHERE pm.user_id=$1 AND pm.tenant_id=$2
     ORDER BY p.id`,
    [ctx.session.userId, ctx.tenantId],
  )
  let organizations = membershipsInScope.map((row) => ({
    organizationId: row.organization_id,
    allProjects: ['owner', 'admin', 'billing'].includes(row.role),
    projectIds: ['developer', 'viewer'].includes(row.role)
      ? projects.rows.filter((project) => project.organization_id === row.organization_id).map((project) => project.id)
      : [],
  }))
  if (query.projectId) {
    if (query.projectId === '__unknown__' || query.projectId === '__unattributed__') {
      organizations = organizations.filter((org) => org.allProjects)
    } else {
      const historical = await client.query<{ organization_id: string }>(
        `SELECT organization_id FROM projects WHERE id=$1 AND tenant_id=$2
         UNION SELECT r.organization_id FROM request_project_facts f
           JOIN request_records r ON r.id=f.request_id AND r.tenant_id=f.tenant_id AND r.organization_id=f.organization_id
           WHERE f.project_id=$1 AND f.tenant_id=$2
         UNION SELECT organization_id FROM external_observed_usage WHERE project_id=$1 AND tenant_id=$2`,
        [query.projectId, ctx.tenantId],
      )
      const eligible = new Set(historical.rows.map((row) => row.organization_id))
      organizations = organizations.filter(
        (org) => eligible.has(org.organizationId) && (org.allProjects || org.projectIds.includes(query.projectId!)),
      )
      organizations = organizations.map((org) => (org.allProjects ? org : { ...org, projectIds: [query.projectId!] }))
    }
    if (organizations.length === 0) deny()
  }
  return {
    tenantId: ctx.tenantId,
    organizations,
    financialOrganizationId:
      query.scope !== 'tenant' && !query.projectId && organizations.length === 1 && organizations[0].allProjects
        ? organizations[0].organizationId
        : null,
  }
}
