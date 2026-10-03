import {
  auditControlPlane,
  jsonOk,
  readJsonBody,
  requireContext,
  requireHighRiskContext,
  routeError,
} from '../../../_lib/control-plane'
import { configureConnector, connectorState } from '@/lib/connectors/control'
export const dynamic = 'force-dynamic'
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(req, 'credential:read')
    return jsonOk(await connectorState(ctx, (await params).id))
  } catch (e) {
    return routeError(e)
  }
}
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireHighRiskContext(req, 'credential:rotate')
    const { id } = await params
    const body = await readJsonBody<{ models?: unknown }>(req)
    const result = await configureConnector(ctx, id, body?.models)
    await auditControlPlane(
      ctx,
      'connector.pairing_issued',
      { type: 'connection', id },
      { modelCount: result.models.length },
    )
    const response = jsonOk(result)
    response.headers.set('cache-control', 'no-store')
    return response
  } catch (e) {
    return routeError(e)
  }
}
