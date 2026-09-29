import { open, lstat } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { AgentSource, NativeRecord } from './agent-types'
import type { ObservedUsageEvent } from './codex'
import { parseNativeCli } from './adapters/native-cli'
import { parseNativeIde } from './adapters/native-ide'
import { parseTelemetry } from './adapters/telemetry'

export const AGENT_PARSER_VERSION = 'agent-snapshot-v1'
const MAX_BYTES = 64 * 1024 * 1024
export async function readAgentSnapshot(
  file: string,
  source: AgentSource,
): Promise<{ events: ObservedUsageEvent[]; bytesRead: number; warnings: number }> {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('agent_file_unavailable')
  const handle = await open(file, 'r')
  let contents: Buffer
  try {
    const opened = await handle.stat()
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size)
      throw new Error('agent_file_changed')
    contents = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < contents.length) {
      const r = await handle.read(contents, offset, contents.length - offset, offset)
      if (!r.bytesRead) break
      offset += r.bytesRead
    }
    const after = await handle.stat()
    if (offset !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('agent_file_changed')
    contents = contents.subarray(0, offset)
  } finally {
    await handle.close()
  }
  let warnings = 0,
    value: unknown
  if (file.endsWith('.jsonl')) {
    const lines = contents.toString('utf8').split('\n')
    lines.pop()
    const records: unknown[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line))
      } catch {
        warnings++
      }
    }
    value = records
  } else value = JSON.parse(contents.toString('utf8'))
  const context = { file, workspace: source.workspace }
  let records: NativeRecord[]
  if (source.format === 'telemetry') records = parseTelemetry(source.tool, value, context)
  else if (['gemini_cli', 'qwen_code', 'opencode'].includes(source.tool))
    records = parseNativeCli(source.tool, value, context)
  else records = parseNativeIde(source.tool, value, context)
  if (records.length > 50000) throw new Error('agent_event_limit')
  const events: ObservedUsageEvent[] = []
  for (const r of records) {
    if (!validRecord(r)) {
      warnings++
      continue
    }
    events.push({
      sessionId: r.sessionId,
      eventId: createHash('sha256')
        .update(JSON.stringify([source.tool, r.sessionId, r.eventId]))
        .digest('hex'),
      turnId: null,
      cwd: r.cwd ?? source.workspace ?? null,
      providerIdentifier: null,
      model: r.model,
      cliVersion: null,
      timestamp: r.timestamp,
      tokens: r.tokens,
      source: `agent:${source.tool}`,
      authority: 'client_observed',
      parserVersion: AGENT_PARSER_VERSION,
      sessionKind: r.kind ?? 'other',
      parentSessionId: r.parentSessionId ?? null,
    })
  }
  return { events, bytesRead: contents.length, warnings }
}
function validRecord(r: NativeRecord) {
  const id = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(v)
  if (
    !id(r.sessionId) ||
    !id(r.eventId) ||
    typeof r.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(r.timestamp)) ||
    (r.cwd !== null &&
      (typeof r.cwd !== 'string' ||
        r.cwd.length > 4096 ||
        /[\x00-\x1f]/.test(r.cwd) ||
        !(path.isAbsolute(r.cwd) || path.win32.isAbsolute(r.cwd)))) ||
    (r.model !== null && !id(r.model))
  )
    return false
  for (const n of Object.values(r.tokens))
    if (n !== null && (typeof n !== 'string' || !/^\d{1,30}$/.test(n))) return false
  const t = r.tokens
  if (t.input !== null && t.cached !== null && BigInt(t.cached) > BigInt(t.input)) return false
  if (t.output !== null && t.reasoning !== null && BigInt(t.reasoning) > BigInt(t.output)) return false
  if (
    t.input !== null &&
    t.output !== null &&
    t.total !== null &&
    BigInt(t.total) !== BigInt(t.input) + BigInt(t.output)
  )
    return false
  return true
}
