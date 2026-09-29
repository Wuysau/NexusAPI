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
export interface AgentSource {
  tool: string
  path: string
  format: 'native' | 'telemetry'
  workspace?: string
}
