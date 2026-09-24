import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { ToolAdapter } from '../local-agent/adapter'
import { captureWorkspace, continuationPrompt } from '../local-agent/capture'
import { matchLocalWorkspace, workspaceKey, type AgentConfig } from './configuration'
import { readPolicy, type TaskRow, type TaskScope } from './store'
import { readResources, selectResource, type Resource, type RoutingPolicy } from './router'
import { boundaryDecision, resourceFailures } from './boundary'
import { recordProfileQuota, recordRuntimeFailure } from './quota'

interface Running {
  client: PoolClient
  task: TaskRow
  scope: TaskScope
  adapter: ToolAdapter | null
  reason: string | null
  tried: Set<string>
  quotaAt: number
  preparedAt: number
  leaseLost: boolean
  lockedProfiles: Set<string>
  activeProfileKey: string | null
}

/** One loop inside the existing Observer process; no control-plane filesystem/process access. */
export class TaskSupervisor {
  private running = new Map<string, Running>()
  private ticking: Promise<void> | null = null
  private stopping = false
  constructor(
    private pool: Pool,
    private config: AgentConfig,
    private factory: () => ToolAdapter,
  ) {}
  tick() {
    if (this.ticking) return this.ticking
    this.ticking = this.work().finally(() => {
      this.ticking = null
    })
    return this.ticking
  }
  private async update(run: Running, fields: string, values: unknown[] = []) {
    const result = await run.client.query(
      `UPDATE nexus_tasks SET ${fields},updated_at=now(),heartbeat_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 RETURNING *`,
      [run.scope.tenantId, run.scope.organizationId, run.task.id, ...values],
    )
    if (!result.rows[0]) throw new Error('task_unavailable')
    run.task = result.rows[0]
  }
  private profileKey(home: string) {
    return 'nexus-profile:' + workspaceKey(home)
  }
  private async lockProfile(run: Running, key: string) {
    if (run.lockedProfiles.has(key)) return true
    const result = await run.client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
      [key],
    )
    if (!result.rows[0].locked) return false
    run.lockedProfiles.add(key)
    const profile = this.config.profiles.find((item) => this.profileKey(item.home) === key)!
    try {
      const occupied = await run.client.query(
        `SELECT 1 FROM nexus_tasks t WHERE t.tenant_id=$1 AND t.organization_id=$2 AND t.id<>$5
         AND ((t.active_resource=$4 AND t.status IN ('running','resumed','switching','handoff_pending')
           AND EXISTS (SELECT 1 FROM task_sessions s WHERE s.tenant_id=t.tenant_id AND s.organization_id=t.organization_id
             AND s.task_id=t.id AND s.ended_at IS NULL AND s.status='running'))
          OR EXISTS (SELECT 1 FROM task_sessions s WHERE s.tenant_id=t.tenant_id AND s.organization_id=t.organization_id
             AND s.task_id=t.id AND s.profile_ref=$3 AND s.connection_id=$4 AND s.ended_at IS NULL AND s.status='starting'))
         LIMIT 1`,
        [run.scope.tenantId, run.scope.organizationId, profile.profileRef, profile.connectionId, run.task.id],
      )
      if (occupied.rows.length) {
        await this.unlockProfile(run, key)
        return false
      }
    } catch (error) {
      await this.unlockProfile(run, key).catch(() => {})
      throw error
    }
    return true
  }
  private async unlockProfile(run: Running, key: string) {
    if (!run.lockedProfiles.has(key)) return
    await run.client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key])
    run.lockedProfiles.delete(key)
  }
  private async adoptProfile(run: Running, key: string) {
    if (run.activeProfileKey && run.activeProfileKey !== key) await this.unlockProfile(run, run.activeProfileKey)
    run.activeProfileKey = key
  }
  private async work() {
    if (!this.stopping) {
      const rows = (
        await this.pool.query<TaskRow>(
          `SELECT t.* FROM nexus_tasks t JOIN projects p ON p.id=t.project_id AND p.tenant_id=t.tenant_id AND p.organization_id=t.organization_id
        WHERE t.tenant_id=$1 AND t.organization_id=$2 AND p.status='active' AND p.archived_at IS NULL
        AND (t.requested_action IS NOT NULL OR t.status IN ('running','resumed','switching','handoff_pending')
          OR (t.status='paused' AND t.pause_reason='no_compatible_resources' AND (t.heartbeat_at IS NULL OR t.heartbeat_at<now()-interval '30 seconds')))
        ORDER BY t.created_at LIMIT 100`,
          [this.config.tenantId, this.config.organizationId],
        )
      ).rows
      for (const task of rows) {
        if (
          this.running.size >= 2 ||
          this.running.has(task.id) ||
          !matchLocalWorkspace(this.config, task.project_id, task.cwd)
        )
          continue
        // One task per canonical workspace on this machine, across process/tenant boundaries.
        const client = await this.pool.connect()
        const lock = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [
          'nexus-workspace:' + workspaceKey(task.cwd),
        ])
        if (!lock.rows[0].locked) {
          client.release()
          continue
        }
        const run: Running = {
          client,
          task,
          scope: { tenantId: task.tenant_id, organizationId: task.organization_id, projectId: task.project_id },
          adapter: null,
          reason: null,
          tried: new Set(),
          quotaAt: 0,
          preparedAt: 0,
          leaseLost: false,
          lockedProfiles: new Set(),
          activeProfileKey: null,
        }
        client.on('error', () => {
          run.leaseLost = true
        })
        this.running.set(task.id, run)
        const previous = (
          await client.query<{ id: string; cwd: string; context: { runtimePid?: number } }>(
            "SELECT id,cwd,context FROM nexus_tasks WHERE tenant_id=$1 AND organization_id=$2 AND context ? 'runtimePid'",
            [task.tenant_id, task.organization_id],
          )
        ).rows
        const live = previous.some((t) => {
          if (workspaceKey(t.cwd) !== workspaceKey(task.cwd)) return false
          const pid = t.context.runtimePid
          if (!Number.isSafeInteger(pid) || !pid || pid <= 0) return false
          try {
            process.kill(pid, 0)
            return true
          } catch (error) {
            return (error as NodeJS.ErrnoException).code !== 'ESRCH'
          }
        })
        if (live) {
          await this.pause(run, 'previous_runtime_still_alive')
          continue
        }
        // Any uncertain launch after process death needs explicit human recovery, never automatic replay.
        const resourceRecovery =
          task.status === 'paused' && task.pause_reason === 'no_compatible_resources' && task.requested_action === null
        if (!resourceRecovery && !['start', 'resume'].includes(task.requested_action ?? '')) {
          await this.pause(run, 'supervisor_interrupted')
          continue
        }
        try {
          await this.update(
            run,
            "status='switching',requested_action=NULL,requested_connection_id=NULL,pause_reason=NULL",
          )
          const policy = await readPolicy(client, run.scope)
          if (!policy) {
            await this.pause(run, 'routing_policy_missing')
            continue
          }
          await this.handoff(
            run,
            policy,
            resourceRecovery
              ? 'resource_recovered'
              : task.requested_action === 'start'
                ? 'initial_start'
                : 'manual_resume',
          )
        } catch {
          await this.pause(run, 'launch_uncertain')
        }
      }
    }
    for (const run of [...this.running.values()]) {
      try {
        await this.step(run)
      } catch {
        // Losing persistence cannot authorize another runtime. Wait for active tool boundary.
        run.reason = 'supervisor_error'
        if (run.adapter?.inspect().state !== 'running') await this.pause(run, 'supervisor_error').catch(() => {})
      }
    }
  }
  private async refreshProfiles(run: Running, policy: RoutingPolicy) {
    for (const candidate of policy.candidates.filter(
      (c) => c.enabled && !run.tried.has(c.connectionId) && c.connectionId !== run.task.active_resource,
    )) {
      const profile = this.config.profiles.find(
        (p) => p.profileRef === candidate.profileRef && p.connectionId === candidate.connectionId,
      )
      if (!profile) continue
      const key = this.profileKey(profile.home)
      if (!(await this.lockProfile(run, key))) continue
      const adapter = this.factory()
      try {
        await adapter.launch(profile, run.task.cwd, policy.model)
        if (adapter.readResourceObservation)
          await recordProfileQuota(
            run.client,
            run.scope,
            candidate.connectionId,
            await adapter.readResourceObservation(),
          )
      } catch (error) {
        run.tried.add(candidate.connectionId)
        const reason = error && typeof error === 'object' && 'reason' in error ? String(error.reason) : null
        if (reason && resourceFailures.has(reason))
          await recordRuntimeFailure(run.client, run.scope, candidate.connectionId, reason)
      } finally {
        await adapter.stop().catch(() => {})
        await this.unlockProfile(run, key)
      }
    }
  }
  private async step(run: Running) {
    const adapter = run.adapter
    if (!adapter) return
    if (run.leaseLost) {
      // Observe safe boundaries independently of the dead DB connection. Never
      // authorize a handoff from this recovery path.
      adapter.drainEvents()
      if (adapter.inspect().state === 'running') return
      const pid = adapter.inspect().processId ?? run.task.context.runtimePid
      await adapter.stop()
      if (pid) {
        try {
          process.kill(pid, 0)
          return
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return
        }
      }
      this.running.delete(run.task.id)
      run.client.release(true)
      const recovery = await this.pool.connect().catch(() => null)
      if (recovery) {
        try {
          await recovery.query('BEGIN')
          const ids = [run.scope.tenantId, run.scope.organizationId, run.task.id]
          const ownership = await recovery.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked', [
            'nexus-workspace:' + workspaceKey(run.task.cwd),
          ])
          const unchanged =
            ownership.rows[0].locked &&
            (
              await recovery.query(
                'SELECT id FROM nexus_tasks WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND active_session IS NOT DISTINCT FROM $4 AND command_seq=$5 FOR UPDATE',
                [...ids, run.task.active_session, run.task.command_seq],
              )
            ).rows.length > 0
          if (!unchanged) {
            await recovery.query('ROLLBACK')
            return
          }
          await recovery.query(
            "UPDATE task_sessions SET status='paused',reason='supervisor_interrupted',ended_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND task_id=$3 AND ended_at IS NULL",
            ids,
          )
          await recovery.query(
            "UPDATE nexus_tasks SET status='paused',pause_reason='supervisor_interrupted',requested_action=NULL,requested_connection_id=NULL,context=context-'runtimePid',updated_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND id=$3",
            ids,
          )
          await recovery.query('COMMIT')
        } catch {
          await recovery.query('ROLLBACK').catch(() => {})
        } finally {
          recovery.release()
        }
      }
      return
    }
    // Heartbeat read both proves lease health and consumes durable manual intent.
    await this.update(run, 'status=status')
    const policy = await readPolicy(run.client, run.scope)
    let finished = false
    for (const event of adapter.drainEvents()) {
      if (event.sessionId && event.sessionId !== run.task.active_session) continue
      if (event.type === 'session_failed') {
        const failure = event.reason ?? 'unknown'
        if (!['runtime_uncertain', 'approval_required'].includes(run.reason ?? '')) run.reason = failure
        if (resourceFailures.has(failure) && run.task.active_resource)
          await recordRuntimeFailure(run.client, run.scope, run.task.active_resource, failure)
      }
      if (event.type === 'approval_required') run.reason = 'approval_required'
      if (event.type === 'runtime_uncertain') run.reason = 'runtime_uncertain'
      if (event.type === 'turn_completed') finished = true
      if (event.type === 'progress' && event.operation) {
        const context = { ...run.task.context, lastSuccessfulOperation: event.operation.slice(0, 200) }
        await this.update(run, 'context=$4::jsonb', [JSON.stringify(context)])
      }
      // quota events are advisory wakeups; read current official account/window state below.
      if (event.type === 'quota') run.quotaAt = 0
    }
    if (!policy) run.reason = 'routing_policy_missing'
    if (this.stopping || run.leaseLost) run.reason = 'supervisor_interrupted'
    if (Date.now() - run.quotaAt > 30000 && adapter.readResourceObservation) {
      run.quotaAt = Date.now()
      try {
        await recordProfileQuota(
          run.client,
          run.scope,
          run.task.active_resource!,
          await adapter.readResourceObservation(),
        )
      } catch {
        /* Existing observations age to unknown. An RPC failure is not task failure. */
      }
    }
    if (policy && !run.reason) {
      const resources = await readResources(run.client, run.scope, policy)
      const current = resources.find((r) => r.connectionId === run.task.active_resource)
      if (!current || current.availability === 'temporarily_unavailable') run.reason = 'provider_unavailable'
      else if (current.availability === 'authentication_required') run.reason = 'authentication_failure'
      if (current?.quotaState === 'near_limit' && Date.now() - run.preparedAt > 60000) {
        run.preparedAt = Date.now()
        await this.refreshProfiles(run, policy)
      }
      if (
        current &&
        ['exhausted', 'rate_limited', 'temporarily_unavailable', 'authentication_required'].includes(current.quotaState)
      )
        run.reason =
          current.quotaState === 'exhausted'
            ? 'quota_exhausted'
            : current.quotaState === 'rate_limited'
              ? 'rate_limit'
              : current.quotaState === 'authentication_required'
                ? 'authentication_failure'
                : 'provider_unavailable'
    }
    if (run.task.requested_action === 'switch' && !run.reason) run.reason = 'manual_switch'
    if (run.reason && adapter.inspect().state === 'running') {
      if (run.task.status !== 'handoff_pending')
        await this.update(run, "status='handoff_pending',pause_reason=$4", [run.reason])
      return
    }
    if (!finished && !run.reason && adapter.inspect().state !== 'failed') return
    const decision = boundaryDecision({
      state: adapter.inspect().state,
      reason: run.reason,
      autoFailover: policy?.autoFailover ?? false,
    })
    if (decision === 'wait') return
    if (decision === 'switch' && policy) {
      await this.handoff(run, policy, run.reason!)
      return
    }
    if (decision === 'complete') {
      await this.checkpoint(run)
      await this.finishSession(run, 'completed', null)
      await this.update(run, "status='completed',pause_reason=NULL,requested_action=NULL,requested_connection_id=NULL")
      await this.release(run)
    } else await this.pause(run, run.reason ?? 'runtime_failed', decision === 'fail' ? 'failed' : 'paused')
  }
  private async finishSession(run: Running, status: string, reason: string | null) {
    await run.client.query(
      `UPDATE task_sessions SET status=$4,reason=$5,ended_at=now() WHERE tenant_id=$1 AND organization_id=$2 AND task_id=$3 AND ended_at IS NULL`,
      [run.scope.tenantId, run.scope.organizationId, run.task.id, status, reason],
    )
  }
  private async handoff(run: Running, policy: RoutingPolicy, reason: string) {
    if (run.adapter?.inspect().state === 'running') throw new Error('unsafe_boundary')
    await this.checkpoint(run)
    const source = run.task.active_resource
    const sourceSession = run.task.active_session
    const commandSeq = run.task.command_seq
    const target = run.task.requested_action === 'switch' ? (run.task.requested_connection_id ?? undefined) : undefined
    if (source && !['manual_resume', 'resource_recovered'].includes(reason)) run.tried.add(source)
    // A long turn can outlive every fallback observation. Re-read the isolated
    // candidate profiles at the safe boundary before making a routing decision.
    await this.refreshProfiles(run, policy)
    const resources = (await readResources(run.client, run.scope, policy)).filter((r) =>
      this.config.profiles.some((p) => p.connectionId === r.connectionId && p.profileRef === r.profileRef),
    )
    let selection = selectResource(resources, policy, {
      exclude: [...run.tried],
      targetConnectionId: target,
      currentConnectionId: ['manual_resume', 'resource_recovered'].includes(reason) ? (source ?? undefined) : undefined,
    })
    // A healthy current resource remains preferred on explicit continuation or recovery.
    if (['manual_resume', 'resource_recovered'].includes(reason) && source && !target) {
      const current = selectResource(resources, policy, { exclude: [...run.tried], targetConnectionId: source })
      if (current.selected) selection = current
    }
    // A profile is a single local account runtime, even when multiple workspaces
    // have independent Task locks. Reserve it before any target RPC or launch.
    const busy = new Set<string>()
    while (selection.selected) {
      const candidate = selection.selected
      const profile = this.config.profiles.find(
        (p) => p.connectionId === candidate.connectionId && p.profileRef === candidate.profileRef,
      )!
      if (await this.lockProfile(run, this.profileKey(profile.home))) break
      busy.add(candidate.connectionId)
      selection = selectResource(resources, policy, {
        exclude: [...run.tried, ...busy],
        targetConnectionId: target,
        currentConnectionId: ['manual_resume', 'resource_recovered'].includes(reason)
          ? (source ?? undefined)
          : undefined,
      })
    }
    // Persist actual workspace state before every transition, even an empty fallback pool.
    const workspaceState = await captureWorkspace(run.task.cwd)
    const context = {
      ...run.task.context,
      originalGoal: run.task.original_goal,
      currentUserInstruction: run.task.context.lastUserInstruction,
      projectId: run.task.project_id,
      workspace: run.task.cwd,
      cwd: run.task.cwd,
      currentBranch: workspaceState.branch,
      taskStatus: run.task.status,
      status: run.task.status,
      importantDecisions: run.task.context.decisions,
      modifiedFiles: workspaceState.modifiedFiles,
      gitStatus: workspaceState.gitStatus,
      gitDiffSummary: workspaceState.diffStatistics,
      relevantCommands: run.task.context.completedWork.filter((item) => item.includes('commandExecution')).slice(-20),
      relevantTestResults: run.task.context.completedWork
        .filter((item) => /category=(?:test|typecheck|lint|build)/.test(item))
        .slice(-20),
      sourceTool: run.task.active_tool,
      sourceConversation: sourceSession,
      sourceResource: source,
      sourceSession,
      workspaceState,
      knownFailures: [...run.task.context.knownFailures, ...(resourceFailures.has(reason) ? [reason] : [])].slice(-20),
    }
    await this.update(run, 'context=$4::jsonb', [
      JSON.stringify({ ...run.task.context, knownFailures: context.knownFailures }),
    ])
    if (!selection.selected) {
      await this.update(run, 'next_reset_at=$4', [selection.nextResetAt])
      await this.pause(run, 'no_compatible_resources')
      return
    }
    await this.update(
      run,
      "status='switching',requested_action=CASE WHEN command_seq=$4 THEN NULL ELSE requested_action END,requested_connection_id=CASE WHEN command_seq=$4 THEN NULL ELSE requested_connection_id END,pause_reason=NULL",
      [commandSeq],
    )
    const selected = selection.selected
    const prompt = continuationPrompt(context)
    const targetProfile = this.config.profiles.find(
      (p) => p.connectionId === selected.connectionId && p.profileRef === selected.profileRef,
    )!
    const targetProfileKey = this.profileKey(targetProfile.home)
    if (source && sourceSession) {
      const currentAdapter = run.adapter
      try {
        if (
          currentAdapter?.canSwitchResourceInPlace &&
          currentAdapter.switchResourceInPlace &&
          (await currentAdapter.canSwitchResourceInPlace(sourceSession, targetProfile))
        ) {
          const same = await currentAdapter.switchResourceInPlace(sourceSession, targetProfile)
          if (same !== sourceSession) throw new Error('conversation_changed_during_in_place_switch')
          await this.bindSameConversation(run, source, selected, sourceSession, 'in_place', reason)
          await this.adoptProfile(run, targetProfileKey)
          await this.submitContinuation(currentAdapter, sourceSession, prompt)
          return
        }
        // A second runtime may see a live writer lock as a missing/unloadable
        // conversation. Release the old runtime before testing disk-backed resume.
        await this.stopRuntime(run)
        run.adapter = null
        await this.adoptProfile(run, targetProfileKey)
        const probe = this.factory()
        if (
          probe.canResumeConversation &&
          (await probe.canResumeConversation(sourceSession, targetProfile, run.task.cwd, policy.model))
        ) {
          await this.resumeConversation(run, policy, selected, source, sourceSession, reason, prompt)
          return
        }
        // A tool that reports migration support must provide an actual migration operation;
        // an unverified positive capability must not silently become a new conversation.
        if (probe.canMigrateConversation && (await probe.canMigrateConversation(sourceSession, targetProfile))) {
          await this.pause(run, 'conversation_migration_required')
          return
        }
      } catch {
        await this.pause(run, 'conversation_continuity_unknown')
        return
      }
    }
    await this.finishSession(run, resourceFailures.has(reason) ? 'failed' : 'stopped', reason)
    await this.stopRuntime(run)
    run.adapter = null
    await this.adoptProfile(run, targetProfileKey)
    if (source)
      await run.client.query(
        `INSERT INTO task_handoff_snapshots(tenant_id,organization_id,task_id,source_connection_id,source_session_id,target_connection_id,reason,workspace_state,handoff_summary)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
        [
          run.scope.tenantId,
          run.scope.organizationId,
          run.task.id,
          source,
          sourceSession,
          selected.connectionId,
          reason,
          JSON.stringify(workspaceState),
          JSON.stringify(context),
        ],
      )
    await this.launch(run, policy, selected, prompt, source !== null, source, sourceSession, reason)
  }
  private async recordTransition(
    run: Running,
    source: string | null,
    resource: Resource,
    sourceSession: string | null,
    targetSession: string,
    switchType: 'in_place' | 'runtime_restart' | 'context_handoff',
    reason: string,
  ) {
    if (!source) return
    await run.client.query(
      `INSERT INTO task_resource_transitions(tenant_id,organization_id,task_id,source_connection_id,target_connection_id,source_conversation_id,target_conversation_id,switch_type,reason)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        run.scope.tenantId,
        run.scope.organizationId,
        run.task.id,
        source,
        resource.connectionId,
        sourceSession,
        targetSession,
        switchType,
        reason,
      ],
    )
  }
  private async bindSameConversation(
    run: Running,
    source: string,
    resource: Resource,
    sessionId: string,
    switchType: 'in_place' | 'runtime_restart',
    reason: string,
  ) {
    await run.client.query('BEGIN')
    try {
      const bound = await run.client.query(
        `UPDATE task_sessions SET status='running',ended_at=NULL,reason=NULL WHERE tenant_id=$1 AND organization_id=$2 AND task_id=$3 AND external_session_id=$4 RETURNING id`,
        [run.scope.tenantId, run.scope.organizationId, run.task.id, sessionId],
      )
      if (bound.rowCount !== 1) throw new Error('conversation_binding_missing')
      await this.recordTransition(run, source, resource, sessionId, sessionId, switchType, reason)
      await this.update(run, 'active_resource=$4,active_session=$5,status=$6,next_reset_at=NULL', [
        resource.connectionId,
        sessionId,
        'resumed',
      ])
      await run.client.query('COMMIT')
    } catch (error) {
      await run.client.query('ROLLBACK')
      throw error
    }
    run.reason = null
  }
  private async resumeConversation(
    run: Running,
    policy: RoutingPolicy,
    resource: Resource,
    source: string,
    sessionId: string,
    reason: string,
    prompt: string,
  ) {
    const profile = this.config.profiles.find(
      (p) => p.profileRef === resource.profileRef && p.connectionId === resource.connectionId,
    )!
    const adapter = this.factory()
    run.adapter = adapter
    await adapter.launch(profile, run.task.cwd, policy.model)
    if (adapter.inspect().processId)
      await this.update(run, 'context=$4::jsonb', [
        JSON.stringify({ ...run.task.context, runtimePid: adapter.inspect().processId }),
      ])
    if (!adapter.resumeSession || (await adapter.resumeSession(sessionId)) !== sessionId)
      throw new Error('conversation_resume_unverified')
    await this.bindSameConversation(run, source, resource, sessionId, 'runtime_restart', reason)
    await this.submitContinuation(adapter, sessionId, prompt)
  }
  private async submitContinuation(adapter: ToolAdapter, sessionId: string, prompt: string) {
    try {
      await adapter.submit(sessionId, prompt)
    } catch {
      if (!['running', 'failed'].includes(adapter.inspect().state)) throw new Error('submission_uncertain')
    }
  }
  private async launch(
    run: Running,
    policy: RoutingPolicy,
    resource: Resource,
    prompt: string,
    resumed: boolean,
    source: string | null = null,
    sourceSession: string | null = null,
    reason = 'initial_start',
  ) {
    const profile = this.config.profiles.find(
      (p) => p.profileRef === resource.profileRef && p.connectionId === resource.connectionId,
    )!
    const sessionId = randomUUID()
    await run.client.query(
      `INSERT INTO task_sessions(id,tenant_id,organization_id,task_id,connection_id,profile_ref,status) VALUES($1,$2,$3,$4,$5,$6,'starting')`,
      [
        sessionId,
        run.scope.tenantId,
        run.scope.organizationId,
        run.task.id,
        resource.connectionId,
        resource.profileRef,
      ],
    )
    const adapter = this.factory()
    run.adapter = adapter
    run.reason = null
    await adapter.launch(profile, run.task.cwd, policy.model)
    if (adapter.inspect().processId)
      await this.update(run, 'context=$4::jsonb', [
        JSON.stringify({ ...run.task.context, runtimePid: adapter.inspect().processId }),
      ])
    const external = await adapter.startSession()
    await run.client.query(
      "UPDATE task_sessions SET external_session_id=$4,status='running' WHERE tenant_id=$1 AND organization_id=$2 AND id=$3",
      [run.scope.tenantId, run.scope.organizationId, sessionId, external],
    )
    await this.recordTransition(run, source, resource, sourceSession, external, 'context_handoff', reason)
    await this.update(run, 'active_resource=$4,active_session=$5,status=$6,next_reset_at=NULL', [
      resource.connectionId,
      external,
      resumed ? 'resumed' : 'running',
    ])
    // Binding is durable before dispatch. A lost response must never blindly re-submit.
    await this.submitContinuation(adapter, external, prompt)
  }
  private async checkpoint(run: Running) {
    if (!run.adapter?.readContext) return
    try {
      const captured = await run.adapter.readContext()
      const context = {
        ...run.task.context,
        completedWork: [...new Set([...run.task.context.completedWork, ...captured.completedWork])].slice(-30),
        pendingWork: captured.pendingWork.length ? captured.pendingWork : run.task.context.pendingWork,
        decisions: [...new Set([...run.task.context.decisions, ...captured.decisions])].slice(-20),
        knownFailures: [...new Set([...run.task.context.knownFailures, ...captured.knownFailures])].slice(-20),
        lastUserInstruction: run.task.context.lastUserInstruction,
      }
      await this.update(run, 'context=$4::jsonb', [JSON.stringify(context)])
    } catch {
      /* A dead runtime cannot supply context; repository evidence is still authoritative. */
    }
  }
  private async pause(run: Running, reason: string, status = 'paused') {
    if (run.adapter?.inspect().state === 'running') {
      run.reason = reason
      return
    }
    await this.finishSession(run, status, reason)
    await this.update(run, 'status=$4,pause_reason=$5,requested_action=NULL,requested_connection_id=NULL', [
      status,
      reason,
    ])
    await this.release(run)
  }
  private async release(run: Running) {
    await this.stopRuntime(run)
    this.running.delete(run.task.id)
    run.client.release(true)
  }
  private async stopRuntime(run: Running) {
    // A recovered PID belongs to the old process, not to this supervisor. Its
    // durable context fences future launches, but we must never stop/adopt it.
    if (!run.adapter) return
    const pid = run.adapter?.inspect().processId ?? run.task.context.runtimePid
    await run.adapter?.stop()
    if (pid) {
      let alive = true
      try {
        process.kill(pid, 0)
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'
      }
      if (alive) throw new Error('runtime_stop_uncertain')
      // A user may queue a continuation during shutdown. Remove only our PID;
      // replacing the cached context would overwrite their latest instruction.
      await this.update(run, "context=context-'runtimePid'")
    }
  }
  async stop() {
    this.stopping = true
    await this.ticking
    // Gracefully drain current turns; never kill a tool halfway through an external action.
    while (this.running.size) {
      await this.tick()
      if (this.running.size) await new Promise((r) => setTimeout(r, 250))
    }
  }
}
