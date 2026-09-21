import type { AnalyticsDatabase } from '@/lib/billing/analytics'
import type { ManualQuotaObservation } from '../../../packages/contracts/quota'
import type { QuotaRow } from './read'

export class QuotaReplayConflict extends Error {
  constructor() {
    super('Observation ID already has a different payload')
  }
}

/** Caller holds the authorized connection row lock until commit. */
export async function writeManualQuota(
  client: AnalyticsDatabase,
  tenantId: string,
  connectionId: string,
  value: ManualQuotaObservation,
) {
  const values = [
    tenantId,
    connectionId,
    value.observationId,
    value.windowType,
    value.used,
    value.remaining,
    value.source,
    value.sourceKind,
    value.confidence,
    value.scope,
    value.attributionMode,
    value.availability,
    value.observedAt,
    value.staleAt,
    value.resetAt,
  ]
  const inserted = await client.query<QuotaRow>(
    `INSERT INTO quota_snapshots(tenant_id,connection_id,observation_id,window_type,used,remaining,source,source_kind,confidence,scope,attribution_mode,availability,observed_at,stale_at,reset_at,provenance_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,1)
     ON CONFLICT(tenant_id,connection_id,observation_id) DO NOTHING RETURNING *`,
    values,
  )
  if (inserted.rows[0]) return { row: inserted.rows[0], replayed: false }
  const existing = await client.query<QuotaRow>(
    `SELECT * FROM quota_snapshots WHERE tenant_id=$1 AND connection_id=$2 AND observation_id=$3
     AND window_type=$4 AND used IS NOT DISTINCT FROM $5::numeric AND remaining IS NOT DISTINCT FROM $6::numeric
     AND source=$7 AND source_kind=$8 AND confidence=$9 AND scope=$10 AND attribution_mode=$11 AND availability=$12
     AND observed_at=$13::timestamptz AND stale_at=$14::timestamptz AND reset_at IS NOT DISTINCT FROM $15::timestamptz AND provenance_version=1`,
    values,
  )
  if (!existing.rows[0]) throw new QuotaReplayConflict()
  return { row: existing.rows[0], replayed: true }
}
