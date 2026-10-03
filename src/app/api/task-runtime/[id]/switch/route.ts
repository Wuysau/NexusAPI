import { auditControlPlane, jsonOk, readJsonBody } from '../../../_lib/control-plane'
import { requestTaskAction } from '@/lib/task-runtime/store'
import { TaskRuntimeError } from '@/lib/task-runtime/configuration'
import { taskScope, taskError, withProjectWrite } from '../../_shared'
export async function POST(req: Request, route: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await route.params
    const { ctx, scope } = await taskScope(req, id)
    const body = await readJsonBody<Record<string, unknown>>(req)
    if (
      !body ||
      typeof body.targetConnectionId !== 'string' ||
      Object.keys(body).some((k) => k !== 'targetConnectionId')
    )
      throw new TaskRuntimeError('invalid_target_resource')
    const target = body.targetConnectionId
    await withProjectWrite(ctx, scope, (client) => requestTaskAction(client, scope, id, 'switch', target))
    await auditControlPlane(
      ctx,
      'task.switch.requested',
      { type: 'task', id },
      { targetConnectionId: body.targetConnectionId },
    )
    return jsonOk({ queued: true }, 202)
  } catch (error) {
    return taskError(error)
  }
}
