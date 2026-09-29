import { createHash } from 'node:crypto'

export type CollectorBinding = { providerId: string; accountId: string }
export type CollectorWindow = {
  kind: string
  label: string
  usedPercent: number | null
  remainingPercent: number | null
  resetAt: string | null
}
export type CollectorObservation = CollectorBinding & {
  schemaVersion: 1
  source: 'codexbar'
  authority: 'collector_reported'
  scope: 'organization'
  organizationId: string
  binding: CollectorBinding
  state: 'reported' | 'stale' | 'unknown' | 'error'
  observedAt: string | null
  receivedAt: string
  staleAfterSeconds: number
  windows: CollectorWindow[]
  errorCode?: string
}
export class CollectorError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(code)
  }
}
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const timestamp = (v: unknown) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))
    ? new Date(v).toISOString()
    : null
const percent = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null)
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,95}$/i.test(v)
const hashId = (provider: string, id: string) => createHash('sha256').update(`${provider}\0${id}`).digest('hex')

function snapshotRows(input: unknown, providerId: string) {
  const snapshot = record(input)
  if (
    snapshot.schemaVersion !== 1 ||
    !timestamp(snapshot.generatedAt) ||
    !Array.isArray(snapshot.providers) ||
    snapshot.providers.length > 200 ||
    typeof snapshot.staleAfterSeconds !== 'number' ||
    !Number.isFinite(snapshot.staleAfterSeconds) ||
    snapshot.staleAfterSeconds <= 0
  )
    throw new CollectorError('invalid_dashboard_snapshot')
  const providers = snapshot.providers.map(record).filter((row) => row.id === providerId)
  if (providers.length !== 1) throw new CollectorError('provider_missing_or_ambiguous')
  const provider = providers[0]
  if (provider.enabled === false) throw new CollectorError('provider_disabled')
  if (provider.accounts !== undefined && !Array.isArray(provider.accounts))
    throw new CollectorError('invalid_dashboard_snapshot')
  // Never substitute the ambient row for an explicitly multi-account source.
  const multi = Array.isArray(provider.accounts)
  const rows = multi ? (provider.accounts as unknown[]).map(record) : [provider]
  if (rows.length > 200) throw new CollectorError('invalid_dashboard_snapshot')
  if (multi && new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new CollectorError('account_identity_ambiguous')
  return { snapshot, provider, rows, multi }
}
function accountEmail(row: Record<string, unknown>) {
  const email = record(row.identity).accountEmail
  // Redacted identity cannot safely distinguish two accounts at the same domain.
  if (
    typeof email !== 'string' ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+$/.test(email) ||
    /^redacted@/i.test(email) ||
    email.includes('*')
  )
    return null
  return email.trim().toLowerCase()
}
function accountKey(providerId: string, row: Record<string, unknown>, multi: boolean) {
  const email = accountEmail(row)
  // Pin supplied identity as well as the slot so slot reuse cannot silently switch known accounts.
  if (multi) return identifier(row.id) ? hashId(providerId, `id:${row.id}\0email:${email ?? ''}`) : null
  return email ? hashId(providerId, `email:${email}`) : null
}

/** Preview labels are transient; only a one-way account key is saved. */
export function collectorAccounts(input: unknown, providerId: string) {
  const { rows, multi } = snapshotRows(input, providerId)
  const accounts = rows.flatMap((row) => {
    const accountId = accountKey(providerId, row, multi)
    if (!accountId) return []
    return [{ accountId, label: multi ? String(row.id) : String(record(row.identity).accountEmail) }]
  })
  if (new Set(accounts.map((a) => a.accountId)).size !== accounts.length)
    throw new CollectorError('account_identity_ambiguous')
  return accounts
}

export function normalizeCollectorSnapshot(
  input: unknown,
  binding: CollectorBinding,
  organizationId: string,
  now = new Date(),
): CollectorObservation {
  if (!identifier(binding.providerId) || !/^[a-f0-9]{64}$/.test(binding.accountId))
    throw new CollectorError('invalid_account_binding')
  const { snapshot, rows, multi } = snapshotRows(input, binding.providerId)
  const matches = rows.filter((row) => accountKey(binding.providerId, row, multi) === binding.accountId)
  if (matches.length !== 1) throw new CollectorError('account_missing_or_ambiguous')
  const row = matches[0]
  const updatedAt = timestamp(row.updatedAt)
  const generatedAt = timestamp(snapshot.generatedAt)!
  const observedAt =
    updatedAt && Date.parse(updatedAt) <= now.getTime() + 60_000 && Date.parse(generatedAt) <= now.getTime() + 60_000
      ? new Date(Math.min(Date.parse(updatedAt), Date.parse(generatedAt))).toISOString()
      : null
  const windows = (Array.isArray(row.windows) ? row.windows.slice(0, 100) : []).map(record).map((window) => {
    const kind = identifier(window.kind) ? window.kind : 'unknown'
    return {
      kind,
      label: kind,
      usedPercent: percent(window.usedPercent),
      remainingPercent: percent(window.remainingPercent),
      resetAt: timestamp(window.resetAt),
    }
  })
  const observation: CollectorObservation = {
    schemaVersion: 1,
    source: 'codexbar',
    authority: 'collector_reported',
    scope: 'organization',
    organizationId,
    providerId: binding.providerId,
    accountId: binding.accountId,
    binding: { ...binding },
    state:
      row.error != null
        ? 'error'
        : windows.some((w) => w.usedPercent !== null || w.remainingPercent !== null)
          ? 'reported'
          : 'unknown',
    observedAt,
    receivedAt: now.toISOString(),
    staleAfterSeconds: Math.min(snapshot.staleAfterSeconds as number, 3600),
    windows,
    ...(row.error != null ? { errorCode: 'provider_collection_failed' } : {}),
  }
  return collectorFreshness(observation, now)
}

export function collectorFreshness(observation: CollectorObservation, now = new Date()): CollectorObservation {
  if (observation.state === 'error') return observation
  const time = observation.observedAt ? Date.parse(observation.observedAt) : NaN
  if (!Number.isFinite(time) || time > now.getTime() + 60_000) return { ...observation, state: 'unknown' }
  if (now.getTime() - time > observation.staleAfterSeconds * 1000) return { ...observation, state: 'stale' }
  if (
    observation.windows.some(
      (window) =>
        window.resetAt &&
        Date.parse(window.resetAt) <= now.getTime() &&
        (window.usedPercent !== null || window.remainingPercent !== null),
    )
  )
    return { ...observation, state: 'stale' }
  return observation
}

/** Reconstruct allowlisted fields before returning persisted JSON to any read model. */
export function readCollectorObservation(
  value: unknown,
  organizationId: string,
  now = new Date(),
): CollectorObservation | null {
  const row = record(value)
  if (
    row.schemaVersion !== 1 ||
    row.source !== 'codexbar' ||
    row.authority !== 'collector_reported' ||
    row.organizationId !== organizationId ||
    !identifier(row.providerId) ||
    typeof row.accountId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.accountId)
  )
    return null
  const binding = { providerId: row.providerId, accountId: row.accountId }
  const observation: CollectorObservation = {
    schemaVersion: 1,
    source: 'codexbar',
    authority: 'collector_reported',
    scope: 'organization',
    organizationId,
    ...binding,
    binding,
    state: ['reported', 'stale', 'unknown', 'error'].includes(String(row.state))
      ? (row.state as CollectorObservation['state'])
      : 'unknown',
    observedAt: timestamp(row.observedAt),
    receivedAt: timestamp(row.receivedAt) ?? new Date(0).toISOString(),
    staleAfterSeconds:
      typeof row.staleAfterSeconds === 'number' && Number.isFinite(row.staleAfterSeconds)
        ? Math.max(1, Math.min(3600, row.staleAfterSeconds))
        : 180,
    windows: (Array.isArray(row.windows) ? row.windows.slice(0, 100) : []).map(record).map((w) => ({
      kind: identifier(w.kind) ? w.kind : 'unknown',
      label: identifier(w.kind) ? w.kind : 'unknown',
      usedPercent: percent(w.usedPercent),
      remainingPercent: percent(w.remainingPercent),
      resetAt: timestamp(w.resetAt),
    })),
    ...(row.state === 'error' ? { errorCode: 'collection_failed' } : {}),
  }
  return collectorFreshness(observation, now)
}
