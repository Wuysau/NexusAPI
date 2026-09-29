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

type ObjectValue = Record<string, unknown>
type Context = { file: string; workspace?: string }
const MAX_RECORDS = 100_000
const object = (v: unknown): ObjectValue =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as ObjectValue) : {}
const id = (v: unknown): string | null => (typeof v === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(v) ? v : null)
const directory = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\x00-\x1f]/.test(v) ? v : null
const hash = (v: string[]) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const date = (v: unknown): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  if (typeof v === 'string' && (v.length > 64 || !/^\d{4}-\d{2}-\d{2}T/.test(v))) return null
  if (typeof v === 'number' && (!Number.isSafeInteger(v) || v < 0)) return null
  const d = new Date(v)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}
const count = (v: unknown): bigint | null | false => {
  if (v === undefined || v === null) return null
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : false
}
const sum = (...values: (bigint | null)[]) =>
  values.every((v) => v !== null) ? values.reduce<bigint>((a, v) => a + v!, 0n) : null

function normalizedTokens(raw: unknown, format: 'gemini' | 'qwen' | 'opencode'): NativeRecord['tokens'] | null {
  const t = object(raw),
    cache = object(t.cache)
  const values =
    format === 'qwen'
      ? [t.promptTokenCount, t.cachedContentTokenCount, t.candidatesTokenCount, t.thoughtsTokenCount, t.totalTokenCount]
      : [
          t.input,
          format === 'opencode' ? cache.read : t.cached,
          t.output,
          format === 'opencode' ? t.reasoning : t.thoughts,
          t.total,
        ]
  const parsed = values.map(count)
  const write = format === 'opencode' ? count(cache.write) : null
  const tool = format === 'gemini' ? count(t.tool) : null
  if (parsed.includes(false) || write === false || tool === false) return null
  const [rawInput, cached, rawOutput, reasoning, total] = parsed as (bigint | null)[]
  const input = format === 'opencode' ? sum(rawInput, cached, write as bigint | null) : rawInput
  let output = format === 'qwen' ? rawOutput : sum(rawOutput, reasoning)
  // Older Gemini records may omit thoughts; a reported total can establish inclusive output.
  if (
    format === 'gemini' &&
    output === null &&
    reasoning === null &&
    rawOutput !== null &&
    input !== null &&
    total !== null &&
    total >= input + rawOutput &&
    (tool === null || tool === 0n)
  ) {
    output = total - input
  }
  // Tool-use prompt tokens have no verified mapping to this normalized five-counter schema.
  if (format === 'gemini' && tool !== null && tool !== 0n) return null
  if (input !== null && cached !== null && cached > input) return null
  if (output !== null && reasoning !== null && reasoning > output) return null
  if (input !== null && output !== null && total !== null && input + output !== total) return null
  const result = { input, cached, output, reasoning, total }
  if (Object.values(result).every((v) => v === null)) return null
  return Object.fromEntries(
    Object.entries(result).map(([k, v]) => [k, v === null ? null : String(v)]),
  ) as NativeRecord['tokens']
}

function gemini(value: unknown, context: Context): NativeRecord[] {
  let sessionId: string | null = null
  let kind: NativeRecord['kind'] = 'cli'
  let remaining = MAX_RECORDS
  const messages = new Map<string, ObjectValue>()
  const add = (items: unknown) => {
    if (!Array.isArray(items)) return
    for (const item of items) {
      if (--remaining < 0) break
      const message = object(item),
        messageId = id(message.id)
      if (messageId) {
        // Keep only the allowlist, including null tokens on a replacement. No transcript survives.
        messages.set(messageId, {
          id: messageId,
          type: message.type,
          timestamp: message.timestamp,
          model: id(message.model),
          tokens: normalizedTokens(message.tokens, 'gemini'),
        })
      }
    }
  }
  for (const item of (Array.isArray(value) ? value : [value]).slice(0, MAX_RECORDS)) {
    if (--remaining < 0) break
    const row = object(item)
    const metadata = row.$set !== undefined ? object(row.$set) : row
    if (metadata.sessionId !== undefined) {
      const nextId = id(metadata.sessionId)
      if (!nextId || (sessionId && sessionId !== nextId)) return []
      sessionId = nextId
    }
    if (metadata.kind === 'main' || metadata.kind === 'subagent') kind = metadata.kind === 'main' ? 'cli' : 'subagent'
    add(metadata.messages)
    if (row.id !== undefined) add([row])
    // Rewinds alter visible context, not previously consumed tokens.
  }
  if (!sessionId) return []
  let parentSessionId: string | null = null
  if (kind === 'subagent') {
    const parts = context.file.replaceAll('\\', '/').split('/')
    if (parts.at(-3) === 'chats') parentSessionId = id(parts.at(-2))
  }
  const result: NativeRecord[] = []
  for (const [messageId, message] of messages) {
    const timestamp = date(message.timestamp)
    if (message.type !== 'gemini' || !timestamp || !message.tokens) continue
    result.push({
      sessionId,
      eventId: hash(['gemini_cli', sessionId, messageId]),
      timestamp,
      cwd: directory(context.workspace),
      model: id(message.model),
      tokens: message.tokens as NativeRecord['tokens'],
      kind,
      parentSessionId,
    })
  }
  return result
}

function qwen(value: unknown, context: Context): NativeRecord[] {
  const rows = Array.isArray(value) ? value : [value]
  const parents = new Map<string, string>()
  const result = new Map<string, NativeRecord>()
  for (const item of rows.slice(0, MAX_RECORDS)) {
    const row = object(item),
      sessionId = id(row.sessionId)
    const parent = id(object(row.systemPayload).parentSessionId)
    if (sessionId && row.type === 'system' && row.subtype === 'parent_session' && parent) parents.set(sessionId, parent)
  }
  for (const item of rows.slice(0, MAX_RECORDS)) {
    const row = object(item),
      sessionId = id(row.sessionId),
      messageId = id(row.uuid)
    if (!sessionId || !messageId || row.type !== 'assistant') continue
    const eventId = hash(['qwen_code', sessionId, messageId])
    result.delete(eventId)
    // /branch copies historical messages verbatim, with only sessionId changed.
    if (id(object(row.forkedFrom).sessionId)) continue
    const timestamp = date(row.timestamp),
      tokens = normalizedTokens(row.usageMetadata, 'qwen')
    if (!timestamp || !tokens) continue
    const parentSessionId = parents.get(sessionId) ?? null
    result.set(eventId, {
      sessionId,
      eventId,
      timestamp,
      cwd: directory(row.cwd) ?? directory(context.workspace),
      model: id(row.model),
      tokens,
      kind: parentSessionId || id(row.agentId) ? 'subagent' : 'cli',
      parentSessionId,
    })
  }
  return [...result.values()]
}

function opencode(value: unknown, context: Context): NativeRecord[] {
  const root = object(value),
    session = object(root.info),
    sessionId = id(session.id)
  if (!sessionId || !Array.isArray(root.messages)) return []
  const parentSessionId = id(session.parentID)
  const result = new Map<string, NativeRecord>()
  for (const item of root.messages.slice(0, MAX_RECORDS)) {
    const row = object(object(item).info),
      messageId = id(row.id)
    if (row.role !== 'assistant' || !messageId || row.sessionID !== sessionId) continue
    const eventId = hash(['opencode', sessionId, messageId])
    result.delete(eventId)
    const time = object(row.time),
      timestamp = date(time.completed ?? time.created),
      tokens = normalizedTokens(row.tokens, 'opencode')
    if (!timestamp || !tokens) continue
    result.set(eventId, {
      sessionId,
      eventId,
      timestamp,
      cwd: directory(object(row.path).cwd) ?? directory(session.directory) ?? directory(context.workspace),
      model: id(row.modelID),
      tokens,
      kind: parentSessionId ? 'subagent' : 'cli',
      parentSessionId,
    })
  }
  return [...result.values()]
}

/** Bounded, pure snapshot parser. Only allowlisted metadata and counters leave this boundary. */
export function parseNativeCli(tool: string, value: unknown, context: Context): NativeRecord[] {
  if (tool === 'gemini_cli') return gemini(value, context)
  if (tool === 'qwen_code') return qwen(value, context)
  if (tool === 'opencode') return opencode(value, context)
  return []
}
