import { pool } from '@/db'
import { auditControlPlane, jsonOk, readJsonBody } from '../../_lib/control-plane'
import { savePolicy } from '@/lib/task-runtime/store'
import { TaskRuntimeError } from '@/lib/task-runtime/configuration'
import { projectScope, taskError } from '../_shared'
export async function PUT(req: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(req)
    const { ctx, scope } = await projectScope(req, body?.projectId, true)
    if (!body || Object.keys(body).some((k) => !['projectId', 'policy'].includes(k)))
      throw new TaskRuntimeError('invalid_policy')
    const policy = await savePolicy(pool, scope, body.policy)
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
