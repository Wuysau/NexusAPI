import { pool } from '@/db'
import { resolveAnalyticsAccess } from '@/lib/billing/analytics-access'
import { readSessionDetails } from '@/lib/billing/sessions'
import { AnalyticsQueryError, parseUsageAnalyticsQuery } from '../../../../../packages/contracts/usage-analytics'
import { apiError, jsonOk, requireContext, routeError } from '../../_lib/control-plane'

export const dynamic = 'force-dynamic'
export async function GET(req: Request) {
  try {
    const ctx = await requireContext(req, 'billing:read')
    const params = new URL(req.url).searchParams
    if (params.getAll('groupKey').length > 1 || (params.get('groupKey')?.length ?? 0) > 512)
      throw new AnalyticsQueryError('Invalid group key')
    const groupKey = params.get('groupKey')
    params.delete('groupKey')
    const query = parseUsageAnalyticsQuery(params)
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const access = await resolveAnalyticsAccess(client, ctx, query)
      const result = await readSessionDetails(client, access, query, groupKey)
      await client.query('COMMIT')
      const response = jsonOk(result)
      response.headers.set('Cache-Control', 'no-store')
      return response
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    return error instanceof AnalyticsQueryError ? apiError(400, error.code, error.message) : routeError(error)
  }
}
