import { createHash } from 'node:crypto'
import type { ObservedUsageEvent } from './codex'

export const CLAUDE_PARSER_VERSION = 'claude-transcript-v1'
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const id = (v: unknown) => (typeof v === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(v) ? v : null)
const counter = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null)

/** Metadata only; a Claude client can call any upstream, so provider remains unknown. */
export class ClaudeParser {
  readonly state = {}
  warnings = 0
  constructor(private readonly fileAgentId: string | null = null) {}
  parse(value: unknown): ObservedUsageEvent | null {
    const e = record(value),
      m = record(e.message),
      u = record(m.usage)
    if (e.type !== 'assistant' || !Object.keys(u).length) return null
    const session = id(e.sessionId),
      message = id(m.id),
      request = id(e.requestId)
    const input = counter(u.input_tokens),
      output = counter(u.output_tokens)
    const cached = u.cache_read_input_tokens === undefined ? 0n : counter(u.cache_read_input_tokens)
    const written = u.cache_creation_input_tokens === undefined ? 0n : counter(u.cache_creation_input_tokens)
    const reasoningRaw = record(u.output_tokens_details).thinking_tokens
    const reasoning = reasoningRaw === undefined ? null : counter(reasoningRaw)
    if (
      !session ||
      !message ||
      input === null ||
      output === null ||
      cached === null ||
      written === null ||
      (reasoningRaw !== undefined && (reasoning === null || reasoning > output)) ||
      typeof e.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(e.timestamp))
    ) {
      this.warnings++
      return null
    }
    const agent = e.isSidechain === true ? (id(e.agentId) ?? id(this.fileAgentId)) : null
    const sessionId = agent ? `${session}:agent:${agent}` : session
    // Keep storage identifiers bounded even for unusually long third-party IDs.
    if (sessionId.length > 160) {
      this.warnings++
      return null
    }
    const totalInput = input + cached + written
    return {
      sessionId,
      eventId: createHash('sha256')
        .update(JSON.stringify([sessionId, message, request]))
        .digest('hex'),
      turnId: request,
      cwd: typeof e.cwd === 'string' && e.cwd.length <= 4096 && !/[\x00-\x1f]/.test(e.cwd) ? e.cwd : null,
      providerIdentifier: null,
      model: id(m.model),
      cliVersion: id(e.version),
      timestamp: new Date(e.timestamp).toISOString(),
      tokens: {
        input: String(totalInput),
        cached: String(cached),
        output: String(output),
        reasoning: reasoning === null ? null : String(reasoning),
        total: String(totalInput + output),
      },
      source: 'claude_code_local',
      authority: 'client_observed',
      parserVersion: CLAUDE_PARSER_VERSION,
      sessionKind: e.isSidechain === true ? 'subagent' : 'cli',
      parentSessionId: agent ? session : null,
    }
  }
}
