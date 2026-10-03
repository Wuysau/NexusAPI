import { pool } from '@/db'
import { jsonOk } from '../_lib/control-plane'
import { readPolicy, readTasks } from '@/lib/task-runtime/store'
import { readResources } from '@/lib/task-runtime/router'
import { projectScope, taskError, visibleTaskPolicy } from './_shared'
export const dynamic = 'force-dynamic'
export async function GET(req: Request) {
  try {
    const { ctx, scope, role } = await projectScope(req, new URL(req.url).searchParams.get('projectId'))
    const policy = await readPolicy(pool, scope)
    const visiblePolicy = policy ? await visibleTaskPolicy(pool, ctx, role, policy) : null
    const [tasks, resources] = await Promise.all([
      readTasks(pool, scope),
      visiblePolicy ? readResources(pool, scope, visiblePolicy) : Promise.resolve([]),
    ])
    return jsonOk({ tasks, resources, policy })
  } catch (error) {
    return taskError(error)
  }
}
