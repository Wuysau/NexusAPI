import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ResourceObservation, RuntimeContext, RuntimeEvent, RuntimeFailureReason, ToolAdapter } from './adapter'
import { mapAccount, mapQuotas } from '../subscriptions/codex/mapper'

const MAX_BUFFER = 4 * 1024 * 1024
const MAX_EVENTS = 256
type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {}
}

function commandCategory(value: unknown) {
  if (typeof value !== 'string' || value.length > 120) return 'other'
  // Only exact single commands are recognized. Shell wrappers, arguments,
  // assignments and compound commands remain opaque, never copied into context.
  const match =
    /^\s*npm(?:\.cmd)?\s+(?:run\s+)?(test(?::(?:unit|contract|integration|security|e2e))?|build|lint|typecheck|db:migrate|db:migration:verify)\s*$/.exec(
      value,
    )
  return match?.[1] ?? 'other'
}

function checkpointItem(context: RuntimeContext, value: unknown) {
  const item = record(value)
  if (typeof item.id !== 'string' || item.id.length > 256) return
  if (item.type !== 'commandExecution' && item.type !== 'fileChange') return
  // Stable references permit reconciliation without preserving arbitrary identifiers
  // (which can themselves contain a token, a path or other private text).
  const reference = createHash('sha256').update(item.id).digest('hex').slice(0, 16)
  const label = `${item.type} item=${reference}${item.type === 'commandExecution' ? ` category=${commandCategory(item.command)}` : ''}`
  if (item.status === 'inProgress') {
    context.pendingWork.push(`${label}; Verify outcome before continuing. Do not replay an uncertain operation.`)
  } else if (item.type === 'commandExecution') {
    if (!Number.isSafeInteger(item.exitCode)) return
    const fact = `${label} exitCode=${item.exitCode}`
    if (item.status === 'completed' && item.exitCode === 0) context.completedWork.push(fact)
    else if (item.status === 'completed' || item.status === 'failed') context.knownFailures.push(fact)
  } else if (item.status === 'completed') context.completedWork.push(`${label} completed`)
  else if (item.status === 'failed' || item.status === 'declined') context.knownFailures.push(`${label} ${item.status}`)
}

/** Only protocol errors reach here. Never inspect tool output or error-message prose. */
export function normalizeRuntimeFailure(value: unknown): RuntimeFailureReason {
  const error = record(value)
  const info = error.codexErrorInfo ?? record(error.data).codexErrorInfo ?? error.code
  if (info === 'usageLimitExceeded' || info === 'insufficient_quota' || info === 'quota_exhausted')
    return 'quota_exhausted'
  if (info === 'rateLimitExceeded' || info === 'rate_limit_exceeded') return 'rate_limit'
  if (info === 'unauthorized' || info === 'authentication_error' || info === 'invalid_api_key')
    return 'authentication_failure'
  if (info === 'serverOverloaded' || info === 'internalServerError') return 'provider_unavailable'
  for (const variant of ['httpConnectionFailed', 'responseStreamConnectionFailed']) {
    const status = record(record(info)[variant]).httpStatusCode
    if (status === 401 || status === 403) return 'authentication_failure'
    if (status === 429) return 'rate_limit'
    if (typeof status === 'number' && status >= 500 && status <= 599) return 'provider_unavailable'
  }
  // A disconnected stream or exhausted retries may follow a completed external action.
  // Preserve unknown instead of automatically launching another session.
  return 'unknown'
}

export class CodexAdapterError extends Error {
  constructor(
    public readonly code: string,
    public readonly reason: RuntimeFailureReason = 'unknown',
  ) {
    super(code)
  }
}

function executable() {
  const configured = process.env.NEXUS_CODEX_EXECUTABLE
  if (configured) {
    if (!path.isAbsolute(configured) || !existsSync(configured)) throw new CodexAdapterError('app_server_unavailable')
    return configured
  }
  if (process.platform !== 'win32') return 'codex'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const root = path.join(directory, 'node_modules', '@openai', 'codex')
    for (const candidate of [
      path.join(directory, 'codex.exe'),
      path.join(root, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', triple, 'bin', 'codex.exe'),
      path.join(root, 'vendor', triple, 'bin', 'codex.exe'),
    ])
      if (existsSync(candidate)) return candidate
  }
  throw new CodexAdapterError('app_server_unavailable')
}

function isolatedEnvironment(home: string) {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: 'production' }
  // Do not pass observer database credentials, ambient API identities, or parent Codex session controls.
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|LANG|LC_ALL|TZ)$/i.test(
        key,
      )
    )
      environment[key] = value
  }
  environment.CODEX_HOME = home
  return environment
}

/** Codex app-server stdio protocol verified with the installed generate-json-schema command.
 * The caller supplies only locally registered profile paths, never HTTP-provided paths.
 */
export class CodexAdapter implements ToolAdapter {
  private child: ChildProcessWithoutNullStreams | null = null
  private state: 'idle' | 'running' | 'failed' | 'stopped' = 'stopped'
  private sessionId: string | null = null
  private cwd = ''
  private model: string | null = null
  private serial = 0
  private buffer = ''
  private events: RuntimeEvent[] = []
  private approvalRequired = false
  private transportBroken = false
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
      method: string
      threadId?: string
    }
  >()

  constructor(private readonly options: { executable?: string; args?: string[]; requestTimeoutMs?: number } = {}) {}

  async launch(profile: { profileRef: string; home: string }, cwd: string, model: string | null) {
    if (this.child || this.state === 'running') throw new CodexAdapterError('runtime_busy')
    if (!profile.profileRef || !path.isAbsolute(profile.home) || !path.isAbsolute(cwd))
      throw new CodexAdapterError('invalid_profile')
    const [home, workspace] = await Promise.all([realpath(profile.home), realpath(cwd)])
    const sharedHomes = [path.join(os.homedir(), '.codex'), process.env.CODEX_HOME].filter(
      (value): value is string => !!value,
    )
    for (const shared of sharedHomes) {
      const resolved = await realpath(shared).catch(() => path.resolve(shared))
      if (path.relative(resolved, home) === '') throw new CodexAdapterError('shared_profile_forbidden')
    }
    const relativeHome = path.relative(workspace, home)
    if (
      !relativeHome ||
      (!relativeHome.startsWith(`..${path.sep}`) && relativeHome !== '..' && !path.isAbsolute(relativeHome))
    )
      throw new CodexAdapterError('profile_inside_workspace')
    this.cwd = workspace
    this.model = model
    this.sessionId = null
    this.events = []
    this.approvalRequired = false
    this.transportBroken = false
    this.state = 'idle'
    const child = spawn(this.options.executable ?? executable(), this.options.args ?? ['app-server', '--stdio'], {
      cwd: workspace,
      env: isolatedEnvironment(home),
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stderr.resume() // Diagnostics may contain credentials or model text; never retain them.
    child.on('error', () => this.transportFailed(child))
    child.on('close', () => this.processClosed(child))
    child.stdin.on('error', () => this.transportFailed(child))
    child.stdout.on('error', () => this.transportFailed(child))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.receive(child, chunk))
    try {
      await this.request('initialize', {
        clientInfo: { name: 'nexus_local_agent', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      })
      this.send({ method: 'initialized' })
    } catch (error) {
      this.transportFailed(child)
      throw error
    }
  }

  async startSession(): Promise<string> {
    if (this.state !== 'idle' || this.sessionId) throw new CodexAdapterError('runtime_busy')
    const result = record(
      await this.request('thread/start', {
        cwd: this.cwd,
        model: this.model,
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
      }),
    )
    const id = record(result.thread).id
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new CodexAdapterError('invalid_session')
    this.sessionId = id
    return id
  }

  async canSwitchResourceInPlace(_sessionId: string, _targetProfile: { profileRef: string; home: string }) {
    return false
  }

  async switchResourceInPlace(
    _sessionId: string,
    _targetProfile: { profileRef: string; home: string },
  ): Promise<string> {
    throw new CodexAdapterError('in_place_switch_unsupported')
  }

  async canMigrateConversation(_sessionId: string, _targetProfile: { profileRef: string; home: string }) {
    return false
  }

  /** Ask the target runtime to load the existing thread without starting a turn.
   * `thread/read` only inspects already-loaded threads on current Codex builds.
   * Unknown resume failures cannot authorize a new conversation.
   */
  async canResumeConversation(
    sessionId: string,
    targetProfile: { profileRef: string; home: string },
    cwd?: string,
    model?: string | null,
  ): Promise<boolean> {
    if (this.state === 'running' || !(this.cwd || cwd)) throw new CodexAdapterError('runtime_busy')
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) throw new CodexAdapterError('invalid_session')
    const probe = new CodexAdapter(this.options)
    await probe.launch(targetProfile, this.cwd || cwd!, model ?? this.model)
    try {
      const result = record(await probe.request('thread/resume', { threadId: sessionId, excludeTurns: true }))
      const id = record(result.thread).id
      if (id !== sessionId) throw new CodexAdapterError('conversation_id_mismatch')
      return true
    } catch (error) {
      if (error instanceof CodexAdapterError && error.code === 'runtime_thread_not_found') return false
      throw error
    } finally {
      await probe.stop()
    }
  }

  async resumeSession(sessionId: string): Promise<string> {
    if (this.state !== 'idle' || this.sessionId) throw new CodexAdapterError('runtime_busy')
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) throw new CodexAdapterError('invalid_session')
    const result = record(
      await this.request('thread/resume', {
        threadId: sessionId,
        cwd: this.cwd,
        model: this.model,
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        excludeTurns: true,
      }),
    )
    if (record(result.thread).id !== sessionId) throw new CodexAdapterError('conversation_id_mismatch')
    this.sessionId = sessionId
    return sessionId
  }

  async submit(sessionId: string, prompt: string) {
    if (this.state !== 'idle' || sessionId !== this.sessionId) throw new CodexAdapterError('runtime_busy')
    if (prompt.length > 256 * 1024) throw new CodexAdapterError('prompt_too_large')
    this.state = 'running'
    this.approvalRequired = false
    try {
      await this.request('turn/start', {
        threadId: sessionId,
        input: [{ type: 'text', text: prompt }],
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [this.cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      })
    } catch (error) {
      // RPC errors are a rejected turn; transport uncertainty is handled separately.
      if (this.state === 'running' && error instanceof CodexAdapterError && error.code === 'runtime_request_failed')
        this.fail(error.reason)
      throw error
    }
  }

  inspect() {
    return { state: this.state, sessionId: this.sessionId, ...(this.child?.pid ? { processId: this.child.pid } : {}) }
  }
  drainEvents() {
    return this.events.splice(0)
  }
  readQuota() {
    return this.request('account/rateLimits/read', {})
  }
  readAccount() {
    return this.request('account/read', { refreshToken: false })
  }

  async readResourceObservation(): Promise<ResourceObservation> {
    const account = mapAccount(await this.readAccount())
    if (!account) throw new CodexAdapterError('authentication_failure', 'authentication_failure')
    const quotas = mapQuotas(await this.readQuota())
    const identity = account.email
      ? createHash('sha256')
          .update(account.type + '\0' + account.email.toLowerCase())
          .digest('hex')
      : null
    return { source: 'codex_app_server', identity, account, quotas }
  }

  /** Opt-in checkpoint at a safe boundary. No assistant/user prose or tool output is returned.
   * Installed schemas deprecate full `thread/read includeTurns:true` hydration; use
   * bounded pages instead, without following cursors or loading arbitrary history.
   */
  async readContext(): Promise<RuntimeContext> {
    if (!this.sessionId || !['idle', 'failed'].includes(this.state)) throw new CodexAdapterError('runtime_busy')
    const context: RuntimeContext = {
      completedWork: [],
      pendingWork: [],
      decisions: [],
      lastUserInstruction: null,
      knownFailures: [],
    }
    const turns = record(
      await this.request('thread/turns/list', {
        threadId: this.sessionId,
        limit: 3,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      }),
    )
    if (!Array.isArray(turns.data)) throw new CodexAdapterError('runtime_protocol_error')
    let remaining = 20
    for (const value of turns.data.slice(0, 3)) {
      if (!remaining) break
      const turn = record(value)
      if (typeof turn.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(turn.id)) continue
      const items = record(
        await this.request('thread/items/list', {
          threadId: this.sessionId,
          turnId: turn.id,
          limit: remaining,
          sortDirection: 'desc',
        }),
      )
      if (!Array.isArray(items.data)) throw new CodexAdapterError('runtime_protocol_error')
      const entries = items.data.slice(0, remaining)
      remaining -= entries.length
      for (const entry of entries) {
        const item = record(entry)
        if (item.turnId === turn.id) checkpointItem(context, item.item)
      }
    }
    return context
  }

  async stop() {
    if (this.state === 'running') throw new CodexAdapterError('runtime_busy')
    const child = this.child
    this.state = 'stopped'
    this.rejectPending()
    this.buffer = ''
    if (child) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new CodexAdapterError('runtime_stop_timeout')), 5000)
        child.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
        child.stdin.destroy()
        child.kill()
      })
    }
  }

  private push(event: RuntimeEvent) {
    if (this.events.length >= MAX_EVENTS) {
      const progress = this.events.findIndex((entry) => entry.type === 'progress' || entry.type === 'quota')
      if (progress >= 0) this.events.splice(progress, 1)
      else if (event.type === 'progress' || event.type === 'quota') return
      else this.events.shift()
    }
    this.events.push(event)
  }

  private fail(reason: RuntimeFailureReason) {
    if (this.state === 'failed' || this.state === 'stopped') return
    this.state = 'failed'
    this.push({ type: 'session_failed', ...(this.sessionId ? { sessionId: this.sessionId } : {}), reason })
  }

  private transportFailed(child: ChildProcessWithoutNullStreams) {
    if (this.child !== child || this.transportBroken) return
    this.transportBroken = true
    this.buffer = ''
    this.rejectPending('runtime_uncertain')
    if (this.state === 'running') {
      // Losing the protocol does not establish that commands have stopped. Retain
      // the PID and workspace ownership until close; never kill an uncertain turn.
      this.push({ type: 'runtime_uncertain', ...(this.sessionId ? { sessionId: this.sessionId } : {}) })
    } else {
      child.stdin.destroy()
      child.kill()
    }
  }

  private processClosed(child: ChildProcessWithoutNullStreams) {
    if (this.child !== child) return
    this.child = null
    this.buffer = ''
    this.rejectPending()
    this.fail('unknown')
  }

  private rejectPending(code = 'runtime_unavailable') {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new CodexAdapterError(code))
    }
    this.pending.clear()
  }

  private send(message: unknown) {
    if (this.transportBroken || !this.child || !this.child.stdin.writable)
      throw new CodexAdapterError('runtime_unavailable')
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child) return Promise.reject(new CodexAdapterError('runtime_unavailable'))
    return new Promise((resolve, reject) => {
      const id = ++this.serial
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // Timeout does not prove the turn failed. Keep running until terminal notification
        // or process death, so the supervisor cannot switch across an uncertain tool call.
        reject(new CodexAdapterError('runtime_timeout'))
      }, this.options.requestTimeoutMs ?? 20000)
      const threadId = record(params).threadId
      this.pending.set(id, { resolve, reject, timer, method, ...(typeof threadId === 'string' ? { threadId } : {}) })
      try {
        this.send({ id, method, params })
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new CodexAdapterError('runtime_unavailable'))
      }
    })
  }

  private receive(child: ChildProcessWithoutNullStreams, chunk: string) {
    if (this.child !== child || this.transportBroken) return
    this.buffer += chunk
    if (this.buffer.length > MAX_BUFFER) return this.transportFailed(child)
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue
      try {
        this.handle(record(JSON.parse(line)))
      } catch {
        this.transportFailed(child)
        return
      }
    }
  }

  private handle(message: RecordValue) {
    if (typeof message.method === 'string') {
      const params = record(message.params)
      if (message.id !== undefined) {
        // Cancellation is an explicit denial; it cannot authorize execution or policy changes.
        this.approvalRequired = true
        this.push({ type: 'approval_required', ...(this.sessionId ? { sessionId: this.sessionId } : {}) })
        if (
          message.method === 'item/commandExecution/requestApproval' ||
          message.method === 'item/fileChange/requestApproval'
        )
          this.send({ id: message.id, result: { decision: 'cancel' } })
        else if (message.method === 'item/permissions/requestApproval')
          this.send({ id: message.id, result: { permissions: {}, scope: 'turn' } })
        else this.send({ id: message.id, error: { code: -32601, message: 'Interactive request requires user review' } })
        return
      }
      if (params.threadId !== this.sessionId || !this.sessionId) return
      if (message.method === 'turn/completed') {
        const turn = record(params.turn)
        if (turn.status === 'completed' && !this.approvalRequired) {
          this.state = 'idle'
          this.push({ type: 'turn_completed', sessionId: this.sessionId })
        } else if (this.approvalRequired) {
          this.state = 'idle'
        } else this.fail(normalizeRuntimeFailure(turn.error))
      } else if (message.method === 'item/completed') {
        const item = record(params.item)
        const operation = item.type
        const successful =
          item.status === 'completed' &&
          ((operation === 'commandExecution' && item.exitCode === 0) ||
            operation === 'fileChange' ||
            (operation === 'mcpToolCall' && !item.error))
        if (successful && typeof operation === 'string')
          this.push({ type: 'progress', sessionId: this.sessionId, operation })
      }
      // Ignore error notifications that may be retried; turn/completed is the safe boundary.
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.error) {
      const rpcError = record(message.error)
      const detail = record(rpcError.data).thread_error_code
      // Current Codex builds report a missing rollout as -32600 with no data.
      // Match only the exact thread/resume error for our validated thread ID;
      // arbitrary error prose must never authorize context handoff.
      const missingRollout =
        pending.method === 'thread/resume' &&
        rpcError.code === -32600 &&
        rpcError.message === `no rollout found for thread id ${pending.threadId}`
      pending.reject(
        new CodexAdapterError(
          detail === 'thread_not_found' || missingRollout ? 'runtime_thread_not_found' : 'runtime_request_failed',
          normalizeRuntimeFailure(message.error),
        ),
      )
    } else if (Object.hasOwn(message, 'result')) pending.resolve(message.result)
    else pending.reject(new CodexAdapterError('runtime_protocol_error'))
  }
}
