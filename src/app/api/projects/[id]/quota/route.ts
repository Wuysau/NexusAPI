import { pool } from '@/db'
import { resolveQuotaProject, resolveQuotaConnection } from '@/lib/quota/access'
import { AuthzError } from '@/lib/auth/capabilities'
import { connectionVisibility, workspaceParams } from '@/lib/workspace/management'
import { readConnectionQuotas } from '@/lib/quota/read'
import { resolveAnalyticsAccess } from '@/lib/billing/analytics-access'
import { queryUsageAnalytics } from '@/lib/billing/analytics'
import {
  AnalyticsQueryError,
  parseUsageAnalyticsQuery,
  validateUsageAnalyticsResponse,
} from '../../../../../../packages/contracts/usage-analytics'
import { apiError, jsonOk, requireContext, routeError } from '../../../_lib/control-plane'

export const dynamic = 'force-dynamic'
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(req, 'usage:read')
    const { id } = await params
    const query = parseUsageAnalyticsQuery(new URL(req.url).searchParams)
    if (
      (query.projectId && query.projectId !== id) ||
      query.scope !== 'organization' ||
      (query.organizationId && query.organizationId !== ctx.organizationId)
    )
      return apiError(404, 'tenant_isolation', 'Not found')
    query.projectId = id
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await resolveQuotaProject(client, ctx, id)
      const rows = await client.query<{
        id: string
        provider: string
        mode: string
        account_status: string | null
        official_ids: string[] | null
      }>(
        `SELECT c.id,c.provider,c.mode,
         CASE WHEN c.account_observation->>'organizationId'=$2 THEN c.account_observation->>'status' END account_status,
         CASE WHEN c.account_observation->>'organizationId'=$2 THEN c.account_observation->'quota'->'observationIds' END official_ids
         FROM owned_connections c WHERE ${connectionVisibility}
         AND (c.project_id=$5 OR (c.mode='subscription_interactive' AND EXISTS (
           SELECT 1 FROM external_observed_usage e WHERE e.tenant_id=$1 AND e.organization_id=$2 AND e.project_id=$5 AND e.connection_id=c.id)))
         AND c.revoked_at IS NULL AND c.status NOT IN ('revoked','expired','blocked') ORDER BY c.id`,
        [...workspaceParams(ctx), id],
      )
      const connections = []
      const now = new Date()
      for (const connection of rows.rows) {
        // Historical usage links never grant permission to read a connection's current quota.
        try {
          await resolveQuotaConnection(client, ctx, connection.id)
        } catch (error) {
          if (error instanceof AuthzError && error.status === 404) continue
          throw error
        }
        const quotas = await readConnectionQuotas(client, ctx.tenantId, connection.id, now)
        connections.push({
          id: connection.id,
          provider: connection.provider,
          mode: connection.mode,
          accountStatus: connection.account_status,
          quotas: quotas.filter(
            (q) =>
              q.source !== 'codex_app_server' ||
              (q.observationId && connection.official_ids?.includes(q.observationId)),
          ),
        })
      }
      const access = await resolveAnalyticsAccess(client, ctx, query)
      const apiUsage = await queryUsageAnalytics(client, access, query)
      if (!validateUsageAnalyticsResponse(apiUsage).ok) throw new Error('Invalid analytics response')
      await client.query('COMMIT')
      const response = jsonOk({ projectId: id, connections, apiUsage })
      response.headers.set('Cache-Control', 'no-store')
      return response
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    if (error instanceof AnalyticsQueryError) return apiError(400, error.code, error.message)
    return routeError(error)
  }
}
