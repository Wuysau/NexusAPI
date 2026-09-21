import { CodexClientError } from './client'
import type { AccountQuota } from './types'

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CodexClientError('sync_error')
  return value as Record<string, unknown>
}
const text = (value: unknown, max = 256) => (typeof value === 'string' && value.length <= max ? value : null)
function integer(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const result =
    typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : ''
  if (!/^\d{1,30}$/.test(result)) throw new CodexClientError('sync_error')
  return result
}
function finite(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new CodexClientError('sync_error')
  return value
}
export function mapAccount(value: unknown) {
  const data = object(value)
  if (data.account === null) return null
  const account = object(data.account)
  const type = text(account.type)
  if (!type) throw new CodexClientError('sync_error')
  return { type, email: text(account.email, 320), planType: text(account.planType) }
}
export function mapUsage(value: unknown) {
  const data = object(value),
    summary = object(data.summary)
  const daily = data.dailyUsageBuckets
  if (daily !== null && !Array.isArray(daily)) throw new CodexClientError('sync_error')
  return {
    summary: {
      lifetimeTokens: integer(summary.lifetimeTokens),
      peakDailyTokens: integer(summary.peakDailyTokens),
      longestRunningTurnSec: integer(summary.longestRunningTurnSec),
      currentStreakDays: integer(summary.currentStreakDays),
      longestStreakDays: integer(summary.longestStreakDays),
    },
    dailyUsageBuckets:
      daily === null
        ? null
        : daily.map((value) => {
            const bucket = object(value),
              date = text(bucket.startDate)
            if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)))
              throw new CodexClientError('sync_error')
            return { startDate: date, tokens: integer(bucket.tokens) }
          }),
  }
}
export function mapQuotas(value: unknown) {
  const data = object(value)
  const buckets =
    data.rateLimitsByLimitId == null ? { default: object(data.rateLimits) } : object(data.rateLimitsByLimitId)
  return Object.entries(buckets).flatMap<
    Pick<AccountQuota, 'windowType' | 'used' | 'remaining' | 'resetAt' | 'metadata'>
  >(([key, value]) => {
    const bucket = object(value),
      limitId = text(bucket.limitId) ?? text(key)
    if (!limitId) throw new CodexClientError('sync_error')
    const c = bucket.credits == null ? null : object(bucket.credits)
    const credits = c
      ? {
          hasCredits: typeof c.hasCredits === 'boolean' ? c.hasCredits : null,
          unlimited: typeof c.unlimited === 'boolean' ? c.unlimited : null,
          balance: text(c.balance),
        }
      : null
    const metadata = {
      unit: 'percent' as const,
      limitId,
      limitName: text(bucket.limitName),
      planType: text(bucket.planType),
      credits,
    }
    // Discover window objects by shape; primary/secondary are not durations or hardcoded windows.
    const windows = Object.entries(bucket).filter(
      ([, v]) => v !== null && typeof v === 'object' && Object.hasOwn(v, 'usedPercent'),
    )
    if (!windows.length)
      return [
        {
          windowType: `codex:${limitId}:unknown`,
          used: null,
          remaining: null,
          resetAt: null,
          metadata: { ...metadata, window: null, windowDurationMins: null },
        },
      ]
    return windows.map(([window, value]) => {
      const w = object(value),
        used = finite(w.usedPercent),
        duration = finite(w.windowDurationMins),
        reset = finite(w.resetsAt)
      const resetDate = reset === null ? null : new Date(reset * 1000)
      if (resetDate && !Number.isFinite(resetDate.getTime())) throw new CodexClientError('sync_error')
      return {
        windowType: `codex:${limitId}:${window}`,
        used: used === null ? null : String(used),
        remaining: used === null ? null : String(Math.max(0, 100 - used)),
        resetAt: resetDate?.toISOString() ?? null,
        metadata: { ...metadata, window, windowDurationMins: duration },
      }
    })
  })
}
