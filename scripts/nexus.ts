import { realpath } from 'node:fs/promises'
import { Pool } from 'pg'
import { parseArgs } from 'node:util'
import { readAgentConfig, matchLocalWorkspace, TaskRuntimeError } from '../src/lib/task-runtime/configuration'
import { createTask, readTasks, requestTaskAction, requestContinuation } from '../src/lib/task-runtime/store'

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      project: { type: 'string' },
      goal: { type: 'string' },
      instruction: { type: 'string' },
      task: { type: 'string' },
      target: { type: 'string' },
      'persist-context': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  })
  if (values.help || !positionals.length) {
    console.log(
      'Nexus Local Agent\n  npm run nexus -- codex --project ID --goal "task" --persist-context\n  npm run nexus -- status --project ID\n  npm run nexus -- switch --project ID --task ID --target CONNECTION\n  npm run nexus -- resume --project ID --task ID\nRequires NEXUS_SUPERVISOR_CONFIG and the existing Observer process. Profile login/config remains tool-owned.',
    )
    return
  }
  const config = await readAgentConfig()
  if (!config) throw new TaskRuntimeError('NEXUS_SUPERVISOR_CONFIG_required')
  const cwd = await realpath(process.cwd())
  const workspace = values.project
    ? matchLocalWorkspace(config, values.project, cwd)
    : config.workspaces.find((w) => w.cwd === cwd)
  if (!workspace) throw new TaskRuntimeError('workspace_not_registered')
  const scope = { tenantId: config.tenantId, organizationId: config.organizationId, projectId: workspace.projectId }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  try {
    const command = positionals[0]
    if (command === 'codex') {
      const task = await createTask(pool, scope, {
        cwd,
        goal: values.goal ?? '',
        persistContext: values['persist-context'] === true,
      })
      console.log(
        JSON.stringify({
          taskId: task.id,
          status: 'queued',
          projectId: workspace.projectId,
          note: 'Existing Observer executes this task when its supervisor is enabled.',
        }),
      )
    } else if (command === 'status') {
      const tasks = await readTasks(pool, scope)
      console.log(
        JSON.stringify(
          tasks.map((t) => ({
            id: t.id,
            status: t.status,
            resource: t.activeResource,
            handoffs: t.handoffs,
            pauseReason: t.pauseReason,
          })),
          null,
          2,
        ),
      )
    } else if (command === 'continue' && values.task && values.instruction) {
      await requestContinuation(pool, scope, values.task, values.instruction)
      console.log(JSON.stringify({ taskId: values.task, status: 'queued' }))
    } else if ((command === 'resume' || command === 'switch') && values.task) {
      await requestTaskAction(pool, scope, values.task, command, values.target)
      console.log(JSON.stringify({ taskId: values.task, status: 'queued' }))
    } else throw new TaskRuntimeError('invalid_command_use_help')
  } finally {
    await pool.end()
  }
}
main().catch((error) => {
  console.error(error instanceof TaskRuntimeError ? error.code : 'nexus_local_agent_failed')
  process.exitCode = 1
})
