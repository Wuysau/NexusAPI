import { createHash } from 'node:crypto'

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
export class TelemetryError extends Error {
  constructor(public readonly code: string) {
    super(code)
  }
}
function fail(code: string): never {
  throw new TelemetryError(code)
}
export const validTool = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(value)
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const id = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,159}$/.test(value) ? value : null
const requiredId = (value: unknown) => id(value) ?? fail('invalid_telemetry_identity')
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const MAX_COUNTER = 9_223_372_036_854_775_807n
function counter(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(text) || BigInt(text) > MAX_COUNTER)
    return fail('invalid_telemetry_tokens')
  return text
}
function tokens(value: unknown): NativeRecord['tokens'] {
  const raw = object(value)
  const result = {
    input: counter(raw.input),
    cached: counter(raw.cached),
    output: counter(raw.output),
    reasoning: counter(raw.reasoning),
    total: counter(raw.total),
  }
  if (result.input !== null && result.cached !== null && BigInt(result.cached) > BigInt(result.input))
    fail('invalid_telemetry_tokens')
  if (result.output !== null && result.reasoning !== null && BigInt(result.reasoning) > BigInt(result.output))
    fail('invalid_telemetry_tokens')
  if (
    result.input !== null &&
    result.output !== null &&
    result.total !== null &&
    BigInt(result.input) + BigInt(result.output) !== BigInt(result.total)
  )
    fail('invalid_telemetry_tokens')
  return result
}
function workspace(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(value) ||
    !/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(value)
  )
    return fail('invalid_telemetry_workspace')
  return value
}
function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return fail('invalid_telemetry_timestamp')
  return new Date(value).toISOString()
}
function nanos(value: unknown): string | null {
  if (value === undefined || value === null || value === '0') return null
  const text = counter(value)
  if (text === null || text === '0') return null
  const millis = Number(BigInt(text) / 1_000_000n)
  return new Date(millis).toISOString()
}
function canonical(tool: string, value: Record<string, unknown>, fallback?: string): NativeRecord {
  if (value.schemaVersion !== 1 || value.tool !== tool) return fail('telemetry_tool_mismatch')
  if (
    value.tokens !== undefined &&
    value.tokens !== null &&
    (typeof value.tokens !== 'object' || Array.isArray(value.tokens))
  )
    fail('invalid_telemetry_tokens')
  const kind = value.kind
  if (kind !== undefined && !['cli', 'subagent', 'other'].includes(String(kind))) fail('invalid_telemetry_kind')
  return {
    sessionId: requiredId(value.sessionId),
    eventId: requiredId(value.eventId),
    timestamp: timestamp(value.timestamp),
    cwd: workspace(value.cwd ?? fallback),
    model: value.model == null ? null : requiredId(value.model),
    tokens: tokens(value.tokens),
    ...(kind === undefined ? {} : { kind: kind as NativeRecord['kind'] }),
    ...(value.parentSessionId === undefined
      ? {}
      : { parentSessionId: value.parentSessionId === null ? null : requiredId(value.parentSessionId) }),
  }
}

/** Only primitive allowlisted attributes are decoded; bodies, prompts and messages are never traversed. */
const attributeKeys = new Set([
  'nexus.tool',
  'service.name',
  'session.id',
  'gen_ai.conversation.id',
  'nexus.session.id',
  'event.id',
  'event.name',
  'event.timestamp',
  'event.sequence',
  'request_id',
  'client_request_id',
  'prompt_id',
  'gen_ai.response.id',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'model',
  'nexus.cwd',
  'nexus.parent_session_id',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.reasoning.output_tokens',
  'gen_ai.usage.total_tokens',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'input_token_count',
  'output_token_count',
  'cached_content_token_count',
  'thoughts_token_count',
  'total_token_count',
  'tool_token_count',
])
function attributes(value: unknown) {
  const output: Record<string, unknown> = Object.create(null)
  if (!Array.isArray(value)) return output
  if (value.length > 2048) fail('telemetry_batch_too_large')
  for (const item of value) {
    const entry = object(item)
    if (typeof entry.key !== 'string' || !attributeKeys.has(entry.key)) continue
    if (Object.hasOwn(output, entry.key)) fail('ambiguous_telemetry_attribute')
    const v = object(entry.value)
    const keys = ['stringValue', 'intValue', 'doubleValue', 'boolValue'].filter((key) => Object.hasOwn(v, key))
    if (keys.length !== 1) fail('invalid_telemetry_attribute')
    output[entry.key] = v[keys[0]]
  }
  return output
}
function knownTool(service: unknown): string | undefined {
  if (service === 'claude-code' || service === 'claude-code-desktop') return 'claude_code'
  if (service === 'gemini-cli') return 'gemini_cli'
  return undefined
}
function sum(...values: unknown[]): string | null {
  const parts = values.map(counter)
  return parts.some((value) => value === null)
    ? null
    : counter(parts.reduce((total, value) => total + BigInt(value!), 0n).toString())
}
function otlpTokens(tool: string, a: Record<string, unknown>, name: unknown): NativeRecord['tokens'] {
  if (
    tool === 'claude_code' &&
    ['api_request', 'claude_code.api_request'].includes(String(name)) &&
    a['input_tokens'] !== undefined
  ) {
    // Anthropic input_tokens excludes both cache-read and cache-write input.
    return tokens({
      input: sum(a.input_tokens, a.cache_read_tokens, a.cache_creation_tokens),
      cached: a.cache_read_tokens,
      output: a.output_tokens,
    })
  }
  if (tool === 'gemini_cli' && name === 'gemini_cli.api_response' && a.input_token_count !== undefined) {
    // Gemini candidate output excludes thoughts. Missing components remain unknown.
    const output = sum(a.output_token_count, a.thoughts_token_count)
    const toolTokens = counter(a.tool_token_count)
    return tokens({
      input: a.input_token_count,
      cached: a.cached_content_token_count,
      output,
      reasoning: a.thoughts_token_count,
      // Tool-use prompt accounting is not projected into input here; do not assert incompatible totals.
      total: toolTokens === null || toolTokens === '0' ? a.total_token_count : null,
    })
  }
  return tokens({
    input: a['gen_ai.usage.input_tokens'],
    cached: a['gen_ai.usage.cache_read.input_tokens'],
    output: a['gen_ai.usage.output_tokens'],
    reasoning: a['gen_ai.usage.reasoning.output_tokens'],
    total: a['gen_ai.usage.total_tokens'],
  })
}
function otlp(tool: string, payload: Record<string, unknown>, fallback?: string): NativeRecord[] {
  const output: NativeRecord[] = []
  let visited = 0
  for (const [key, scopes, entries] of [
    ['resourceLogs', 'scopeLogs', 'logRecords'],
    ['resourceSpans', 'scopeSpans', 'spans'],
  ]) {
    const groups = payload[key]
    if (groups === undefined) continue
    if (!Array.isArray(groups) || groups.length > 1024) fail('invalid_otlp_payload')
    for (const group of groups) {
      const resource = object(group)
      const common = attributes(object(resource.resource).attributes)
      const batches = resource[scopes]
      if (!Array.isArray(batches)) fail('invalid_otlp_payload')
      for (const batch of batches) {
        const records = object(batch)[entries]
        if (!Array.isArray(records)) fail('invalid_otlp_payload')
        for (const item of records) {
          if (++visited > 4096) fail('telemetry_batch_too_large')
          const row = object(item)
          const local = attributes(row.attributes)
          for (const source of [common, local]) {
            if (
              (source['nexus.tool'] !== undefined && source['nexus.tool'] !== tool) ||
              (knownTool(source['service.name']) && knownTool(source['service.name']) !== tool)
            )
              fail('telemetry_tool_mismatch')
          }
          const a = { ...common, ...local }
          const name =
            a['event.name'] ??
            row.eventName ??
            (typeof object(row.body).stringValue === 'string' &&
            ['claude_code.api_request', 'gemini_cli.api_response'].includes(String(object(row.body).stringValue))
              ? object(row.body).stringValue
              : undefined)
          if (
            typeof name === 'string' &&
            ((name.startsWith('claude_code.') && tool !== 'claude_code') ||
              (name.startsWith('gemini_cli.') && tool !== 'gemini_cli'))
          )
            fail('telemetry_tool_mismatch')
          const usage = otlpTokens(tool, a, name)
          // Metrics, ordinary logs, orchestration spans and content-only events aren't usage facts.
          if (Object.values(usage).every((value) => value === null)) continue
          const sessionId = id(a['gen_ai.conversation.id'] ?? a['session.id'] ?? a['nexus.session.id'])
          const time =
            nanos(entries === 'spans' ? (row.endTimeUnixNano ?? row.startTimeUnixNano) : row.timeUnixNano) ??
            (a['event.timestamp'] === undefined ? null : timestamp(a['event.timestamp']))
          if (!sessionId || !time) continue
          const trace =
            typeof row.traceId === 'string' && /^[a-fA-F0-9]{32}$/.test(row.traceId) && !/^0+$/.test(row.traceId)
              ? row.traceId.toLowerCase()
              : null
          const span =
            typeof row.spanId === 'string' && /^[a-fA-F0-9]{16}$/.test(row.spanId) && !/^0+$/.test(row.spanId)
              ? row.spanId.toLowerCase()
              : null
          const request = id(a['event.id'] ?? a['gen_ai.response.id'] ?? a.request_id ?? a.client_request_id)
          const prompt = id(a.prompt_id)
          const sequence = a['event.sequence'] === undefined ? null : counter(a['event.sequence'])
          if (!request && !(trace && span) && !prompt && sequence === null) continue
          const identity = request
            ? ['request', request]
            : entries === 'spans' && trace && span
              ? ['span', trace, span]
              : ['log', trace, span, prompt, sequence, row.timeUnixNano ?? a['event.timestamp'], name]
          output.push({
            sessionId,
            eventId: digest([tool, sessionId, identity]),
            timestamp: time,
            cwd: workspace(a['nexus.cwd'] ?? fallback),
            model: id(a['gen_ai.response.model'] ?? a['gen_ai.request.model'] ?? a.model),
            tokens: usage,
            kind: a['nexus.parent_session_id'] ? 'subagent' : 'cli',
            ...(a['nexus.parent_session_id'] === undefined
              ? {}
              : { parentSessionId: requiredId(a['nexus.parent_session_id']) }),
          })
        }
      }
    }
  }
  return output
}
function cursor(tool: string, row: Record<string, unknown>, fallback?: string): NativeRecord[] {
  if (tool !== 'cursor') return fail('telemetry_tool_mismatch')
  if (!['afterAgentResponse', 'stop'].includes(String(row.hook_event_name))) return []
  const sessionId = requiredId(row.conversation_id)
  const event = id(row.event_id) ?? id(row.generation_id)
  if (!event) return fail('invalid_telemetry_identity')
  const roots = Array.isArray(row.workspace_roots) ? row.workspace_roots : []
  return [
    {
      sessionId,
      eventId: digest(['cursor', sessionId, row.hook_event_name, event]),
      timestamp: row.timestamp === undefined ? new Date().toISOString() : timestamp(row.timestamp),
      cwd: workspace(roots.length === 1 ? roots[0] : fallback),
      model: id(row.model_id ?? row.model),
      // Official hooks do not specify usage counters. Never infer them from text or context size.
      tokens: tokens(row.tokens),
      kind: 'cli',
    },
  ]
}

/** Replayed metadata is stable; later snapshots may only fill or increase known counters. */
export function mergeTelemetryRecord(previous: NativeRecord, next: NativeRecord): NativeRecord {
  if (
    previous.sessionId !== next.sessionId ||
    previous.eventId !== next.eventId ||
    previous.cwd !== next.cwd ||
    previous.model !== next.model ||
    previous.kind !== next.kind ||
    previous.parentSessionId !== next.parentSessionId
  )
    fail('telemetry_replay_conflict')
  const merged = { ...previous.tokens }
  for (const key of ['input', 'cached', 'output', 'reasoning', 'total'] as const) {
    const value = next.tokens[key]
    if (value === null) continue
    if (previous.tokens[key] !== null && BigInt(value) < BigInt(previous.tokens[key]!))
      fail('telemetry_replay_conflict')
    merged[key] = value
  }
  // Keep the original event time; Cursor hooks without a timestamp use capture time on each retry.
  return { ...previous, tokens: tokens(merged) }
}

/** Normalizes metadata only. Does not read context.file, invoke tools, contact services or accept credentials. */
export function parseTelemetry(
  tool: string,
  value: unknown,
  context: { file: string; workspace?: string },
): NativeRecord[] {
  if (!validTool(tool)) return fail('invalid_telemetry_tool')
  workspace(context.workspace)
  const rows = Array.isArray(value) ? value : [value]
  if (rows.length > 4096 || rows.some(Array.isArray)) return fail('telemetry_batch_too_large')
  const output = rows.flatMap((item) => {
    const row = object(item)
    if (row.schemaVersion !== undefined) return [canonical(tool, row, context.workspace)]
    if (row.resourceLogs !== undefined || row.resourceSpans !== undefined) return otlp(tool, row, context.workspace)
    if (row.hook_event_name !== undefined) return cursor(tool, row, context.workspace)
    return fail('unsupported_telemetry_format')
  })
  if (output.length > 4096) return fail('telemetry_batch_too_large')
  const unique = new Map<string, NativeRecord>()
  for (const row of output) {
    const key = JSON.stringify([row.sessionId, row.eventId])
    const existing = unique.get(key)
    unique.set(key, existing ? mergeTelemetryRecord(existing, row) : row)
  }
  return [...unique.values()]
}
