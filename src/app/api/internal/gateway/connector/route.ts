import { authorizeConnector, type ConnectorAuthorization } from '@/lib/connectors/control'
import { requireGatewayToken, internalError } from '../_shared'
export const dynamic = 'force-dynamic'
export async function POST(req: Request) {
  const denied = requireGatewayToken(req)
  if (denied) return denied
  try {
    return Response.json(await authorizeConnector((await req.json()) as ConnectorAuthorization), {
      headers: { 'cache-control': 'no-store' },
    })
  } catch {
    return internalError(403, 'unauthorized', 'Connector authorization unavailable.')
  }
}
