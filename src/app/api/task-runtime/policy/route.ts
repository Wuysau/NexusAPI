import { auditControlPlane, jsonOk, readJsonBody } from '../../_lib/control-plane'
import { savePolicy } from '@/lib/task-runtime/store'
import { TaskRuntimeError } from '@/lib/task-runtime/configuration'
import { validatePolicy } from '@/lib/task-runtime/router'
import { projectScope, taskError, visibleTaskPolicy, withProjectWrite } from '../_shared'
export async function PUT(req: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(req)
    const { ctx, scope } = await projectScope(req, body?.projectId, true)
    if (!body || Object.keys(body).some((k) => !['projectId', 'policy'].includes(k)))
      throw new TaskRuntimeError('invalid_policy')
    const policy = await withProjectWrite(ctx, scope, async (client, role) => {
      const validated = validatePolicy(body.policy)
      const visible = await visibleTaskPolicy(client, ctx, role, validated)
      if (visible.candidates.length !== validated.candidates.length)
        throw new TaskRuntimeError('inaccessible_policy_connection')
      return savePolicy(client, scope, validated)
    })
    await auditControlPlane(
      ctx,
      'task.policy.updated',
      { type: 'project', id: scope.projectId },
      { candidates: policy.candidates.length },
    )
    return jsonOk({ policy })
  } catch (error) {
    return taskError(error)
  }
}
