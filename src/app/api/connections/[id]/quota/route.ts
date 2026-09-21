import { pool } from '@/db'
import { logAudit } from '@/lib/audit'
import { resolveQuotaConnection } from '@/lib/quota/access'
import { presentQuota, readConnectionQuotas } from '@/lib/quota/read'
import { QuotaReplayConflict, writeManualQuota } from '@/lib/quota/write'
import { parseManualQuotaObservation, QuotaContractError } from '../../../../../../packages/contracts/quota'
import { apiError, jsonOk, readJsonBody, requireContext, routeError } from '../../../_lib/control-plane'

export const dynamic = 'force-dynamic'
type Params = { params: Promise<{ id: string }> }

export async function GET(req: Request, { params }: Params) {
  try {
    const ctx = await requireContext(req, 'usage:read')
    if (new URL(req.url).searchParams.size) return apiError(400, 'invalid_request', 'Unknown quota query')
    const { id } = await params
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await resolveQuotaConnection(client, ctx, id)
      const quotas = await readConnectionQuotas(client, ctx.tenantId, id)
      await client.query('COMMIT')
      return jsonOk({ connectionId: id, quotas, freshness: quotas.length ? undefined : 'unknown' })
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    return routeError(error)
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const ctx = await requireContext(req, 'quota:write')
    const { id } = await params
    const value = parseManualQuotaObservation(await readJsonBody<unknown>(req))
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await resolveQuotaConnection(client, ctx, id, { write: true, lock: true })
      const result = await writeManualQuota(client, ctx.tenantId, id, value)
      if (!result.replayed)
        await logAudit({
          client,
          actorUserId: ctx.session.userId,
          tenantId: ctx.tenantId,
          action: 'connection.quota_reported',
          targetType: 'connection',
          targetId: id,
          metadata: {
            observationId: value.observationId,
            windowType: value.windowType,
            scope: value.scope,
            sourceKind: value.sourceKind,
          },
        })
      await client.query('COMMIT')
      return jsonOk({ quota: presentQuota(result.row), replayed: result.replayed }, result.replayed ? 200 : 201)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    if (error instanceof QuotaContractError) return apiError(400, error.code, error.message)
    if (error instanceof QuotaReplayConflict) return apiError(409, 'observation_conflict', error.message)
    return routeError(error)
  }
}
