import { createHash } from 'node:crypto'
import { parseTelemetry, TelemetryError, type NativeRecord } from './telemetry'

export const AGENT_HOOK_TOOLS = ['windsurf', 'codebuddy', 'qoder', 'factory_droid', 'kiro', 'antigravity'] as const
export const supportsAgentHook = (tool: string): boolean => AGENT_HOOK_TOOLS.some((entry) => entry === tool)
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const identity = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,159}$/.test(value) ? value : null
const requiredIdentity = (value: unknown): string => {
  const result = identity(value)
  if (!result) throw new TelemetryError('invalid_telemetry_identity')
  return result
}
function optionalIdentity(value: unknown): string | null {
  return value == null ? null : requiredIdentity(value)
}

/** Official hook metadata only. No transcript, response, tool arguments, credentials or counters are read. */
export function parseAgentHook(
  tool: string,
  value: unknown,
  context: { file: string; workspace?: string },
): NativeRecord[] {
  if (!supportsAgentHook(tool)) throw new TelemetryError('unsupported_agent_hook_tool')
  const rows = Array.isArray(value) ? value : [value]
  if (rows.length > 4096 || rows.some(Array.isArray)) throw new TelemetryError('telemetry_batch_too_large')
  const canonical = rows.flatMap((item) => {
    const row = object(item)
    if (row.schemaVersion !== undefined) throw new TelemetryError('unsupported_agent_hook_format')
    // Distinct native payload families must not silently become another tool's activity.
    if (
      (row.trajectory_id !== undefined && tool !== 'windsurf') ||
      (row.conversationId !== undefined && tool !== 'antigravity') ||
      row.conversation_id !== undefined
    )
      throw new TelemetryError('telemetry_tool_mismatch')
    let sessionId: string
    let event: string
    let eventIdentity: string
    let cwd: unknown = row.cwd ?? context.workspace
    let model: string | null = null
    if (tool === 'windsurf') {
      if (row.hook_event_name !== undefined) throw new TelemetryError('telemetry_tool_mismatch')
      if (row.agent_action_name !== 'post_cascade_response') return []
      sessionId = requiredIdentity(row.trajectory_id)
      event = 'post_cascade_response'
      eventIdentity = requiredIdentity(row.execution_id)
      // model_name is a human display label, not a stable model identifier.
      cwd = context.workspace
    } else if (tool === 'antigravity') {
      if (row.hook_event_name !== undefined) throw new TelemetryError('telemetry_tool_mismatch')
      // Official payloads omit event type. Register ONLY this adapter's PostToolUse hook.
      if (row.toolCall === undefined || row.stepIdx === undefined) return []
      if (!Number.isSafeInteger(row.stepIdx) || (row.stepIdx as number) < 0)
        throw new TelemetryError('invalid_telemetry_identity')
      sessionId = requiredIdentity(row.conversationId)
      event = 'PostToolUse'
      eventIdentity = String(row.stepIdx)
      const roots = Array.isArray(row.workspacePaths) ? row.workspacePaths : []
      // A multi-root conversation cannot be attributed to the hook runner's current directory.
      cwd = roots.length === 1 ? roots[0] : null
      model = identity(row.modelName)
    } else {
      if (row.agent_action_name !== undefined) throw new TelemetryError('telemetry_tool_mismatch')
      event = typeof row.hook_event_name === 'string' ? row.hook_event_name : ''
      if (!['SessionStart', 'SessionEnd', 'agentSpawn', 'Stop', 'stop', 'PostToolUse'].includes(event)) return []
      if (event === 'PostToolUse' && tool !== 'qoder') return []
      if ((event === 'agentSpawn' || event === 'stop') && tool !== 'kiro') return []
      if (tool === 'kiro' && event === 'SessionEnd') return []
      sessionId = requiredIdentity(row.session_id)
      // nexus_event_id is an explicit wrapper extension, never inferred from text or timestamps.
      const wrapperId = optionalIdentity(row.nexus_event_id)
      if (event === 'PostToolUse') {
        const stableId = wrapperId ?? optionalIdentity(row.tool_use_id)
        if (!stableId) return []
        eventIdentity = stableId
      } else if (event === 'Stop' || event === 'stop') {
        const nativeId =
          tool === 'codebuddy'
            ? optionalIdentity(row.generation_id)
            : tool === 'factory_droid'
              ? optionalIdentity(row.message_id)
              : null
        const stableId = wrapperId ?? nativeId
        if (!stableId) return []
        eventIdentity = stableId
        event = 'Stop'
      } else {
        // Resumes/compactions aren't new sessions. Lifecycle records represent presence once/session.
        if (event === 'SessionStart' && row.source !== undefined && !['startup', 'new'].includes(String(row.source)))
          return []
        event = event === 'agentSpawn' ? 'SessionStart' : event
        eventIdentity = wrapperId ?? 'session-lifecycle'
      }
    }
    return [
      {
        schemaVersion: 1,
        tool,
        sessionId,
        eventId: createHash('sha256')
          .update(JSON.stringify([tool, sessionId, event, eventIdentity]))
          .digest('hex'),
        timestamp: row.timestamp ?? new Date().toISOString(),
        cwd: cwd ?? null,
        model,
        // None of these official hook contracts document token usage counters.
        tokens: {},
        kind: 'cli',
      },
    ]
  })
  return parseTelemetry(tool, canonical, { file: context.file })
}
