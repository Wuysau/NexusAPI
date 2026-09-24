export type RuntimeFailureReason =
  'quota_exhausted' | 'rate_limit' | 'provider_unavailable' | 'authentication_failure' | 'unknown'

export interface RuntimeEvent {
  type: 'turn_completed' | 'session_failed' | 'quota' | 'progress' | 'approval_required' | 'runtime_uncertain'
  sessionId?: string
  reason?: RuntimeFailureReason
  quota?: unknown
  operation?: string
}

export interface RuntimeContext {
  completedWork: string[]
  pendingWork: string[]
  decisions: string[]
  lastUserInstruction: string | null
  knownFailures: string[]
}

export interface ResourceObservation {
  source: string
  identity: string | null
  account: { type: string; email: string | null; planType: string | null }
  quotas: {
    windowType: string
    used: string | null
    remaining: string | null
    resetAt: string | null
    metadata?: Record<string, unknown>
  }[]
}

export interface ToolAdapter {
  launch(profile: { profileRef: string; home: string }, cwd: string, model: string | null): Promise<void>
  startSession(): Promise<string>
  canSwitchResourceInPlace(sessionId: string, targetProfile: { profileRef: string; home: string }): Promise<boolean>
  switchResourceInPlace(sessionId: string, targetProfile: { profileRef: string; home: string }): Promise<string>
  canResumeConversation(
    sessionId: string,
    targetProfile: { profileRef: string; home: string },
    cwd?: string,
    model?: string | null,
  ): Promise<boolean>
  resumeSession(sessionId: string): Promise<string>
  canMigrateConversation(sessionId: string, targetProfile: { profileRef: string; home: string }): Promise<boolean>
  submit(sessionId: string, prompt: string): Promise<void>
  inspect(): { state: 'idle' | 'running' | 'failed' | 'stopped'; sessionId: string | null; processId?: number }
  stop(): Promise<void>
  drainEvents(): RuntimeEvent[]
  readQuota?(): Promise<unknown>
  readAccount?(): Promise<unknown>
  readContext?(): Promise<RuntimeContext>
  readResourceObservation?(): Promise<ResourceObservation>
}
