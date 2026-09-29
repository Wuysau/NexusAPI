import { createHash } from 'node:crypto'

/** Metadata-only records. Source/provider/routing attribution belongs to the caller. */
export interface NativeRecord {
  sessionId: string
  eventId: string
  timestamp: string
  cwd: string | null
  model: string | null
  tokens: {
    input: string | null
    cached: string | null
    output: string | null
    reasoning: string | null
    total: string | null
  }
  kind?: 'cli' | 'subagent' | 'other'
  parentSessionId?: string | null
}
type Context = { file: string; workspace?: string }
type Row = Record<string, unknown>
const object = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {}
const id = (value: unknown) => (typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value) ? value : null)
const hash = (...values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex')
const MAX_COUNTER = 9_223_372_036_854_775_807n
const emptyTokens = (): NativeRecord['tokens'] => ({
  input: null,
  cached: null,
  output: null,
  reasoning: null,
  total: null,
})
function counter(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return null
  return BigInt(value) <= MAX_COUNTER ? value : null
}
function sum(...values: (string | null)[]): string | null {
  if (values.some((value) => value === null)) return null
  const total = values.reduce((total, value) => total + BigInt(value!), 0n)
  return total <= MAX_COUNTER ? String(total) : null
}
function timestamp(value: unknown, unit: 'iso' | 'ms' | 'seconds'): string | null {
  const millis =
    unit === 'iso'
      ? typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
        ? Date.parse(value)
        : NaN
      : typeof value === 'number' && Number.isFinite(value)
        ? value * (unit === 'seconds' ? 1000 : 1)
        : NaN
  return Number.isFinite(millis) && millis >= 0 && millis <= 253_402_300_799_999 ? new Date(millis).toISOString() : null
}
function workspace(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/.test(value)) return null
  return /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(value) ? value : null
}
function fileSession(tool: string, file: string): string {
  const normalized = file.replace(/\\/g, '/')
  const folder = normalized.slice(0, normalized.lastIndexOf('/'))
  return `${tool}:${hash(folder)}`
}
function childSession(parent: string, child: string): string {
  return `subagent:${hash(parent, child)}`
}
/** Keep IDs independent of content and mutable counters so snapshots can enrich the same event. */
function record(
  sessionId: string,
  key: unknown,
  at: string,
  cwd: string | null,
  model: string | null,
  tokens = emptyTokens(),
  parentSessionId: string | null = null,
  kind: NativeRecord['kind'] = 'cli',
): NativeRecord {
  return {
    sessionId,
    eventId: hash(sessionId, key),
    timestamp: at,
    cwd,
    model,
    tokens,
    kind: parentSessionId ? 'subagent' : kind,
    parentSessionId,
  }
}

function ideTokens(tool: string, value: Row): NativeRecord['tokens'] {
  if (value.usageMissing === true) return emptyTokens()
  let input = counter(value.tokensIn)
  const output = counter(value.tokensOut),
    cached = counter(value.cacheReads),
    writes = counter(value.cacheWrites)
  // Cline legacy logs mix provider-specific cache conventions. Do not claim an inclusive input when ambiguous.
  if (tool === 'cline' && ((cached !== null && BigInt(cached) > 0n) || (writes !== null && BigInt(writes) > 0n)))
    input = null
  if (input !== null && cached !== null && BigInt(cached) > BigInt(input)) input = null
  // Roo and legacy Kilo persist costResult.totalInputTokens, which already includes cache reads/writes.
  return { input, output, cached, reasoning: null, total: tool === 'cline' ? null : sum(input, output) }
}
function parseIde(tool: string, rows: Row[], context: Context): NativeRecord[] {
  const sessionId = fileSession(tool, context.file)
  const result = new Map<string, NativeRecord>()
  for (const row of rows) {
    if (row.type !== 'say' || row.say !== 'api_req_started') continue
    const at = timestamp(row.ts, 'ms')
    if (!at) continue
    let payload: Row = {}
    if (typeof row.text === 'string') {
      try {
        payload = object(JSON.parse(row.text))
      } catch {
        /* Recognized activity, unavailable usage. */
      }
    }
    const item = record(
      sessionId,
      ['api_req_started', row.ts],
      at,
      workspace(context.workspace),
      tool === 'cline' ? id(object(row.modelInfo).modelId) : null,
      ideTokens(tool, payload),
      null,
      'other',
    )
    const previous = result.get(item.eventId)
    // A malformed duplicate must not erase an earlier complete observation in the same snapshot.
    if (!previous) result.set(item.eventId, item)
    else {
      for (const key of ['input', 'cached', 'output'] as const) {
        const next = item.tokens[key],
          old = previous.tokens[key]
        if (next !== null && (old === null || BigInt(next) > BigInt(old))) previous.tokens[key] = next
      }
      if (
        tool === 'cline' &&
        item.tokens.input === null &&
        (counter(payload.cacheReads) !== null || counter(payload.cacheWrites) !== null)
      )
        previous.tokens.input = null
      if (
        previous.tokens.input !== null &&
        previous.tokens.cached !== null &&
        BigInt(previous.tokens.cached) > BigInt(previous.tokens.input)
      )
        previous.tokens.input = null
      previous.tokens.total = tool === 'cline' ? null : sum(previous.tokens.input, previous.tokens.output)
      previous.model ??= item.model
    }
  }
  return [...result.values()]
}

function parseCopilot(rows: Row[], context: Context): NativeRecord[] {
  let root = fileSession('github_copilot', context.file)
  let cwd = workspace(context.workspace)
  const result = new Map<string, NativeRecord>()
  for (const row of rows) {
    const data = object(row.data)
    if (row.type === 'session.start') {
      root = id(data.sessionId) ?? root
      cwd = workspace(object(data.context).cwd) ?? workspace(context.workspace)
      continue
    }
    if (row.type === 'session.resume') {
      cwd = workspace(object(data.context).cwd) ?? cwd
      continue
    }
    if (row.type === 'session.context_changed') {
      cwd = workspace(data.cwd) ?? cwd
      continue
    }
    // assistant.usage is ephemeral. Shutdown/checkpoint aggregates overlap with messages and resumed histories.
    if (row.type !== 'assistant.message' || row.ephemeral === true) continue
    const at = timestamp(row.timestamp, 'iso')
    const messageId = id(data.messageId) ?? id(row.id)
    if (!at || !messageId) continue
    if ((row.agentId != null && !id(row.agentId)) || (data.parentToolCallId != null && !id(data.parentToolCallId)))
      continue
    const agent = id(row.agentId) ?? id(data.parentToolCallId)
    const session = agent ? childSession(root, agent) : root
    const apiCall = id(data.apiCallId)
    const tokens = emptyTokens()
    // Split response chunks can each repeat the same API output counter. Merge only with a durable API call ID.
    tokens.output =
      apiCall || data.chunkCount === undefined || data.chunkCount === 1 ? counter(data.outputTokens) : null
    const item = record(
      session,
      apiCall ? ['apiCall', apiCall] : ['message', messageId],
      at,
      cwd,
      id(data.model),
      tokens,
      agent ? root : null,
    )
    const previous = result.get(item.eventId)
    if (previous) {
      if (
        item.tokens.output !== null &&
        (previous.tokens.output === null || BigInt(item.tokens.output) > BigInt(previous.tokens.output))
      )
        previous.tokens.output = item.tokens.output
      previous.model ??= item.model
    } else result.set(item.eventId, item)
  }
  return [...result.values()]
}

function kimiTokens(payload: Row): NativeRecord['tokens'] {
  const usage = object(payload.token_usage)
  const input = sum(counter(usage.input_other), counter(usage.input_cache_read), counter(usage.input_cache_creation))
  const output = counter(usage.output)
  return { input, cached: counter(usage.input_cache_read), output, reasoning: null, total: sum(input, output) }
}
function parseKimi(rows: Row[], context: Context): NativeRecord[] {
  const root = fileSession('kimi_cli', context.file)
  const result = new Map<string, NativeRecord>()
  // StatusUpdate can repeat the same step; use its message ID, or the surrounding turn/step context.
  const steps = new Map<string, { key: unknown; at: string }>()
  for (const row of rows) {
    const at = timestamp(row.timestamp, 'seconds')
    if (!at) continue
    let envelope = object(row.message)
    let payload = object(envelope.payload)
    let session = root,
      parent: string | null = null
    if (envelope.type === 'SubagentEvent') {
      const agent = id(payload.agent_id) ?? id(payload.parent_tool_call_id) ?? id(payload.task_tool_call_id)
      if (!agent) continue
      session = childSession(root, agent)
      parent = root
      envelope = object(payload.event)
      payload = object(envelope.payload)
    }
    if (envelope.type === 'TurnBegin') {
      steps.delete(session)
      continue
    }
    if (envelope.type === 'StepBegin') {
      const step = counter(payload.n)
      if (step === null) continue
      const key = ['step', row.timestamp, step]
      steps.set(session, { key, at })
      const item = record(session, key, at, workspace(context.workspace), null, emptyTokens(), parent)
      if (!result.has(item.eventId)) result.set(item.eventId, item)
      continue
    }
    if (envelope.type !== 'StatusUpdate' || payload.token_usage === null || payload.token_usage === undefined) continue
    const message = id(payload.message_id)
    const state = steps.get(session)
    // An unkeyed snapshot is not additive evidence: repeated status updates can otherwise double count.
    if (!message && !state) continue
    const key = state?.key ?? ['message', message]
    const item = record(session, key, state?.at ?? at, workspace(context.workspace), null, kimiTokens(payload), parent)
    const previous = result.get(item.eventId)
    if (previous) {
      for (const key of ['input', 'cached', 'output', 'reasoning'] as const) {
        const next = item.tokens[key],
          old = previous.tokens[key]
        if (next !== null && (old === null || BigInt(next) > BigInt(old))) previous.tokens[key] = next
      }
      if (
        previous.tokens.input !== null &&
        previous.tokens.cached !== null &&
        BigInt(previous.tokens.cached) > BigInt(previous.tokens.input)
      )
        previous.tokens.input = null
      previous.tokens.total = sum(previous.tokens.input, previous.tokens.output)
    } else result.set(item.eventId, item)
  }
  return [...result.values()]
}

/** Parses one bounded snapshot; caller supplies all complete JSONL rows, or the ui_messages JSON array. */
export function parseNativeIde(tool: string, value: unknown, context: Context): NativeRecord[] {
  if (!workspace(context.file)) return []
  const rows = (Array.isArray(value) ? value : [value]).map(object)
  if (['cline', 'roo_code', 'kilo_code'].includes(tool)) return parseIde(tool, rows, context)
  if (tool === 'github_copilot') return parseCopilot(rows, context)
  if (tool === 'kimi_cli') return parseKimi(rows, context)
  return []
}
