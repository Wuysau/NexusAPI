import { open } from 'node:fs/promises'
import type { PoolClient } from 'pg'

export interface SessionMetadata {
  sessionId: string
  kind: 'desktop' | 'subagent' | 'cli' | 'other'
  parentSessionId: string | null
}
const identifier = (v: unknown) => (typeof v === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(v) ? v : null)
/** Bounded first-line session metadata only. No prompt/title/tool/credential extraction. */
export async function readSessionMetadata(file: string): Promise<SessionMetadata | null> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(65536)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const end = buffer.subarray(0, bytesRead).indexOf(10)
    if (end < 0) return null
    try {
      const event = JSON.parse(buffer.subarray(0, end).toString('utf8'))
      if (event?.type !== 'session_meta') return null
      const p = event.payload,
        sessionId = identifier(p?.id)
      if (!sessionId) return null
      const source = p.source
      const kind =
        source === 'vscode'
          ? 'desktop'
          : source === 'exec' || source === 'cli'
            ? 'cli'
            : source && typeof source === 'object' && Object.hasOwn(source, 'subagent')
              ? 'subagent'
              : null
      if (!kind) return null
      const parent = identifier(source?.subagent?.thread_spawn?.parent_thread_id)
      return { sessionId, kind, parentSessionId: parent === sessionId ? null : parent }
    } catch {
      return null
    }
  } finally {
    await handle.close()
  }
}
export async function enrichSessionMetadata(
  client: PoolClient,
  scope: { tenantId: string; organizationId: string },
  metadata: SessionMetadata | null,
) {
  if (!metadata) return 0
  const result = await client.query(
    `UPDATE external_observed_usage SET session_kind=$4,parent_session_id=$5 WHERE tenant_id=$1 AND organization_id=$2
     AND usage_source='codex_local' AND external_session_id=$3 AND session_kind IS NULL AND parent_session_id IS NULL`,
    [scope.tenantId, scope.organizationId, metadata.sessionId, metadata.kind, metadata.parentSessionId],
  )
  return result.rowCount ?? 0
}
