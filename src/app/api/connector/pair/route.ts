import { bearer, pairConnector } from '@/lib/connectors/control'
import { jsonOk, routeError } from '../../_lib/control-plane'
export const dynamic = 'force-dynamic'
export async function POST(req: Request) {
  try {
    const response = jsonOk(await pairConnector(bearer(req)))
    response.headers.set('cache-control', 'no-store')
    return response
  } catch (e) {
    return routeError(e)
  }
}
