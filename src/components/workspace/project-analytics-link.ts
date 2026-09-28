export function projectAnalyticsHref(projectId: string, firstObservedAt: string | null) {
  const path = `/projects/${encodeURIComponent(projectId)}/analytics`
  if (!firstObservedAt) return path
  const date = new Date(firstObservedAt)
  if (!Number.isFinite(date.getTime())) return path
  const from = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
  return `${path}?from=${from}`
}
