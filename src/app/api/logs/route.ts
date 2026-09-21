import { pool } from '@/db'
import { fromMicros } from '@/lib/money'
import { resolveAnalyticsAccess } from '@/lib/billing/analytics-access'
import { queryUsageAnalytics, queryUsageLogs } from '@/lib/billing/analytics'
import {
  AnalyticsQueryError,
  parseUsageAnalyticsQuery,
  validateUsageAnalyticsResponse,
} from '../../../../packages/contracts/usage-analytics'
import { apiError, jsonOk, requireContext, routeError } from '../_lib/control-plane'

export const dynamic = 'force-dynamic'
const money = (value: unknown) => (value == null ? null : fromMicros(BigInt(String(value))))

export async function GET(req: Request) {
  try {
    const ctx = await requireContext(req, 'request:read')
    const query = parseUsageAnalyticsQuery(new URL(req.url).searchParams)
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const access = await resolveAnalyticsAccess(client, ctx, query)
      const analytics = await queryUsageAnalytics(client, access, query)
      const logs = await queryUsageLogs(client, access, query)
      if (!validateUsageAnalyticsResponse(analytics).ok) throw new Error('Invalid analytics response')
      await client.query('COMMIT')
      return jsonOk({
        ...logs,
        analytics,
        entries: logs.entries.map((row) => ({
          ...row,
          canonical: row,
          model: row.requested_model,
          upstreamModelId: row.model,
          providerCode: row.provider_code,
          providerId: row.provider_id,
          channelKind: row.execution_mode === 'managed' ? 'platform' : row.execution_mode === 'byok' ? 'byok' : null,
          projectId: row.project_id,
          projectName: row.project_name,
          attributionStatus: row.attribution_status,
          apiKeyId: row.api_key_id,
          keyName: row.api_key_id,
          connectionId: row.connection_id,
          executionMode: row.execution_mode,
          inputTokens: row.input,
          outputTokens: row.output,
          cachedTokens: row.cached,
          reasoningTokens: row.reasoning,
          totalTokens: row.total,
          charge: money(row.charge),
          chargeMicros: row.charge,
          currency: row.charge_currency,
          cost: money(row.upstream_cost),
          costMicros: row.upstream_cost,
          costCurrency: row.upstream_cost_currency,
          errorCode: row.error_code,
          startedAt: row.started_at,
          completedAt: row.completed_at,
          latencyMs:
            row.completed_at && row.started_at
              ? new Date(String(row.completed_at)).getTime() - new Date(String(row.started_at)).getTime()
              : null,
        })),
      })
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
