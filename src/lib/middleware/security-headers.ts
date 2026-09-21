// Security headers for the control plane.
//
// These headers are set on every response from the dashboard API:
//   - Content-Security-Policy: restrict to 'self' + inline styles (Tailwind);
//     no external origins, no framing.
//   - Strict-Transport-Security: 1 year, includeSubDomains.
//   - X-Content-Type-Options: nosniff.
//   - X-Frame-Options: DENY (defence in depth with CSP frame-ancestors).
//   - Referrer-Policy: strict-origin-when-cross-origin.
//   - Permissions-Policy: deny camera, microphone, geolocation.
//
// The Go gateway sets its own headers (it serves a different trust boundary);
// these apply to the Next.js control plane only.

export interface SecurityHeaderConfig {
  /** Override the CSP (e.g. to allow a specific analytics origin). */
  contentSecurityPolicy?: string
  /** Override HSTS max-age (seconds). Default 31536000 (1 year). */
  hstsMaxAge?: number
  /** Disable HSTS (e.g. for local dev over HTTP). */
  hstsDisabled?: boolean
}

const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

const DEFAULT_PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=()'

/**
 * Apply security headers to a Headers object. Idempotent: safe to call on a
 * response that already has some of these set (overwrites with the secure
 * value).
 */
export function applySecurityHeaders(headers: Headers, config: SecurityHeaderConfig = {}): void {
  headers.set('Content-Security-Policy', config.contentSecurityPolicy ?? DEFAULT_CSP)
  if (!config.hstsDisabled) {
    const maxAge = config.hstsMaxAge ?? 31536000
    headers.set('Strict-Transport-Security', `max-age=${maxAge}; includeSubDomains`)
  }
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  headers.set('Permissions-Policy', DEFAULT_PERMISSIONS_POLICY)
  headers.set('X-DNS-Prefetch-Control', 'off')
}

/**
 * Return the headers as a plain object. Useful for Next.js middleware where
 * the response is built with `NextResponse.next({ request: { headers } })`.
 */
export function securityHeaders(config: SecurityHeaderConfig = {}): Record<string, string> {
  const out: Record<string, string> = {}
  const tmp = new Headers()
  applySecurityHeaders(tmp, config)
  tmp.forEach((value, key) => {
    out[key] = value
  })
  return out
}
