import { bearer, renewLease } from '@/lib/connectors/control'
import { jsonOk, readJsonBody, routeError } from '../../_lib/control-plane'
export const dynamic = 'force-dynamic'
export async function POST(req: Request) {
  try {
    const input = await readJsonBody<{ leaseToken?: unknown; readyModels?: unknown }>(req)
    const response = jsonOk(await renewLease(bearer(req), input ?? {}))
    response.headers.set('cache-control', 'no-store')
    return response
  } catch (e) {
    return routeError(e)
  }
}
