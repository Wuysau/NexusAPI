import { createHash } from 'node:crypto'
import path from 'node:path'
import type { NativeRecord } from '../agent-types'

type Context = { file: string; workspace?: string }
type ObjectValue = Record<string, unknown>
type Tokens = NativeRecord['tokens']
const LIMIT = 100_000
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {}
const id = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value) ? value : null
const cwd = (value: unknown): string | null =>
  typeof value === 'string' &&
  value.length <= 4096 &&
  !/[\x00-\x1f]/.test(value) &&
  (path.isAbsolute(value) || path.win32.isAbsolute(value))
    ? value
    : null
const hash = (parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const timestamp = (value: unknown): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (typeof value === 'string' && (value.length > 64 || !/^\d{4}-\d{2}-\d{2}T/.test(value))) return null
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
const number = (value: unknown): bigint | null | false =>
  value === undefined || value === null
    ? null
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? BigInt(value)
      : false
const emptyTokens = (): Tokens => ({ input: null, cached: null, output: null, reasoning: null, total: null })
function stringifyTokens(values: Record<keyof Tokens, bigint | null>): Tokens {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value === null ? null : String(value)]),
  ) as Tokens
}
function piTokens(value: unknown): Tokens | null {
  if (value === undefined || value === null) return emptyTokens()
  const raw = object(value)
  if (raw !== value) return null
  const parsed = [raw.input, raw.cacheRead, raw.cacheWrite, raw.output, raw.reasoning, raw.totalTokens].map(number)
  if (parsed.includes(false)) return null
  const [uncached, cached, write, output, reasoning, total] = parsed as Array<bigint | null>
  const input = uncached !== null && cached !== null && write !== null ? uncached + cached + write : null
  if (reasoning !== null && output !== null && reasoning > output) return null
  const knownSum = [uncached, cached, write, output].reduce<bigint>((sum, n) => sum + (n ?? 0n), 0n)
  if (total !== null && knownSum > total) return null
  if (total !== null && input !== null && output !== null && input + output !== total) return null
  return stringifyTokens({ input, cached, output, reasoning, total })
}
function factoryTokens(value: unknown): Tokens | null {
  if (value === undefined || value === null) return emptyTokens()
  const raw = object(value)
  if (raw !== value) return null
  const parsed = [
    raw.inputTokens,
    raw.outputTokens,
    raw.cacheReadTokens,
    raw.cacheCreationTokens,
    raw.thinkingTokens,
  ].map(number)
  if (parsed.includes(false)) return null
  const [rawInput, rawOutput, cached, write, reasoning] = parsed as Array<bigint | null>
  // SDK documents provider-reported counters, not a cross-provider overlap contract.
  // A known zero breakdown is the only case where the inclusive amount is unambiguous.
  const input = cached === 0n && write === 0n ? rawInput : null
  const output = reasoning === 0n ? rawOutput : null
  return stringifyTokens({ input, output, cached, reasoning, total: null })
}
function parentSession(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null
  const filename = value.replaceAll('\\', '/').split('/').at(-1) ?? ''
  // Pi's official filename includes its UUID session ID. Renamed files are not guessed.
  const match = /_([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})\.jsonl$/.exec(filename)
  return match?.[1] ?? null
}

function pi(tool: string, rows: unknown[], context: Context): NativeRecord[] {
  let header: ObjectValue | null = null
  for (const item of rows) {
    const row = object(item)
    if (row.type !== 'session') continue
    if (![2, 3].includes(row.version as number) || !id(row.id)) return []
    if (header && header.id !== row.id) return []
    header ??= row
  }
  if (!header) return []
  const sessionId = id(header.id)!
  const fork = typeof header.parentSession === 'string' && header.parentSession.length > 0
  const created = timestamp(header.timestamp)
  if (fork && !created) return []
  const records = new Map<string, NativeRecord>()
  for (const item of rows) {
    const row = object(item),
      message = object(row.message),
      entryId = id(row.id)
    const isMessage = row.type === 'message' && message.role === 'assistant'
    const isUsage = tool === 'pi' && ['usage', 'compaction', 'branch_summary'].includes(String(row.type))
    if (!entryId || (!isMessage && !isUsage)) continue
    const eventId = hash([tool, sessionId, entryId])
    records.delete(eventId)
    const time = timestamp(row.timestamp)
    // Fork writers copy prior entries with original timestamps and IDs. They consumed
    // usage in the parent, not again in the fork. Equal timestamps are conservative.
    if (!time || (fork && time <= created!)) continue
    const tokens = piTokens(isMessage ? message.usage : row.usage)
    if (!tokens || (isUsage && row.usage === undefined)) continue
    records.set(eventId, {
      sessionId,
      eventId,
      timestamp: time,
      cwd: cwd(header.cwd) ?? cwd(context.workspace),
      model: isMessage ? id(message.model) : row.type === 'usage' ? id(row.model) : null,
      tokens,
      kind: tool === 'pi' ? 'cli' : 'other',
      parentSessionId: parentSession(header.parentSession),
    })
  }
  return [...records.values()]
}

function factory(rows: unknown[], context: Context): NativeRecord[] {
  const records = new Map<string, NativeRecord>()
  let visited = rows.length
  for (const item of rows) {
    const row = object(item),
      sessionId = id(row.sessionId)
    if (row.type !== 'result' || !sessionId || !Array.isArray(row.messages) || row.turnCount !== 1) continue
    if (!['success', 'interrupted', 'error_during_execution', 'error_structured_output'].includes(String(row.subtype)))
      continue
    visited += row.messages.length
    if (visited > LIMIT) throw new Error('extended_cli_record_limit')
    let firstUser: string | null = null,
      firstAssistant: string | null = null,
      observed: string | null = null
    for (const event of row.messages) {
      const entry = object(event),
        message = object(entry.message),
        messageId = id(message.id)
      if (!messageId || !['user', 'assistant'].includes(String(entry.type)) || message.role !== entry.type) continue
      const time = timestamp(message.createdAt)
      if (!time) continue
      if (!observed || time > observed) observed = time
      if (entry.type === 'user') firstUser ??= messageId
      else firstAssistant ??= messageId
    }
    const anchor = firstUser ?? firstAssistant
    if (!anchor || !observed) continue
    const eventId = hash(['factory_droid', sessionId, anchor])
    records.delete(eventId)
    const tokens = factoryTokens(row.tokenUsage)
    if (!tokens) continue
    records.set(eventId, {
      sessionId,
      eventId,
      timestamp: observed,
      cwd: cwd(context.workspace),
      // DroidResult rolls up delegated work too, so a parent message's model would
      // incorrectly attribute a potentially mixed-model total.
      model: null,
      tokens,
      kind: 'cli',
      parentSessionId: null,
    })
  }
  return [...records.values()]
}

/** Verified Pi JSONL, OpenClaw legacy Pi-shaped JSONL, and Factory SDK result exports. */
export function parseExtendedCli(tool: string, value: unknown, context: Context): NativeRecord[] {
  if (!['pi', 'openclaw', 'factory_droid'].includes(tool)) return []
  const rows = Array.isArray(value) ? value : [value]
  if (rows.length > LIMIT) throw new Error('extended_cli_record_limit')
  return tool === 'factory_droid' ? factory(rows, context) : pi(tool, rows, context)
}
