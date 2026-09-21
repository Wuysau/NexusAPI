import {
  createModelConfiguration,
  modelConfigurationError,
  type ConfigurationInput,
} from '@/lib/workspace/model-configurations'
import { auditControlPlane, jsonOk, readJsonBody, requireContext } from '../../_lib/control-plane'

export const dynamic = 'force-dynamic'
export async function POST(req: Request) {
  try {
    const ctx = await requireContext(req, 'model:manage')
    const configuration = await createModelConfiguration(ctx, await readJsonBody<ConfigurationInput>(req))
    await auditControlPlane(ctx, 'model.configuration_added', { type: 'model_configuration', id: configuration.id })
    return jsonOk({ configuration }, 201)
  } catch (error) {
    return modelConfigurationError(error)
  }
}
