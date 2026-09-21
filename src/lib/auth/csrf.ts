// CSRF protection for control-plane state changes.
//
// Double-submit cookie pattern: the server issues a random token, stores it in
// a SameSite=Lax cookie readable by the browser app, and requires the same
// value back in a header (or form field) on every state-changing request.
// Comparison is constant-time (crypto.ts constantTimeEqual).
//
// SameSite=Lax alone blocks cross-site POSTs from forms; the token is the
// second factor for the (unlikely) case a browser sends Lax cookies on a
// top-level navigation or an old browser ignores SameSite.

import { randomBytes } from 'crypto'
import { constantTimeEqual } from '@/lib/crypto'
import { safeLogAudit } from '@/lib/audit'

export const CSRF_COOKIE = 'nexus_csrf'
export const CSRF_HEADER = 'x-csrf-token'
export const CSRF_FIELD = '_csrf'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export class CsrfError extends Error {
  readonly status = 403
  readonly code = 'csrf_failed'

  constructor(message = 'CSRF token missing or invalid') {
    super(message)
    this.name = 'CsrfError'
  }
}

export interface CookieSerializeOptions {
  isProduction?: boolean
  maxAgeSeconds?: number
  domain?: string
}

export function issueCsrfToken(): string {
  return randomBytes(32).toString('hex')
}

export function requiresCsrf(method: string | undefined | null): boolean {
  return !SAFE_METHODS.has((method ?? 'GET').toUpperCase())
}

export function verifyCsrfToken(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false
  return constantTimeEqual(provided, expected)
}

export function serializeCsrfCookie(token: string, opts: CookieSerializeOptions = {}): string {
  const parts = [`${CSRF_COOKIE}=${token}`, 'Path=/', 'SameSite=Lax']
  // Readable by the browser app on purpose (double-submit), but not a secret
  // that grants anything on its own.
  if (opts.isProduction) parts.push('Secure')
  const maxAge = opts.maxAgeSeconds ?? 8 * 60 * 60
  parts.push(`Max-Age=${maxAge}`)
  if (opts.domain) parts.push(`Domain=${opts.domain}`)
  return parts.join('; ')
}

export function clearCsrfCookie(opts: CookieSerializeOptions = {}): string {
  const parts = [`${CSRF_COOKIE}=`, 'Path=/', 'SameSite=Lax', 'Max-Age=0']
  if (opts.isProduction) parts.push('Secure')
  if (opts.domain) parts.push(`Domain=${opts.domain}`)
  return parts.join('; ')
}

/** Parse a single cookie value out of a raw Cookie header. */
export function parseCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim()
  }
  return null
}

/**
 * Enforce CSRF on state-changing requests. No-op for safe methods.
 * `method` is normalised; header/body/cookie values are compared as-is.
 */
export function assertCsrf(input: {
  method?: string | null
  headerToken?: string | null
  bodyToken?: string | null
  cookieToken?: string | null
  ip?: string
  traceId?: string
}): void {
  if (!requiresCsrf(input.method)) return
  const provided = input.headerToken ?? input.bodyToken ?? null
  if (verifyCsrfToken(provided, input.cookieToken)) return

  // Audit before throwing; a rejected CSRF is a security event. No token
  // values are recorded.
  void safeLogAudit({
    action: 'csrf.rejected',
    metadata: {
      method: (input.method ?? '').toUpperCase(),
      hadHeaderToken: Boolean(input.headerToken),
      hadCookieToken: Boolean(input.cookieToken),
    },
    ip: input.ip,
    traceId: input.traceId,
  })
  throw new CsrfError()
}
