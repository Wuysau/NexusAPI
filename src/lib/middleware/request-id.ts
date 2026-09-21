// Request-id and trace propagation middleware for the control plane.
//
// Every request gets a request_id (from the X-Request-Id header or freshly
// generated) and a trace_id (from X-Trace-Id or freshly generated). Both are
// set on the response so a client can correlate a failure with a server log.
//
// This is a pure helper — Next.js middleware (middleware.ts) calls into it,
// and individual route handlers can also use `resolveRequestIds` to get the
// ids from a Request when middleware is bypassed (e.g. in tests).
//
// Uses the Web Crypto API (not node:crypto) so it is compatible with the
// Next.js Edge Runtime where middleware runs.

export const REQUEST_ID_HEADER = 'x-request-id'
export const TRACE_ID_HEADER = 'x-trace-id'
export const TENANT_ID_HASH_HEADER = 'x-tenant-id-hash'

/** Generate a request id: `req_` + 12 hex chars (96 bits of entropy). */
export function generateRequestId(): string {
  return 'req_' + webRandomHex(6)
}

/** Generate n random bytes as a hex string using the Web Crypto API. */
function webRandomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount)
  // crypto.getRandomValues is available in both Node.js and the Edge Runtime.
  const cryptoObj = globalThis.crypto ?? (globalThis as unknown as { crypto: Crypto }).crypto
  cryptoObj.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface RequestIds {
  requestId: string
  traceId: string
  tenantIdHash?: string
}

/**
 * Resolve request/trace ids from a Request. Used by route handlers that need
 * the ids but may not have gone through middleware (e.g. tests, internal API).
 */
export function resolveRequestIds(req: Request): RequestIds {
  const requestId = req.headers.get(REQUEST_ID_HEADER)?.trim() || generateRequestId()
  const traceId = req.headers.get(TRACE_ID_HEADER)?.trim() || requestId
  const tenantIdHash = req.headers.get(TENANT_ID_HASH_HEADER)?.trim() || undefined
  return { requestId, traceId, tenantIdHash }
}

/**
 * Set request/trace id headers on a Response. The ids are echoed back so a
 * client can include them in a support ticket.
 */
export function stampResponseHeaders(headers: Headers, ids: RequestIds): void {
  headers.set(REQUEST_ID_HEADER, ids.requestId)
  headers.set(TRACE_ID_HEADER, ids.traceId)
  if (ids.tenantIdHash) headers.set(TENANT_ID_HASH_HEADER, ids.tenantIdHash)
}

/**
 * Build the id headers as a plain object for NextResponse.json .headers
 * manipulation or for fetch headers.
 */
export function idHeaders(ids: RequestIds): Record<string, string> {
  const out: Record<string, string> = {
    [REQUEST_ID_HEADER]: ids.requestId,
    [TRACE_ID_HEADER]: ids.traceId,
  }
  if (ids.tenantIdHash) out[TENANT_ID_HASH_HEADER] = ids.tenantIdHash
  return out
}
