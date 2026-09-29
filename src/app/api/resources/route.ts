import { pool } from '@/db'
import { buildResourceCatalog, type ChannelFact, type ConnectionFact, type QuotaFact } from '@/lib/resources/catalog'
import { connectionVisibility, workspaceParams } from '@/lib/workspace/management'
import { jsonOk, requireContext, routeError } from '../_lib/control-plane'
import { readCollectorObservation } from '@/lib/subscriptions/collector'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const ctx = await requireContext(req, 'credential:read')
    const params = workspaceParams(ctx)
    const [connections, channels] = await Promise.all([
      pool.query<ConnectionFact>(
        `SELECT c.id,c.provider,c.mode,c.status,c.project_id,c.revoked_at,c.capabilities,c.runtime_observation,
          CASE WHEN c.account_observation->>'organizationId'=$2 THEN c.account_observation ELSE NULL END account_observation
         FROM owned_connections c WHERE ${connectionVisibility}
           AND (c.account_observation IS NULL OR c.account_observation->>'organizationId'=$2)`,
        params,
      ),
      pool.query<ChannelFact>(
        `SELECT ch.id,ch.name,p.code provider,ch.provider_credential_id,pc.enabled credential_enabled,
          ch.enabled,ch.priority,ch.capabilities,ch.metadata
         FROM channels ch JOIN providers p ON p.id=ch.provider_id
         LEFT JOIN provider_credentials pc ON pc.id=ch.provider_credential_id
         LEFT JOIN owned_connections c ON c.id=ch.metadata->>'connection_id' AND c.tenant_id=$1
         WHERE (ch.tenant_id=$1 AND (pc.id IS NULL OR (pc.tenant_id=$1 AND pc.organization_id=$2))
           OR (ch.tenant_id IS NULL AND (pc.id IS NULL OR pc.is_platform_managed=true)))
           AND (c.id IS NULL OR ${connectionVisibility})`,
        params,
      ),
    ])
    const ids = connections.rows.map((connection) => connection.id)
    const quotas = ids.length
      ? await pool.query<QuotaFact>(
          `SELECT DISTINCT ON (connection_id,window_type) connection_id,window_type,observation_id,source,availability,used,remaining,
            observed_at,stale_at,reset_at,source_kind,confidence,scope,metadata,provenance_version
           FROM quota_snapshots WHERE tenant_id=$1 AND connection_id=ANY($2::text[])
           ORDER BY connection_id,window_type,observed_at DESC,created_at DESC,id DESC`,
          [ctx.tenantId, ids],
        )
      : { rows: [] as QuotaFact[] }
    const now = new Date()
    const observations = new Map(
      connections.rows.map((connection) => [
        connection.id,
        readCollectorObservation(connection.account_observation, ctx.organizationId, now),
      ]),
    )
    const resources = buildResourceCatalog(connections.rows, channels.rows, quotas.rows, now).map((resource) => ({
      ...resource,
      collectorObservation: resource.connectionId ? (observations.get(resource.connectionId) ?? null) : null,
    }))
    const response = jsonOk({ resources })
    response.headers.set('cache-control', 'no-store')
    return response
  } catch (error) {
    return routeError(error)
  }
}
