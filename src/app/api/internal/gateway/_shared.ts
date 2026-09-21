// Shared plumbing for the control-plane endpoints the Go data plane calls.
//
// ADR-0001 draws the boundary: these four routes (snapshot / reserve / settle /
// credential) are the ONLY control-plane surface the gateway may reach. Each is
// thin — it authenticates the gateway, reads or writes through an existing
// module, and returns. No business logic lives here.
//
// Authentication is fail-closed. GATEWAY_INTERNAL_TOKEN must be configured and
// must match; an unset token closes the surface (503) rather than opening it.
// This deliberately does NOT fall back to ADMIN_TOKEN or to the legacy
// `authorized()` behaviour that returned true when ADMIN_TOKEN was unset
// (Work Item C finding C3).

import { createHash, timingSafeEqual } from 'node:crypto'

export const GATEWAY_INTERNAL_TOKEN_ENV = 'GATEWAY_INTERNAL_TOKEN'

/** Stable error codes for the internal surface. */
export type InternalErrorCode =
  | 'internal_auth_not_configured'
  | 'unauthorized'
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'budget_exceeded'
  | 'internal_error'

export interface InternalErrorBody {
  error: {
    code: InternalErrorCode
    message: string
  }
}

export function internalError(status: number, code: InternalErrorCode, message: string): Response {
  return Response.json({ error: { code, message } } satisfies InternalErrorBody, { status })
}

function constantTimeEquals(a: string, b: string): boolean {
  // Hash both sides so the comparison is over fixed-length buffers; this avoids
  // leaking length as well as content.
  const left = createHash('sha256').update(a).digest()
  const right = createHash('sha256').update(b).digest()
  return timingSafeEqual(left, right)
}

/**
 * Authenticate a gateway call. Returns a Response to send when the caller is not
 * authorized, or null when the request may proceed.
 */
export function requireGatewayToken(req: Request): Response | null {
  const expected = process.env[GATEWAY_INTERNAL_TOKEN_ENV]?.trim()
  if (!expected) {
    // Fail closed: a missing token is a deployment error, not an open door.
    return internalError(503, 'internal_auth_not_configured', 'Gateway internal API is not configured.')
  }
  const header = req.headers.get('authorization') ?? ''
  const prefix = 'Bearer '
  if (!header.toLowerCase().startsWith(prefix.toLowerCase())) {
    return internalError(401, 'unauthorized', 'Missing bearer credentials.')
  }
  const presented = header.slice(prefix.length).trim()
  if (!presented || !constantTimeEquals(presented, expected)) {
    return internalError(401, 'unauthorized', 'Invalid gateway credentials.')
  }
  return null
}

/** Parse a JSON body, returning null on malformed input. */
export async function readJsonBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T
  } catch {
    return null
  }
}

/** True when the string is a non-empty trimmed value. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Normalize an optional tenant scope: '' and null both mean the platform scope. */
export function normalizeTenantScope(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
