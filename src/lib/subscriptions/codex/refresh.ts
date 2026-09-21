type QuotaWindow = { used: string | null; metadata?: { limitId: string; window: string | null } }

/**
 * openai/codex 5c5308f, tui/src/chatwidget/rate_limits.rs::rate_limit_refresh_interval.
 * This account panel has no selected inference model; only ordinary Codex windows apply.
 */
export function quotaRefreshInterval(quotas: readonly QuotaWindow[]): number {
  let used = 0
  for (const quota of quotas) {
    const metadata = quota.metadata
    if (!metadata || !['codex', 'default'].includes(metadata.limitId)) continue
    if (!['primary', 'secondary'].includes(metadata.window ?? '') || quota.used === null) continue
    const percent = Number(quota.used)
    if (Number.isFinite(percent)) used = Math.max(used, percent)
  }
  return used >= 99 ? 5000 : used >= 90 ? 15000 : used >= 75 ? 30000 : 60000
}
