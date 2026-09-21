import {
  updateModelConfiguration,
  modelConfigurationError,
  type ConfigurationInput,
} from '@/lib/workspace/model-configurations'
import { auditControlPlane, jsonOk, readJsonBody, requireContext } from '../../../_lib/control-plane'

export const dynamic = 'force-dynamic'
async function mutate(req: Request, params: Promise<{ id: string }>, remove: boolean) {
  try {
    const ctx = await requireContext(req, 'model:manage')
    const { id } = await params
    const configuration = await updateModelConfiguration(ctx, id, await readJsonBody<ConfigurationInput>(req), remove)
    await auditControlPlane(
      ctx,
      remove ? 'model.configuration_removed' : 'model.configuration_updated',
      { type: 'model_configuration', id },
      { version: configuration.version, archived: Boolean(configuration.archivedAt) },
    )
    return jsonOk({ configuration })
  } catch (error) {
    return modelConfigurationError(error)
  }
}
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return mutate(req, params, false)
}
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return mutate(req, params, true)
}
