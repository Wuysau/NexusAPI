export type AccountStatus = 'connected' | 'logged_out' | 'app_server_unavailable' | 'sync_error' | 'unknown'
export interface AccountObservation {
  source: 'codex_app_server'
  authority: 'provider_reported'
  scope: 'account'
  organizationId: string
  identity: string | null
  status: AccountStatus
  lastAttemptAt: string
  lastSuccessfulSyncAt: string | null
  lastSyncError: string | null
  account?: { type: string; email: string | null; planType: string | null; observedAt: string } | null
  quota?: { observationIds: string[]; observedAt: string }
  usage?: {
    observedAt: string
    summary: {
      lifetimeTokens: string | null
      peakDailyTokens: string | null
      longestRunningTurnSec: string | null
      currentStreakDays: string | null
      longestStreakDays: string | null
    }
    dailyUsageBuckets: { startDate: string; tokens: string | null }[] | null
  }
}
export interface AccountQuota {
  id: string
  observationId?: string | null
  source?: string
  confidence?: string
  staleAt?: string | null
  windowType: string
  used: string | null
  remaining: string | null
  resetAt: string | null
  observedAt: string
  freshness: string
  metadata?: {
    unit: 'percent'
    limitId: string
    limitName: string | null
    window: string | null
    windowDurationMins: number | null
    planType: string | null
    credits: { hasCredits: boolean | null; unlimited: boolean | null; balance: string | null } | null
  }
}
export interface ObservedProjectActivity {
  projectId: string | null
  projectName: string | null
  sessions: string
  events: string
  input: string | null
  cached: string | null
  output: string | null
  reasoning: string | null
  total: string | null
  models: string[]
  lastActivity: string
}
export interface ConnectionAccountView {
  observation: Omit<AccountObservation, 'identity' | 'organizationId'> | null
  quotas: AccountQuota[]
  activity: ObservedProjectActivity[]
  syncAvailable: boolean
}
