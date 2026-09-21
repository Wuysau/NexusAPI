import { pool } from '@/db'
import { resolveAnalyticsAccess } from '@/lib/billing/analytics-access'
import { readOverview } from '@/lib/billing/overview'
import { parseUsageAnalyticsQuery } from '../../../../packages/contracts/usage-analytics'
import { jsonOk, requireContext, routeError } from '../_lib/control-plane'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const ctx = await requireContext(req, 'usage:read')
    const days = Math.min(90, Math.max(1, Math.floor(Number(new URL(req.url).searchParams.get('days') ?? 7) || 7)))
    const now = new Date()
    const query = parseUsageAnalyticsQuery(
      new URLSearchParams({
        from: new Date(now.getTime() - days * 86400000).toISOString(),
        to: now.toISOString(),
        asOf: now.toISOString(),
      }),
      now,
    )
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const access = await resolveAnalyticsAccess(client, ctx, query)
      const result = await readOverview(client, access, query, days)
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
    return routeError(error)
  }
}
