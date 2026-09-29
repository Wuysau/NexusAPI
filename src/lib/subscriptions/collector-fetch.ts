import { CollectorError } from './collector'

export const COLLECTOR_MAX_BYTES = 1_048_576
export async function readCollectorJson(stream: ReadableStream<Uint8Array> | null): Promise<unknown> {
  if (!stream) throw new CollectorError('invalid_dashboard_snapshot')
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > COLLECTOR_MAX_BYTES) throw new CollectorError('snapshot_too_large', 413)
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    await reader.cancel().catch(() => {})
    if (error instanceof CollectorError) throw error
    throw new CollectorError('invalid_dashboard_snapshot')
  } finally {
    reader.releaseLock()
  }
}

export function collectorConfigured(tenantId: string, organizationId: string) {
  return Boolean(
    process.env.CODEXBAR_DASHBOARD_URL &&
    process.env.CODEXBAR_DASHBOARD_TOKEN?.trim() &&
    process.env.CODEXBAR_DASHBOARD_TENANT_ID === tenantId &&
    process.env.CODEXBAR_DASHBOARD_ORGANIZATION_ID === organizationId,
  )
}

export async function fetchCollectorSnapshot(tenantId: string, organizationId: string, providerId: string) {
  if (!collectorConfigured(tenantId, organizationId)) throw new CollectorError('collector_not_configured', 503)
  let url: URL
  try {
    url = new URL(process.env.CODEXBAR_DASHBOARD_URL!)
  } catch {
    throw new CollectorError('collector_not_configured', 503)
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['http:', 'https:'].includes(url.protocol) ||
    (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  )
    throw new CollectorError('collector_not_configured', 503)
  url.pathname = '/dashboard/v1/snapshot'
  url.searchParams.set('provider', providerId)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.CODEXBAR_DASHBOARD_TOKEN!.trim()}` },
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store',
    })
    if (!response.ok) throw new CollectorError('collector_unavailable', 502)
    return await readCollectorJson(response.body)
  } catch (error) {
    if (error instanceof CollectorError) throw error
    throw new CollectorError('collector_unavailable', 502)
  } finally {
    clearTimeout(timer)
  }
}
