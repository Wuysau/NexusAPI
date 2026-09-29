import { createHash } from 'node:crypto'

export const PARSER_VERSION = 'codex-rollout-v1'
export const tokenKeys = ['input', 'cached', 'output', 'reasoning', 'total'] as const
export type ObservedTokens = Record<(typeof tokenKeys)[number], string | null>
export interface ParserState {
  sessionId: string | null
  turnId: string | null
  cwd: string | null
  providerIdentifier: string | null
  model: string | null
  cliVersion: string | null
  lastCounter: string | null
}
export interface ObservedUsageEvent extends Omit<ParserState, 'lastCounter'> {
  sessionId: string
  eventId: string
  timestamp: string
  tokens: ObservedTokens
  source: 'codex_local' | 'claude_code_local'
  authority: 'client_observed'
  parserVersion: string
  sessionKind?: 'cli' | 'subagent'
  parentSessionId?: string | null
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const identifier = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value) ? value : null
const cwd = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f]/.test(value) ? value : null
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function tokens(value: unknown): ObservedTokens | null {
  const raw = record(value)
  const names = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']
  const result = {} as ObservedTokens
  for (const [i, key] of tokenKeys.entries()) {
    const n = raw[names[i]]
    if (n !== undefined && n !== null && (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)) return null
    result[key] = n === undefined || n === null ? null : String(n)
  }
  const { input, cached, output, reasoning, total } = result
  if (input !== null && cached !== null && BigInt(cached) > BigInt(input)) return null
  if (output !== null && reasoning !== null && BigInt(reasoning) > BigInt(output)) return null
  if (input !== null && output !== null && total !== null && BigInt(input) + BigInt(output) !== BigInt(total))
    return null
  return tokenKeys.some((key) => result[key] !== null) ? result : null
}

/** Only this allowlist survives a raw record. Never persist the input object. */
export class CodexParser {
  readonly state: ParserState
  warnings = 0
  constructor(state?: unknown) {
    const s = record(state)
    this.state = {
      sessionId: identifier(s.sessionId),
      turnId: identifier(s.turnId),
      cwd: cwd(s.cwd),
      providerIdentifier: identifier(s.providerIdentifier),
      model: identifier(s.model),
      cliVersion: identifier(s.cliVersion),
      lastCounter: identifier(s.lastCounter),
    }
  }
  parse(event: unknown): ObservedUsageEvent | null {
    const e = record(event),
      p = record(e.payload),
      s = this.state
    if (e.type === 'session_meta') {
      s.sessionId = identifier(p.id)
      s.cwd = cwd(p.cwd)
      s.providerIdentifier = identifier(p.model_provider)
      s.cliVersion = identifier(p.cli_version)
      return null
    }
    if (e.type === 'turn_context') {
      s.turnId = identifier(p.turn_id)
      s.cwd = cwd(p.cwd) ?? s.cwd
      s.model = identifier(p.model)
      if (p.model_provider !== undefined) s.providerIdentifier = identifier(p.model_provider)
      return null
    }
    if (e.type !== 'event_msg' || p.type !== 'token_count') return null
    const info = record(p.info)
    if (!Object.keys(info).length) return null // rate-limit notification only
    const last = tokens(info.last_token_usage),
      cumulative = tokens(info.total_token_usage)
    if (
      !s.sessionId ||
      !last ||
      !cumulative ||
      typeof e.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(e.timestamp))
    ) {
      this.warnings++
      return null
    }
    const counter = hash(cumulative)
    if (counter === s.lastCounter) return null
    s.lastCounter = counter
    const eventId = hash([s.sessionId, s.turnId, s.providerIdentifier, s.model, cumulative, last])
    return {
      sessionId: s.sessionId,
      turnId: s.turnId,
      cwd: s.cwd,
      providerIdentifier: s.providerIdentifier,
      model: s.model,
      cliVersion: s.cliVersion,
      eventId,
      timestamp: new Date(e.timestamp).toISOString(),
      tokens: last,
      source: 'codex_local',
      authority: 'client_observed',
      parserVersion: PARSER_VERSION,
    }
  }
}
