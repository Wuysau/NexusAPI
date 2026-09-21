/** Public deployment address only: never derive a Gateway from the Web origin. */
export function gatewayEndpoint(value: string | undefined): string | null {
  if (!value?.trim()) return null
  const candidate = value.trim()
  if (!/^https?:\/\//i.test(candidate) || /[\s\\'"`$?#]/.test(candidate)) return null
  try {
    const url = new URL(candidate)
    if (url.username || url.password || !url.hostname) return null
    return url.href.replace(/\/+$/, '')
  } catch {
    return null
  }
}
