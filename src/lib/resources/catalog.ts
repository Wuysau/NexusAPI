import type { CollectorObservation } from '@/lib/subscriptions/collector'

/** A read model over existing connections, gateway channels and quota facts. */
export interface ConnectionFact {
  id: string
  provider: string
  mode: string
  status: string
  project_id: string | null
  revoked_at: Date | string | null
  capabilities: Record<string, unknown>
  account_observation: Record<string, unknown> | null
  runtime_observation?: Record<string, unknown> | null
}

export interface ChannelFact {
  id: string
  name: string
  provider: string
  provider_credential_id: string | null
  credential_enabled: boolean | null
  enabled: boolean
  priority: number
  capabilities: string[]
  metadata: Record<string, unknown> | null
}

export interface QuotaFact {
  provenance_version?: number | null
  connection_id: string
  window_type?: string
  observation_id?: string | null
  source?: string
  availability: string | null
  used: string | null
  remaining: string | null
  observed_at: Date | string
  stale_at: Date | string | null
  reset_at: Date | string | null
  source_kind: string | null
  confidence: string | null
  scope: string | null
  metadata: Record<string, unknown> | null
}

export interface ExecutionResourceView {
  id: string
  connectionId: string | null
  accountId: string | null
  channelId: string | null
  projectId: string | null
  provider: string
  product: string
  resourceType: 'api' | 'official_subscription' | 'coding_plan' | 'token_plan'
  executionMode: 'gateway' | 'local_tool' | 'direct_provider'
  status: 'active' | 'pending' | 'disabled'
  priority: number | null
  capabilities: string[]
  supportedModels: string[]
  quotaState: 'available' | 'near_limit' | 'exhausted' | 'unavailable' | 'unknown'
  resetAt: string | null
  usedPercent: number | null
  health: 'healthy' | 'unhealthy' | 'unknown'
  temporaryBlock: { reason: string; blockedAt: string; recheckAt: string } | null
  routingStatus: 'configured' | 'not_configured'
  quotaWindows?: QuotaWindowView[]
  collectorObservation?: CollectorObservation | null
}

export interface QuotaWindowView {
  window: string
  source: string
  observedAt: string | null
  staleAt: string | null
  resetAt: string | null
  freshness: 'fresh' | 'stale' | 'unknown'
  usedPercent: number | null
}

const timestamp = (value: Date | string | null) => (value === null ? NaN : new Date(value).getTime())
const percent = (value: string | null): number | null => {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}
const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const stringValue = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)

function quotaProjection(rows: QuotaFact[], now: Date) {
  const latestByWindow = new Map<string, QuotaFact>()
  for (const row of rows) {
    if (
      row.provenance_version !== 1 ||
      row.source_kind !== 'official' ||
      !['reported', 'authoritative'].includes(row.confidence ?? '') ||
      !['account', 'connection'].includes(row.scope ?? '')
    )
      continue
    const window = stringValue(row.window_type) ?? 'default'
    const earlier = latestByWindow.get(window)
    if (!earlier || timestamp(row.observed_at) > timestamp(earlier.observed_at)) latestByWindow.set(window, row)
  }
  let state: ExecutionResourceView['quotaState'] = 'unknown'
  let usedPercent: number | null = null
  let resetAt: string | null = null
  const quotaWindows: QuotaWindowView[] = []
  if (!latestByWindow.size) return { quotaState: state, usedPercent, resetAt, quotaWindows }
  const states: ExecutionResourceView['quotaState'][] = []
  const resets: number[] = []
  const blockingResets: (number | null)[] = []
  for (const row of latestByWindow.values()) {
    const observed = timestamp(row.observed_at)
    const stale = timestamp(row.stale_at)
    const reset = row.reset_at === null ? null : timestamp(row.reset_at)
    const valid = Number.isFinite(observed) && observed <= now.getTime() && Number.isFinite(stale)
    const fresh =
      valid && stale > now.getTime() && (reset === null || (Number.isFinite(reset) && reset > now.getTime()))
    const used = percent(row.used),
      remaining = percent(row.remaining)
    const rawRatio =
      row.metadata?.unit === 'percent'
        ? used
        : used !== null && remaining !== null && used + remaining > 0
          ? (used / (used + remaining)) * 100
          : null
    const ratio = rawRatio !== null && rawRatio >= 0 && rawRatio <= 100 ? rawRatio : null
    quotaWindows.push({
      window: row.window_type ?? 'default',
      source: row.source ?? row.source_kind ?? 'unknown',
      observedAt: Number.isFinite(observed) ? new Date(observed).toISOString() : null,
      staleAt: Number.isFinite(stale) ? new Date(stale).toISOString() : null,
      resetAt: reset !== null && Number.isFinite(reset) ? new Date(reset).toISOString() : null,
      freshness: fresh ? 'fresh' : valid ? 'stale' : 'unknown',
      usedPercent: ratio,
    })
    if (
      !Number.isFinite(observed) ||
      !Number.isFinite(stale) ||
      observed > now.getTime() ||
      stale <= now.getTime() ||
      (reset !== null && (!Number.isFinite(reset) || reset <= now.getTime()))
    ) {
      states.push('unknown')
      continue
    }
    if (reset !== null) resets.push(reset)
    if (row.availability === 'unavailable') {
      states.push('unavailable')
      blockingResets.push(reset)
      continue
    }
    if (row.availability !== 'available') {
      states.push('unknown')
      continue
    }
    if (ratio !== null) usedPercent = Math.max(usedPercent ?? 0, ratio)
    if (remaining === 0 || ratio === 100) blockingResets.push(reset)
    states.push(
      remaining === 0 || ratio === 100
        ? 'exhausted'
        : ratio === null
          ? 'unknown'
          : ratio >= 90
            ? 'near_limit'
            : 'available',
    )
  }
  state =
    (['exhausted', 'unavailable', 'unknown', 'near_limit', 'available'] as const).find((candidate) =>
      states.includes(candidate),
    ) ?? 'unknown'
  if (!states.includes('unknown')) {
    if (blockingResets.length && blockingResets.every((reset): reset is number => reset !== null))
      resetAt = new Date(Math.max(...blockingResets)).toISOString()
    else if (!blockingResets.length && resets.length === states.length && resets.length > 0)
      resetAt = new Date(Math.min(...resets)).toISOString()
  }
  return { quotaState: state, usedPercent, resetAt, quotaWindows }
}

/** No secrets are accepted or returned. A channel linked to a connection is one API resource, not two. */
export function buildResourceCatalog(
  connections: ConnectionFact[],
  channels: ChannelFact[],
  quotas: QuotaFact[],
  now = new Date(),
): ExecutionResourceView[] {
  const byConnection = new Map(connections.map((connection) => [connection.id, connection]))
  const linked = new Set(
    channels
      .map((channel) => stringValue(channel.metadata?.connection_id))
      .filter(
        (id) => id && ['direct_api', 'external_endpoint', 'local_sidecar'].includes(byConnection.get(id)?.mode ?? ''),
      ),
  )
  const resources: ExecutionResourceView[] = []
  for (const connection of connections) {
    if (linked.has(connection.id)) continue
    const rawType = stringValue(connection.capabilities.resource_type)
    const resourceType =
      rawType === 'coding_plan' || rawType === 'token_plan'
        ? rawType
        : connection.mode === 'subscription_interactive'
          ? 'official_subscription'
          : 'api'
    const product =
      stringValue(connection.capabilities.subscription_product) ??
      stringValue(connection.capabilities.product) ??
      connection.provider
    const configured = connection.status === 'active' && !connection.revoked_at
    const observation = connection.account_observation
    const observedHealthAt = timestamp(
      (stringValue(observation?.lastAttemptAt) ?? stringValue(observation?.lastSuccessfulSyncAt)) as string | null,
    )
    const freshHealth =
      Number.isFinite(observedHealthAt) &&
      observedHealthAt <= now.getTime() &&
      observedHealthAt + 5 * 60_000 > now.getTime()
    const health =
      freshHealth && observation?.status === 'connected'
        ? 'healthy'
        : freshHealth &&
            ['authentication_required', 'logged_out', 'sync_error', 'app_server_unavailable'].includes(
              String(observation?.status),
            )
          ? 'unhealthy'
          : 'unknown'
    const observedIds = (observation?.quota as Record<string, unknown> | undefined)?.observationIds
    const trustedRows = quotas.filter(
      (row) =>
        row.connection_id === connection.id &&
        (row.source !== 'codex_app_server' ||
          (Array.isArray(observedIds) && row.observation_id !== null && observedIds.includes(row.observation_id))),
    )
    const quota = quotaProjection(trustedRows, now)
    const failure = connection.runtime_observation
    const blockedAt = stringValue(failure?.observedAt)
    const recheckAt = stringValue(failure?.staleAt)
    const failureTime = timestamp(blockedAt)
    const recoveryObserved =
      trustedRows.length > 0 &&
      trustedRows.every((row) => timestamp(row.observed_at) > failureTime) &&
      ['available', 'near_limit'].includes(quota.quotaState)
    const temporaryBlock =
      failure?.source === 'tool_runtime' &&
      ['exhausted', 'rate_limited', 'temporarily_unavailable', 'authentication_required'].includes(
        String(failure.state),
      ) &&
      blockedAt &&
      recheckAt &&
      Number.isFinite(failureTime) &&
      failureTime <= now.getTime() &&
      timestamp(recheckAt) > now.getTime() &&
      !recoveryObserved
        ? {
            reason: stringValue(failure.reason) ?? String(failure.state),
            blockedAt,
            recheckAt: new Date(recheckAt).toISOString(),
          }
        : null
    resources.push({
      id: `connection:${connection.id}`,
      connectionId: connection.id,
      accountId: connection.id,
      channelId: null,
      projectId: connection.project_id,
      provider: connection.provider,
      product,
      resourceType,
      executionMode: resourceType === 'api' ? 'direct_provider' : 'local_tool',
      status:
        connection.revoked_at || connection.status === 'revoked' || connection.status === 'blocked'
          ? 'disabled'
          : configured
            ? 'active'
            : 'pending',
      priority: null,
      capabilities: stringArray(connection.capabilities.capabilities),
      supportedModels: stringArray(connection.capabilities.supported_models),
      ...quota,
      health: temporaryBlock ? 'unhealthy' : health,
      temporaryBlock,
      routingStatus: 'not_configured',
    })
  }
  for (const channel of channels) {
    const connectionId = stringValue(channel.metadata?.connection_id)
    const connection = connectionId ? byConnection.get(connectionId) : undefined
    resources.push({
      id: `channel:${channel.id}`,
      connectionId: connection?.id ?? null,
      accountId: channel.provider_credential_id,
      channelId: channel.id,
      projectId: connection?.project_id ?? null,
      provider: channel.provider,
      product: channel.name,
      resourceType: 'api',
      executionMode: 'gateway',
      status:
        !channel.enabled || channel.credential_enabled === false || connection?.revoked_at
          ? 'disabled'
          : channel.provider_credential_id
            ? 'active'
            : 'pending',
      priority: channel.priority,
      capabilities: stringArray(channel.capabilities),
      supportedModels: Array.isArray(channel.metadata?.models)
        ? stringArray(channel.metadata?.models)
        : stringValue(channel.metadata?.model)
          ? [channel.metadata?.model as string]
          : [],
      quotaState: 'unknown',
      resetAt: null,
      usedPercent: null,
      health: 'unknown',
      temporaryBlock: null,
      routingStatus:
        channel.enabled && channel.provider_credential_id && channel.credential_enabled !== false
          ? 'configured'
          : 'not_configured',
    })
  }
  return resources.sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.product.localeCompare(b.product) || a.id.localeCompare(b.id),
  )
}
