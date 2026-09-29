import type { ExecutionResourceView } from './catalog'

export type PoolState = 'available' | 'near_limit' | 'exhausted' | 'blocked' | 'disabled' | 'unknown'
export function subscriptionPoolState(resource: ExecutionResourceView): PoolState {
  if (resource.status === 'disabled') return 'disabled'
  if (resource.temporaryBlock || resource.health === 'unhealthy' || resource.quotaState === 'unavailable')
    return 'blocked'
  if (resource.quotaState === 'exhausted') return 'exhausted'
  if (resource.status !== 'active' || resource.health !== 'healthy') return 'unknown'
  return resource.quotaState
}

export interface SubscriptionPool {
  key: string
  provider: string
  product: string
  total: number
  available: number
  nearLimit: number
  exhausted: number
  blocked: number
  disabled: number
  unknown: number
  collectorReported: number
  collectorStale: number
  nextResetAt: string | null
}

/** Monitoring only: capacity is account counts, never a sum of unrelated percentage quotas. */
export function summarizeSubscriptionPools(resources: ExecutionResourceView[]): SubscriptionPool[] {
  const pools = new Map<string, SubscriptionPool>()
  for (const resource of resources) {
    if (resource.resourceType === 'api') continue
    const key = JSON.stringify([resource.provider, resource.product])
    const pool = pools.get(key) ?? {
      key,
      provider: resource.provider,
      product: resource.product,
      total: 0,
      available: 0,
      nearLimit: 0,
      exhausted: 0,
      blocked: 0,
      disabled: 0,
      unknown: 0,
      collectorReported: 0,
      collectorStale: 0,
      nextResetAt: null,
    }
    pool.total++
    if (resource.collectorObservation?.state === 'reported') pool.collectorReported++
    if (resource.collectorObservation?.state === 'stale') pool.collectorStale++
    const state = subscriptionPoolState(resource)
    if (state === 'near_limit') pool.nearLimit++
    else pool[state]++
    if (
      state === 'exhausted' &&
      resource.resetAt &&
      Number.isFinite(Date.parse(resource.resetAt)) &&
      (!pool.nextResetAt || Date.parse(resource.resetAt) < Date.parse(pool.nextResetAt))
    )
      pool.nextResetAt = resource.resetAt
    pools.set(key, pool)
  }
  return [...pools.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.product.localeCompare(b.product))
}
