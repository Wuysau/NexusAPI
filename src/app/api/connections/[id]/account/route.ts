import { apiError, auditControlPlane, jsonOk, requireContext } from '../../../_lib/control-plane'
import { workspaceRouteError } from '@/lib/workspace/management'
import { localAccountRequestAllowed, syncCodexAccountConnection } from '@/lib/subscriptions/codex/sync'
import { readCodexAccountConnection } from '@/lib/subscriptions/codex/read'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
function noStore(response: Response) {
  response.headers.set('Cache-Control', 'no-store')
  return response
}
type Route = { params: Promise<{ id: string }> }
export async function GET(req: Request, { params }: Route) {
  try {
    const ctx = await requireContext(req, 'usage:read')
    const result = await readCodexAccountConnection(ctx, (await params).id)
    return noStore(
      jsonOk({
        ...result,
        syncAvailable: ['owner', 'admin'].includes(ctx.membership.role) && localAccountRequestAllowed(req),
      }),
    )
  } catch (error) {
    return noStore(workspaceRouteError(error))
  }
}
export async function POST(req: Request, { params }: Route) {
  try {
    const ctx = await requireContext(req, 'quota:write')
    if (!['owner', 'admin'].includes(ctx.membership.role) || !localAccountRequestAllowed(req, true))
      return noStore(apiError(403, 'local_account_required', '请由管理员在本机 dev:local 工作空间刷新 Codex 账户'))
    const id = (await params).id
    const refresh = new URL(req.url).searchParams.get('refresh') ?? 'account'
    if (refresh !== 'account' && refresh !== 'quota')
      return noStore(apiError(400, 'invalid_refresh', '不支持的账户刷新方式'))
    const result = await syncCodexAccountConnection(ctx, id, refresh)
    await auditControlPlane(
      ctx,
      'connection.account_synced',
      { type: 'connection', id },
      { status: result.status, error: result.lastSyncError, refresh },
    )
    return noStore(jsonOk(result))
  } catch (error) {
    return noStore(workspaceRouteError(error))
  }
}
