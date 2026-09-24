import type { AnalyticsDatabase } from '@/lib/billing/analytics'
import type { QuotaRow } from '@/lib/quota/read'

export type ResourceState =
  | 'available'
  | 'near_limit'
  | 'exhausted'
  | 'temporarily_unavailable'
  | 'rate_limited'
  | 'authentication_required'
  | 'resetting'
  | 'unknown'
export type ResourceType = 'official_subscription' | 'coding_plan' | 'token_plan' | 'third_party_api' | 'payg_api'
export interface Candidate {
  connectionId: string
  profileRef: string
  priority: number
  enabled: boolean
  switchThreshold: number
  capabilities: string[]
  allowedModels: string[]
  allowedTools: string[]
  costMode: string
}
export interface RoutingPolicy {
  name: string
  workload: string
  requiredCapabilities: string[]
  tool: 'codex'
  model: string | null
  autoFailover: boolean
  autoReturn: boolean
  candidates: Candidate[]
}
export interface Resource extends Candidate {
  resourceType: ResourceType
  provider: string
  product: string
  executionMode: string
  availability: ResourceState
  quotaState: ResourceState
  resetAt: string | null
  usedPercent: number | null
}
export interface ResourceScope {
  tenantId: string
  organizationId: string
  projectId: string
}
export class RoutingPolicyError extends Error {
  readonly status = 400
  readonly code = 'invalid_routing_policy'
  constructor(field: string) {
    super(`Invalid routing policy: ${field}`)
  }
}
const invalid = (field: string): never => {
  throw new RoutingPolicyError(field)
}
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
function exact(value: unknown, keys: string[], field: string) {
  const obj = record(value)
  if (!obj || Object.keys(obj).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(obj, key)))
    return invalid(field)
  return obj
}
function text(value: unknown, field: string, ref = false): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    value.trim() !== value ||
    /[\u0000-\u001f]/.test(value)
  )
    return invalid(field)
  if (ref && (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value) || value.includes('..'))) return invalid(field)
  return value
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 64) return invalid(field)
  const result = value.map((item) => text(item, field))
  if (new Set(result).size !== result.length) return invalid(field)
  return result
}
function flag(value: unknown, field: string): boolean {
  return typeof value === 'boolean' ? value : invalid(field)
}
export function validatePolicy(value: unknown): RoutingPolicy {
  const p = exact(
    value,
    ['name', 'workload', 'requiredCapabilities', 'tool', 'model', 'autoFailover', 'autoReturn', 'candidates'],
    'body',
  )
  if (p.tool !== 'codex') invalid('tool')
  if (!Array.isArray(p.candidates) || p.candidates.length > 64) invalid('candidates')
  const candidates = (p.candidates as unknown[]).map((value) => {
    const c = exact(
      value,
      [
        'connectionId',
        'profileRef',
        'priority',
        'enabled',
        'switchThreshold',
        'capabilities',
        'allowedModels',
        'allowedTools',
        'costMode',
      ],
      'candidate',
    )
    if (typeof c.priority !== 'number' || !Number.isSafeInteger(c.priority) || c.priority < 0) invalid('priority')
    if (
      typeof c.switchThreshold !== 'number' ||
      !Number.isFinite(c.switchThreshold) ||
      c.switchThreshold < 0 ||
      c.switchThreshold > 100
    )
      invalid('switchThreshold')
    return {
      connectionId: text(c.connectionId, 'connectionId', true),
      profileRef: text(c.profileRef, 'profileRef', true),
      priority: c.priority as number,
      enabled: flag(c.enabled, 'enabled'),
      switchThreshold: c.switchThreshold as number,
      capabilities: strings(c.capabilities, 'capabilities'),
      allowedModels: strings(c.allowedModels, 'allowedModels'),
      allowedTools: strings(c.allowedTools, 'allowedTools'),
      costMode: text(c.costMode, 'costMode'),
    }
  })
  if (
    new Set(candidates.map((c) => c.connectionId)).size !== candidates.length ||
    new Set(candidates.map((c) => c.profileRef)).size !== candidates.length
  )
    invalid('duplicate candidate')
  return {
    name: text(p.name, 'name'),
    workload: text(p.workload, 'workload'),
    requiredCapabilities: strings(p.requiredCapabilities, 'requiredCapabilities'),
    tool: 'codex',
    model: p.model === null ? null : text(p.model, 'model'),
    autoFailover: flag(p.autoFailover, 'autoFailover'),
    autoReturn: flag(p.autoReturn, 'autoReturn'),
    candidates,
  }
}
export function selectResource(
  resources: Resource[],
  policy: RoutingPolicy,
  options: { exclude?: string[]; targetConnectionId?: string; currentConnectionId?: string; now?: Date } = {},
): { selected: Resource | null; nextResetAt: string | null; rejected: { connectionId: string; reason: string }[] } {
  const time = (options.now ?? new Date()).getTime()
  const eligible: Resource[] = [],
    rejected: { connectionId: string; reason: string }[] = [],
    resets: number[] = []
  for (const r of resources) {
    const c = policy.candidates.find((c) => c.connectionId === r.connectionId)
    let reason: string | null = null
    if (!c) reason = 'not_in_policy'
    else if (!c.enabled) reason = 'disabled'
    else if (options.targetConnectionId && options.targetConnectionId !== c.connectionId) reason = 'not_target'
    else if (policy.requiredCapabilities.some((cap) => !c.capabilities.includes(cap) || !r.capabilities.includes(cap)))
      reason = 'capability'
    else if (!c.allowedTools.includes(policy.tool) || !r.allowedTools.includes(policy.tool)) reason = 'tool'
    else if (
      [c.allowedModels, r.allowedModels].some(
        (models) => models.length > 0 && (policy.model === null || !models.includes(policy.model)),
      )
    )
      reason = 'model'
    else if (r.availability !== 'available' && r.availability !== 'near_limit') reason = r.availability
    else {
      const reset = r.resetAt === null ? null : Date.parse(r.resetAt)
      if (!Number.isFinite(time) || (reset !== null && !Number.isFinite(reset))) reason = 'unknown'
      else if (reset !== null && reset <= time) reason = 'resetting'
      else if (r.quotaState !== 'available' && r.quotaState !== 'near_limit') reason = r.quotaState
      else if (r.usedPercent === null || !Number.isFinite(r.usedPercent) || r.usedPercent < 0) reason = 'unknown'
      if (options.exclude?.includes(c.connectionId)) reason = 'excluded'
      if (reason && reset !== null && Number.isFinite(reset) && reset > time) resets.push(reset)
    }
    if (reason) rejected.push({ connectionId: r.connectionId, reason })
    else if (c) eligible.push({ ...r, ...c })
  }
  eligible.sort(
    (a, b) =>
      Number(b.connectionId === options.currentConnectionId) - Number(a.connectionId === options.currentConnectionId) ||
      a.priority - b.priority ||
      a.connectionId.localeCompare(b.connectionId),
  )
  return {
    selected: eligible[0] ?? null,
    nextResetAt: eligible.length || !resets.length ? null : new Date(Math.min(...resets)).toISOString(),
    rejected,
  }
}

interface ConnectionRow {
  id: string
  tenant_id: string
  project_id: string | null
  provider: string
  mode: string
  status: string
  revoked_at: Date | null
  capabilities: Record<string, unknown>
  account_observation: Record<string, unknown> | null
  runtime_observation?: Record<string, unknown> | null
}
type StoredQuota = QuotaRow & { connection_id: string }
const millis = (value: Date | string | null): number => (value === null ? NaN : new Date(value).getTime())
function numeric(value: string | null): number | null {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
function projectQuota(
  rows: StoredQuota[],
  c: Candidate,
  now: Date,
): Pick<Resource, 'quotaState' | 'resetAt' | 'usedPercent'> {
  const windows = new Map<string, StoredQuota>()
  for (const q of rows) {
    if (
      q.provenance_version !== 1 ||
      q.source_kind !== 'official' ||
      !['reported', 'authoritative'].includes(q.confidence) ||
      !['account', 'connection'].includes(q.scope)
    )
      continue
    const previous = windows.get(q.window_type)
    if (!previous || millis(q.observed_at) > millis(previous.observed_at)) windows.set(q.window_type, q)
  }
  const states = [...windows.values()].map((q) => {
    const observed = millis(q.observed_at),
      stale = millis(q.stale_at),
      reset = q.reset_at === null ? null : millis(q.reset_at)
    let state: ResourceState = 'unknown',
      percent: number | null = null
    if (
      Number.isFinite(observed) &&
      Number.isFinite(stale) &&
      observed <= now.getTime() &&
      stale > now.getTime() &&
      stale >= observed &&
      (reset === null || Number.isFinite(reset))
    ) {
      if (reset !== null && reset <= now.getTime()) state = 'resetting'
      else if (q.availability === 'unavailable') state = 'temporarily_unavailable'
      else if (q.availability === 'available') {
        const used = numeric(q.used),
          remaining = numeric(q.remaining)
        percent =
          q.metadata?.unit === 'percent'
            ? used
            : used !== null && remaining !== null && used + remaining > 0
              ? (used / (used + remaining)) * 100
              : null
        if (remaining === 0) state = 'exhausted'
        else if (percent !== null) state = percent >= c.switchThreshold ? 'near_limit' : 'available'
      }
    }
    return { state, percent, reset }
  })
  // Any restrictive window blocks the resource; a healthy daily window cannot override an exhausted weekly one.
  const order: ResourceState[] = [
    'exhausted',
    'temporarily_unavailable',
    'resetting',
    'unknown',
    'near_limit',
    'available',
  ]
  const quotaState = order.find((state) => states.some((s) => s.state === state)) ?? 'unknown'
  const blockers = states.filter((s) => s.state !== 'available')
  const resetWindows = blockers.length ? blockers : states
  const resets = resetWindows
    .map((s) => s.reset)
    .filter((r): r is number => r !== null && Number.isFinite(r) && r > now.getTime())
  const resetAt =
    resets.length === resetWindows.length && resets.length
      ? new Date(blockers.length ? Math.max(...resets) : Math.min(...resets)).toISOString()
      : null
  const percents = states.map((s) => s.percent).filter((p): p is number => p !== null)
  return { quotaState, resetAt, usedPercent: percents.length ? Math.max(...percents) : null }
}
/** Project authorization is enforced by callers; every query retains tenant/project/organization scope. */
export async function readResources(
  db: AnalyticsDatabase,
  scope: ResourceScope,
  policy: RoutingPolicy,
  now = new Date(),
): Promise<Resource[]> {
  if (!policy.candidates.length) return []
  const connections = (
    await db.query<ConnectionRow>(
      `SELECT c.id,c.tenant_id,c.project_id,c.provider,c.mode,c.status,c.revoked_at,c.capabilities,c.account_observation,c.runtime_observation
     FROM owned_connections c JOIN projects p ON p.id=$3 AND p.tenant_id=c.tenant_id AND p.organization_id=$2
     JOIN organizations o ON o.id=p.organization_id AND o.tenant_id=p.tenant_id AND o.status='active' AND o.deleted_at IS NULL
     WHERE c.tenant_id=$1 AND p.status='active' AND p.archived_at IS NULL AND c.id=ANY($4::text[])
     AND (c.project_id=p.id OR (c.project_id IS NULL AND c.account_observation->>'organizationId'=$2))
     AND (c.account_observation IS NULL OR c.account_observation->>'organizationId'=$2)`,
      [scope.tenantId, scope.organizationId, scope.projectId, policy.candidates.map((c) => c.connectionId)],
    )
  ).rows.filter(
    (c) =>
      c.tenant_id === scope.tenantId &&
      (c.project_id === scope.projectId ||
        (c.project_id === null && c.account_observation?.organizationId === scope.organizationId)) &&
      (!c.account_observation || c.account_observation.organizationId === scope.organizationId),
  )
  if (!connections.length) return []
  const quotas = (
    await db.query<StoredQuota>(
      `SELECT DISTINCT ON (connection_id,window_type) * FROM quota_snapshots
     WHERE tenant_id=$1 AND connection_id=ANY($2::text[]) AND provenance_version=1 AND source_kind='official'
     ORDER BY connection_id,window_type,observed_at DESC,created_at DESC,id DESC`,
      [scope.tenantId, connections.map((c) => c.id)],
    )
  ).rows
  return connections.flatMap((connection) => {
    const candidate = policy.candidates.find((c) => c.connectionId === connection.id)
    if (!candidate) return []
    const observation = connection.account_observation
    const ids = record(observation?.quota)?.observationIds
    const rows = quotas.filter(
      (q) =>
        q.connection_id === connection.id &&
        (q.source !== 'codex_app_server' || (Array.isArray(ids) && ids.includes(q.observation_id))),
    )
    const availability: ResourceState =
      observation?.status === 'authentication_required'
        ? 'authentication_required'
        : connection.revoked_at || connection.status !== 'active' || (observation && observation.status !== 'connected')
          ? 'temporarily_unavailable'
          : 'available'
    const runtime = connection.runtime_observation
    const validFailure =
      runtime?.source === 'tool_runtime' &&
      ['rate_limited', 'exhausted', 'temporarily_unavailable', 'authentication_required'].includes(
        String(runtime.state),
      ) &&
      typeof runtime.observedAt === 'string' &&
      typeof runtime.staleAt === 'string' &&
      Number.isFinite(Date.parse(runtime.staleAt)) &&
      Date.parse(runtime.staleAt) > Date.parse(runtime.observedAt) &&
      Date.parse(runtime.observedAt) <= now.getTime()
    // A cooldown expiring is not recovery evidence. Every affected window needs a post-failure observation.
    const quota = projectQuota(
      validFailure
        ? rows.map((row) =>
            millis(row.observed_at) <= Date.parse(runtime!.observedAt as string) ? { ...row, stale_at: now } : row,
          )
        : rows,
      candidate,
      now,
    )
    // A tool failure can restrict a provider observation, but can never grant capacity.
    const providerRecovered =
      validFailure &&
      rows.length > 0 &&
      rows.every((row) => millis(row.observed_at) > Date.parse(runtime!.observedAt as string)) &&
      (quota.quotaState === 'available' || quota.quotaState === 'near_limit')
    if (validFailure && !providerRecovered && Date.parse(runtime!.staleAt as string) > now.getTime())
      quota.quotaState = runtime!.state as ResourceState
    const product = connection.capabilities.subscription_product ?? connection.capabilities.product
    const declaredType = connection.capabilities.resource_type
    const resourceType: ResourceType =
      connection.mode === 'subscription_interactive'
        ? 'official_subscription'
        : declaredType === 'coding_plan' ||
            declaredType === 'token_plan' ||
            declaredType === 'third_party_api' ||
            declaredType === 'payg_api'
          ? declaredType
          : candidate.costMode === 'payg'
            ? 'payg_api'
            : 'third_party_api'
    return [
      {
        ...candidate,
        resourceType,
        provider: connection.provider,
        product: typeof product === 'string' ? product : policy.tool,
        executionMode: connection.mode,
        availability,
        ...quota,
      },
    ]
  })
}
