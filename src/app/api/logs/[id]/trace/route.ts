import { pool } from '@/db'
import { resolveAnalyticsAccess } from '@/lib/billing/analytics-access'
import { readRequestTrace } from '@/lib/billing/request-trace'
import { apiError, jsonOk, requireContext, routeError } from '../../../_lib/control-plane'

export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let response: Response
  try {
    const ctx = await requireContext(req, 'request:read')
    const { id } = await params
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const access = await resolveAnalyticsAccess(client, ctx, { scope: 'tenant' })
      const trace = await readRequestTrace(client, access, id)
      await client.query('COMMIT')
      response = trace ? jsonOk(trace, 200, req) : apiError(404, 'tenant_isolation', 'Not found', req)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    response = routeError(error, req)
  }
  response.headers.set('cache-control', 'no-store')
  return response
}
