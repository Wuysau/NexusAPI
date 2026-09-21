// Shared plumbing for the internal orders surface the console (Work Item H)
// calls to create checkouts and refunds.
//
// Authentication is fail-closed: INTERNAL_ORDERS_TOKEN must be configured and
// match; an unset token closes the surface (503) rather than opening it. This
// token is separate from GATEWAY_INTERNAL_TOKEN so the console and the data
// plane do not share an identity.

import { createHash, timingSafeEqual } from 'node:crypto'

export const INTERNAL_ORDERS_TOKEN_ENV = 'INTERNAL_ORDERS_TOKEN'

export type OrdersErrorCode =
  | 'internal_auth_not_configured'
  | 'unauthorized'
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'managed_credits_not_enabled'
  | 'entitlement_missing'
  | 'internal_error'

export function ordersError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest()
  const right = createHash('sha256').update(b).digest()
  return timingSafeEqual(left, right)
}

export function requireOrdersToken(req: Request): Response | null {
  const expected = process.env[INTERNAL_ORDERS_TOKEN_ENV]?.trim()
  if (!expected) {
    return ordersError(503, 'internal_auth_not_configured', 'Internal orders API is not configured.')
  }
  const header = req.headers.get('authorization') ?? ''
  const prefix = 'Bearer '
  if (!header.toLowerCase().startsWith(prefix.toLowerCase())) {
    return ordersError(401, 'unauthorized', 'Missing bearer credentials.')
  }
  const presented = header.slice(prefix.length).trim()
  if (!presented || !constantTimeEquals(presented, expected)) {
    return ordersError(401, 'unauthorized', 'Invalid internal credentials.')
  }
  return null
}

export async function readJsonBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T
  } catch {
    return null
  }
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Map a domain error (OrderError / ManagedCreditsError / PlanError) to HTTP. */
export function mapDomainError(e: unknown): Response {
  if (typeof e === 'object' && e !== null) {
    const err = e as { code?: unknown; message?: unknown; status?: unknown; reasons?: unknown }
    if (typeof err.status === 'number' && typeof err.code === 'string') {
      const body: Record<string, unknown> = { code: err.code, message: String(err.message ?? '') }
      if (Array.isArray(err.reasons) && err.reasons.length) body.reasons = err.reasons
      return Response.json({ error: body }, { status: err.status })
    }
  }
  return ordersError(500, 'internal_error', 'Request could not be completed.')
}
