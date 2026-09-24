import type { Pool, PoolClient } from 'pg'
import { TaskRuntimeError } from './configuration'
import { validatePolicy, type RoutingPolicy } from './router'

export interface TaskScope {
  tenantId: string
  organizationId: string
  projectId: string
}
type Database = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>
export interface TaskContext {
  completedWork: string[]
  pendingWork: string[]
  decisions: string[]
  knownFailures: string[]
  lastUserInstruction: string
  lastSuccessfulOperation: string | null
  runtimePid?: number
}
export interface TaskRow {
  id: string
  tenant_id: string
  organization_id: string
  project_id: string
  original_goal: string
  cwd: string
  status: string
  active_resource: string | null
  active_tool: string
  active_session: string | null
  context: TaskContext
  requested_action: 'start' | 'resume' | 'switch' | null
  requested_connection_id: string | null
  command_seq: number
  pause_reason: string | null
  next_reset_at: Date | null
  created_at: Date
  updated_at: Date
}
export const scopeParams = (s: TaskScope) => [s.tenantId, s.organizationId, s.projectId]
export const scopeWhere = 'tenant_id=$1 AND organization_id=$2 AND project_id=$3'
export async function readPolicy(db: Database, scope: TaskScope): Promise<RoutingPolicy | null> {
  const row = (await db.query(`SELECT policy FROM resource_routing_policies WHERE ${scopeWhere}`, scopeParams(scope)))
    .rows[0]
  return row ? validatePolicy(row.policy) : null
}
export async function savePolicy(db: Database, scope: TaskScope, raw: unknown) {
  const policy = validatePolicy(raw)
  const ids = policy.candidates.map((c) => c.connectionId)
  const allowed = await db.query(
    `SELECT id FROM owned_connections WHERE tenant_id=$1 AND id=ANY($4::text[]) AND revoked_at IS NULL
    AND (project_id=$3 OR (project_id IS NULL AND account_observation->>'organizationId'=$2))
    AND (account_observation IS NULL OR account_observation->>'organizationId'=$2)`,
    [...scopeParams(scope), ids],
  )
  if (allowed.rows.length !== ids.length) throw new TaskRuntimeError('inaccessible_policy_connection')
  await db.query(
    `INSERT INTO resource_routing_policies(tenant_id,organization_id,project_id,policy) VALUES($1,$2,$3,$4::jsonb)
    ON CONFLICT(tenant_id,organization_id,project_id) DO UPDATE SET policy=excluded.policy,updated_at=now()`,
    [...scopeParams(scope), JSON.stringify(policy)],
  )
  return policy
}
export async function createTask(
  db: Database,
  scope: TaskScope,
  value: { cwd: string; goal: string; persistContext: boolean },
) {
  if (!value.persistContext || !value.goal.trim() || value.goal.length > 16000 || value.cwd.length > 2048)
    throw new TaskRuntimeError('explicit_task_context_consent_required')
  const context: TaskContext = {
    completedWork: [],
    pendingWork: ['Verify the repository and continue the original goal.'],
    decisions: [],
    knownFailures: [],
    lastUserInstruction: value.goal,
    lastSuccessfulOperation: null,
  }
  const result = await db.query<TaskRow>(
    `INSERT INTO nexus_tasks(tenant_id,organization_id,project_id,original_goal,cwd,context,requested_action)
    SELECT $1,$2,$3,$4,$5,$6::jsonb,'start' FROM projects WHERE ${scopeWhere.replace('project_id', 'id')} AND status='active' AND archived_at IS NULL RETURNING *`,
    [...scopeParams(scope), value.goal, value.cwd, JSON.stringify(context)],
  )
  if (!result.rows[0]) throw new TaskRuntimeError('project_unavailable', 404)
  return result.rows[0]
}
export async function requestTaskAction(
  db: Database,
  scope: TaskScope,
  taskId: string,
  action: 'resume' | 'switch',
  target?: string,
) {
  if (action === 'switch') {
    const policy = await readPolicy(db, scope)
    if (!target || !policy?.candidates.some((c) => c.connectionId === target && c.enabled))
      throw new TaskRuntimeError('invalid_target_resource')
  }
  const result = await db.query(
    `UPDATE nexus_tasks SET requested_action=$5,requested_connection_id=$6,command_seq=command_seq+1,updated_at=now()
    WHERE ${scopeWhere} AND id=$4 AND requested_action IS NULL
    AND (($5='resume' AND status IN ('paused','failed')) OR ($5='switch' AND status IN ('running','resumed','handoff_pending') AND active_resource IS DISTINCT FROM $6)) RETURNING id`,
    [...scopeParams(scope), taskId, action, target ?? null],
  )
  if (!result.rows.length) throw new TaskRuntimeError('task_action_conflict', 409)
}
/** Continue a persistent goal at an explicitly requested idle boundary. */
export async function requestContinuation(db: Database, scope: TaskScope, taskId: string, instruction: string) {
  if (!instruction.trim() || instruction.length > 16000) throw new TaskRuntimeError('invalid_continuation')
  const result = await db.query(
    `UPDATE nexus_tasks SET status='paused',requested_action='resume',command_seq=command_seq+1,
    context=jsonb_set(context,'{lastUserInstruction}',to_jsonb($5::text)),updated_at=now()
    WHERE ${scopeWhere} AND id=$4 AND requested_action IS NULL AND status IN ('completed','paused','failed') RETURNING id`,
    [...scopeParams(scope), taskId, instruction],
  )
  if (!result.rows.length) throw new TaskRuntimeError('task_action_conflict', 409)
}
export async function readTasks(db: Database, scope: TaskScope) {
  const tasks = (
    await db.query<TaskRow>(
      `SELECT * FROM nexus_tasks WHERE ${scopeWhere} ORDER BY created_at DESC LIMIT 100`,
      scopeParams(scope),
    )
  ).rows
  if (!tasks.length) return []
  const ids = tasks.map((t) => t.id)
  const sessions = (
    await db.query(
      `SELECT s.* FROM task_sessions s JOIN nexus_tasks t ON t.id=s.task_id AND t.tenant_id=s.tenant_id AND t.organization_id=s.organization_id
    WHERE t.tenant_id=$1 AND t.organization_id=$2 AND t.project_id=$3 AND s.task_id=ANY($4::text[]) ORDER BY s.started_at`,
      [...scopeParams(scope), ids],
    )
  ).rows
  const usage = (
    await db.query(
      `SELECT s.task_id,COALESCE(e.connection_id,s.connection_id) connection_id,CASE WHEN count(e.id)=0 OR count(e.total_tokens)<count(e.id) THEN NULL ELSE sum(e.total_tokens)::text END total_tokens
    FROM task_sessions s JOIN nexus_tasks t ON t.id=s.task_id AND t.tenant_id=s.tenant_id AND t.organization_id=s.organization_id
    LEFT JOIN external_observed_usage e ON e.tenant_id=s.tenant_id AND e.organization_id=s.organization_id AND e.external_session_id=s.external_session_id AND e.project_id=t.project_id
    WHERE t.tenant_id=$1 AND t.organization_id=$2 AND t.project_id=$3 AND s.task_id=ANY($4::text[]) GROUP BY s.task_id,COALESCE(e.connection_id,s.connection_id)`,
      [...scopeParams(scope), ids],
    )
  ).rows
  const snapshots = (
    await db.query(
      `SELECT id,task_id,source_connection_id,source_session_id,target_connection_id,reason,created_at FROM task_handoff_snapshots WHERE tenant_id=$1 AND organization_id=$2 AND task_id=ANY($3::text[]) ORDER BY created_at`,
      [scope.tenantId, scope.organizationId, ids],
    )
  ).rows
  const transitions = (
    await db.query(
      `SELECT id,task_id,source_connection_id,target_connection_id,source_conversation_id,target_conversation_id,switch_type,reason,created_at
       FROM task_resource_transitions WHERE tenant_id=$1 AND organization_id=$2 AND task_id=ANY($3::text[])
       ORDER BY created_at,id`,
      [scope.tenantId, scope.organizationId, ids],
    )
  ).rows
  return tasks.map((t) => ({
    id: t.id,
    projectId: t.project_id,
    originalGoal: t.original_goal,
    cwd: t.cwd,
    status: t.status,
    activeResource: t.active_resource,
    activeTool: t.active_tool,
    activeSession: t.active_session,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    pauseReason: t.pause_reason,
    nextResetAt: t.next_reset_at,
    handoffs: transitions.filter((s) => s.task_id === t.id && s.switch_type === 'context_handoff').length,
    history: snapshots.filter((s) => s.task_id === t.id),
    resourceSwitchCount: transitions.filter((s) => s.task_id === t.id).length,
    transitions: transitions.filter((s) => s.task_id === t.id),
    sessions: sessions
      .filter((s) => s.task_id === t.id)
      .map((s) => ({
        id: s.id,
        connectionId: s.connection_id,
        externalSessionId: s.external_session_id,
        status: s.status,
        reason: s.reason,
        startedAt: s.started_at,
        endedAt: s.ended_at,
      })),
    usage: usage
      .filter((u) => u.task_id === t.id)
      .map((u) => ({ connectionId: u.connection_id, totalTokens: u.total_tokens })),
  }))
}
