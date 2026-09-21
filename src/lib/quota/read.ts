import type { AnalyticsDatabase } from '@/lib/billing/analytics'

export interface QuotaRow {
  id: string
  observation_id: string | null
  window_type: string
  used: string | null
  remaining: string | null
  source: string
  source_kind: string
  confidence: string
  scope: string
  attribution_mode: string
  availability: string
  provenance_version: number | null
  observed_at: Date
  stale_at: Date | null
  reset_at: Date | null
  metadata?: Record<string, unknown> | null
}

/** Freshness describes an observation, never permission to forward or bill. */
export function presentQuota(row: QuotaRow, now = new Date()) {
  const versioned = row.provenance_version === 1
  const availability = versioned ? row.availability : 'unknown'
  const freshness =
    availability === 'unavailable'
      ? 'unavailable'
      : !versioned || !row.stale_at || row.observed_at > now || row.stale_at < row.observed_at
        ? 'unknown'
        : row.stale_at <= now
          ? 'stale'
          : availability === 'available'
            ? 'fresh'
            : 'unknown'
  return {
    id: row.id,
    observationId: row.observation_id,
    windowType: row.window_type,
    used: availability === 'unavailable' ? null : row.used,
    remaining: availability === 'unavailable' ? null : row.remaining,
    source: versioned ? row.source : 'legacy',
    sourceKind: versioned ? row.source_kind : 'unknown',
    confidence: versioned ? row.confidence : 'unknown',
    scope: versioned ? row.scope : 'unknown',
    attributionMode: versioned ? row.attribution_mode : 'unknown',
    availability,
    observedAt: row.observed_at.toISOString(),
    staleAt: row.stale_at?.toISOString() ?? null,
    resetAt: row.reset_at?.toISOString() ?? null,
    freshness,
    provenanceVersion: versioned ? 1 : null,
    ...(row.metadata ? { metadata: row.metadata } : {}),
  }
}

export async function readConnectionQuotas(
  client: AnalyticsDatabase,
  tenantId: string,
  connectionId: string,
  now = new Date(),
) {
  const rows = await client.query<QuotaRow>(
    `SELECT DISTINCT ON (window_type) * FROM quota_snapshots WHERE tenant_id=$1 AND connection_id=$2
     ORDER BY window_type,observed_at DESC,created_at DESC,id DESC`,
    [tenantId, connectionId],
  )
  return rows.rows.map((row) => presentQuota(row, now))
}
