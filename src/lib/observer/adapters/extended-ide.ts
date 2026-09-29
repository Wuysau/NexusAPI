import { createHash } from 'node:crypto'
import path from 'node:path'
import type { NativeRecord } from '../agent-types'

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const id = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value) ? value : null
const workspace = (value: unknown): string | null =>
  typeof value === 'string' &&
  value.length <= 4096 &&
  !/[\x00-\x1f\x7f]/.test(value) &&
  (path.posix.isAbsolute(value) || path.win32.isAbsolute(value))
    ? value
    : null
function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value))
    return null
  // Date.parse normalizes February 30; reject malformed calendar dates before conversion.
  const day = new Date(value.slice(0, 10) + 'T00:00:00.000Z')
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

/** Qoder IDE's documented JSONL assistant records. No transcript content is traversed. */
export function parseExtendedIde(
  tool: string,
  value: unknown,
  context: { file: string; workspace?: string },
): NativeRecord[] {
  // Continue dev_data lacks session/event IDs. Other formats require verified adapters.
  if (tool !== 'qoder') return []
  const rows = Array.isArray(value) ? value : [value]
  if (rows.length > 50000) throw new Error('extended_ide_record_limit')
  const records = new Map<string, NativeRecord>()
  const conflicts = new Set<string>()
  for (const item of rows) {
    const row = object(item)
    if (row.type !== 'assistant') continue
    const sessionId = id(row.sessionId),
      recordId = id(row.uuid),
      time = timestamp(row.timestamp)
    if (!sessionId || !recordId || !time) continue
    const eventId = createHash('sha256')
      .update(JSON.stringify(['qoder', sessionId, recordId]))
      .digest('hex')
    if (conflicts.has(eventId)) continue
    const cwd = workspace(row.cwd) ?? workspace(context.workspace)
    const existing = records.get(eventId)
    if (existing && (existing.timestamp !== time || existing.cwd !== cwd)) {
      records.delete(eventId)
      conflicts.add(eventId)
      continue
    }
    records.set(eventId, {
      sessionId,
      eventId,
      timestamp: time,
      cwd,
      model: null,
      // The published transcript contract contains neither model nor token accounting fields.
      tokens: { input: null, cached: null, output: null, reasoning: null, total: null },
      kind: 'other',
    })
  }
  return [...records.values()]
}
