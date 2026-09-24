import { pool } from '@/db'
import { auditControlPlane, jsonOk, readJsonBody } from '../../../_lib/control-plane'
import { requestTaskAction } from '@/lib/task-runtime/store'
import { TaskRuntimeError } from '@/lib/task-runtime/configuration'
import { taskScope, taskError } from '../../_shared'
export async function POST(req: Request, route: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await route.params
    const { ctx, scope } = await taskScope(req, id)
    const body = await readJsonBody<Record<string, unknown>>(req)
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
      throw new TaskRuntimeError('invalid_resume')
    await requestTaskAction(pool, scope, id, 'resume')
    await auditControlPlane(ctx, 'task.resume.requested', { type: 'task', id }, {})
    return jsonOk({ queued: true }, 202)
  } catch (error) {
    return taskError(error)
  }
}
