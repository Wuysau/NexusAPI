// Model catalog read model: upstream models, their latest price version and
// the number of price candidates waiting for review.
//
// Prices shown here come from `provider_price_versions` (the approved/active
// rows), never from a source constant. `src/lib/catalog/display.ts` supplies
// presentation metadata only.

import { pool } from '@/db'
import { isDemoModel, isPlaceholderPriceSource } from '@/lib/catalog/evidence'
import { jsonOk, requireContext, routeError } from '../_lib/control-plane'

export const dynamic = 'force-dynamic'

interface ModelRow {
  id: string
  provider_id: string
  provider_code: string
  provider_name: string
  upstream_model_id: string
  display_name: string
  context_window: number | null
  max_output_tokens: number | null
  capabilities: string[]
  lifecycle_status: string
  available: boolean
  raw_metadata: Record<string, unknown> | null
  first_seen_at: Date
  last_seen_at: Date
  price_version_id: string | null
  currency: string | null
  price_status: string | null
  effective_from: Date | null
  source_type: string | null
  source_url: string | null
  fetched_at: Date | null
  pending_candidates: string
}

const MODELS_SQL = `
  SELECT um.id, um.provider_id, p.code AS provider_code, p.name AS provider_name,
         um.upstream_model_id, um.display_name, um.context_window, um.max_output_tokens,
         um.capabilities, um.lifecycle_status, um.available, um.raw_metadata, um.first_seen_at, um.last_seen_at,
         v.id AS price_version_id, v.currency, v.status AS price_status, v.effective_from,
         v.source_type, v.source_url, v.fetched_at,
         (SELECT count(*) FROM price_candidates c
           WHERE c.provider_id = um.provider_id AND c.upstream_model_id = um.upstream_model_id
             AND c.status IN ('fetched','validated','pending_approval','scheduled')) AS pending_candidates
    FROM upstream_models um
    JOIN providers p ON p.id = um.provider_id
    LEFT JOIN LATERAL (
      SELECT id, currency, status, effective_from, source_type, source_url, fetched_at
        FROM provider_price_versions pv
       WHERE pv.provider_id = um.provider_id AND pv.upstream_model_id = um.upstream_model_id
         AND pv.status IN ('active', 'approved')
       ORDER BY CASE pv.status WHEN 'active' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, pv.fetched_at DESC
       LIMIT 1
    ) v ON true
   ORDER BY p.code, um.upstream_model_id`

export async function GET(req: Request) {
  try {
    const ctx = await requireContext(req, 'pricing:read')
    const result = await pool.query<ModelRow>(MODELS_SQL)

    const versionIds = result.rows.map((r) => r.price_version_id).filter((v): v is string => Boolean(v))
    const components = versionIds.length
      ? await pool.query<{ price_version_id: string; kind: string; unit: string; amount: string }>(
          'SELECT price_version_id, kind, unit, amount FROM price_components WHERE price_version_id = ANY($1::text[]) ORDER BY kind',
          [versionIds],
        )
      : { rows: [] as { price_version_id: string; kind: string; unit: string; amount: string }[] }
    const byVersion = new Map<string, { kind: string; unit: string; amount: string }[]>()
    for (const c of components.rows) {
      const list = byVersion.get(c.price_version_id) ?? []
      list.push({ kind: c.kind, unit: c.unit, amount: c.amount })
      byVersion.set(c.price_version_id, list)
    }

    const [configurations, providers] = await Promise.all([
      pool.query(
        `SELECT id,provider_id AS "providerId",upstream_model_id AS "upstreamModelId",display_name AS "displayName",
        notes,version,archived_at AS "archivedAt",created_at AS "createdAt",updated_at AS "updatedAt"
        FROM organization_model_configurations WHERE tenant_id=$1 AND organization_id=$2 ORDER BY created_at DESC`,
        [ctx.tenantId, ctx.organizationId],
      ),
      pool.query('SELECT id,code,name FROM providers WHERE enabled=true ORDER BY name'),
    ])
    const catalog = result.rows.map((row) => {
      const demo = isDemoModel(row.raw_metadata)
      const demoPrice = isPlaceholderPriceSource(row.source_url)
      return {
        id: row.id,
        provider: { id: row.provider_id, code: row.provider_code, name: row.provider_name },
        upstreamModelId: row.upstream_model_id,
        displayName: row.display_name,
        contextWindow: demo ? null : row.context_window,
        maxOutputTokens: demo ? null : row.max_output_tokens,
        capabilities: demo ? [] : row.capabilities,
        lifecycleStatus: row.lifecycle_status,
        available: !demo && row.available,
        evidence: { kind: demo ? 'demo' : 'catalog_record', recordId: row.id },
        priceEvidence: {
          kind: demoPrice ? 'demo' : row.price_version_id ? 'price_version' : 'unknown',
          versionId: row.price_version_id,
          sourceUrl: row.source_url,
          fetchedAt: row.fetched_at?.toISOString() ?? null,
        },
        firstSeenAt: row.first_seen_at.toISOString(),
        lastSeenAt: row.last_seen_at.toISOString(),
        pendingCandidates: Number(row.pending_candidates),
        price:
          row.price_version_id && !demo && !demoPrice
            ? {
                versionId: row.price_version_id,
                currency: row.currency,
                status: row.price_status,
                effectiveFrom: row.effective_from?.toISOString() ?? null,
                fetchedAt: row.fetched_at?.toISOString() ?? null,
                // Source evidence is shown verbatim to the approver.
                source: { type: row.source_type, url: row.source_url },
                components: byVersion.get(row.price_version_id) ?? [],
              }
            : null,
      }
    })
    return jsonOk({
      configurations: configurations.rows,
      providers: providers.rows,
      models: catalog.filter((model) => model.evidence.kind !== 'demo'),
      demoModels: catalog.filter((model) => model.evidence.kind === 'demo'),
    })
  } catch (error) {
    return routeError(error)
  }
}
