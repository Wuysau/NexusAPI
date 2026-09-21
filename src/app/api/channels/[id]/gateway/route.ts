import { pool } from '@/db'
import { apiError, auditControlPlane, jsonOk, requireContext, routeError } from '../../../_lib/control-plane'
import { assertLocalKeyInput, LocalCredentialError } from '@/lib/channels/local-credentials'
import { prepareLocalRouting } from '@/lib/channels/local-routing'
export const dynamic = 'force-dynamic'
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(req, 'credential:create')
    assertLocalKeyInput(req)
    const { id } = await params,
      db = await pool.connect()
    let result
    try {
      await db.query('BEGIN')
      result = await prepareLocalRouting(db, ctx, id)
      await db.query('COMMIT')
    } catch (e) {
      await db.query('ROLLBACK')
      throw e
    } finally {
      db.release()
    }
    await auditControlPlane(
      ctx,
      'channel.routing_configured',
      { type: 'channel', id },
      { connectionId: result.connectionId },
    )
    return jsonOk(result)
  } catch (e) {
    if (e instanceof LocalCredentialError) return apiError(e.status, e.code, e.message)
    return routeError(e)
  }
}
