import { pool } from '@/db'
import { jsonOk } from '../_lib/control-plane'
import { readPolicy, readTasks } from '@/lib/task-runtime/store'
import { readResources } from '@/lib/task-runtime/router'
import { projectScope, taskError } from './_shared'
export const dynamic = 'force-dynamic'
export async function GET(req: Request) {
  try {
    const { scope } = await projectScope(req, new URL(req.url).searchParams.get('projectId'))
    const policy = await readPolicy(pool, scope)
    const [tasks, resources] = await Promise.all([
      readTasks(pool, scope),
      policy ? readResources(pool, scope, policy) : Promise.resolve([]),
    ])
    return jsonOk({ tasks, resources, policy })
  } catch (error) {
    return taskError(error)
  }
}
