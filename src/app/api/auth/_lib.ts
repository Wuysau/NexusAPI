// Cookie plumbing shared by the auth routes.
//
// Session cookie: httpOnly (never readable by JS). CSRF cookie: deliberately
// readable by the dashboard so it can echo it back in `x-csrf-token`
// (double-submit pattern, see src/lib/auth/csrf.ts).

import { NextResponse } from 'next/server'
import { CSRF_COOKIE, clearCsrfCookie, issueCsrfToken, serializeCsrfCookie } from '@/lib/auth/csrf'
import { clearSessionCookie, serializeSessionCookie, sessionTtlSeconds } from '@/lib/auth/sessions'
import { capabilitiesForRole, type Capability, type Role } from '@/lib/auth/capabilities'
import type { ControlPlaneContext } from '../_lib/control-plane'

const isProduction = () => process.env.NODE_ENV === 'production'

export interface IssuedAuth {
  cookies: string[]
  csrfToken: string
}

/** Build the session + CSRF Set-Cookie values for a freshly authenticated caller. */
export function issueAuth(sessionToken: string, ttlSeconds?: number): IssuedAuth {
  const ttl = ttlSeconds ?? sessionTtlSeconds()
  const csrfToken = issueCsrfToken()
  return {
    csrfToken,
    cookies: [
      serializeSessionCookie(sessionToken, { isProduction: isProduction(), ttlSeconds: ttl }),
      serializeCsrfCookie(csrfToken, { isProduction: isProduction(), maxAgeSeconds: ttl }),
    ],
  }
}

/** JSON response carrying a newly issued auth cookie pair. Never cached. */
export function authJson(body: object, issued: IssuedAuth, status = 200): NextResponse {
  const res = NextResponse.json({ ...body, csrfToken: issued.csrfToken }, { status })
  for (const cookie of issued.cookies) res.headers.append('Set-Cookie', cookie)
  res.headers.set('Cache-Control', 'no-store')
  return res
}

/** Append the session + CSRF cookies to an existing response. */
export function applyAuthCookies(res: NextResponse, sessionToken: string, ttlSeconds?: number): IssuedAuth {
  const issued = issueAuth(sessionToken, ttlSeconds)
  for (const cookie of issued.cookies) res.headers.append('Set-Cookie', cookie)
  return issued
}

export function clearAuthCookies(res: NextResponse): void {
  res.headers.append('Set-Cookie', clearSessionCookie({ isProduction: isProduction() }))
  res.headers.append('Set-Cookie', clearCsrfCookie({ isProduction: isProduction() }))
}

export interface SessionPayload {
  authenticated: true
  user: { id: string; email: string; name: string | null }
  organization: { id: string; tenantId: string; name: string; slug: string }
  role: Role
  capabilities: readonly Capability[]
  /** True when the session is inside the fresh-auth window (high-risk ops allowed). */
  freshAuth: boolean
  sessionExpiresAt: string
  /** Deployment environment; the shell shows a demo badge outside production. */
  environment: 'development' | 'test' | 'production'
}

export function sessionPayload(ctx: ControlPlaneContext, email: string, name: string | null): SessionPayload {
  return {
    authenticated: true,
    user: { id: ctx.principal.userId ?? '', email, name },
    organization: {
      id: ctx.organizationId,
      tenantId: ctx.tenantId,
      name: ctx.membership.organizationName,
      slug: ctx.membership.organizationSlug,
    },
    role: ctx.membership.role,
    capabilities: capabilitiesForRole(ctx.membership.role),
    freshAuth: ctx.session.ageSeconds <= 15 * 60,
    sessionExpiresAt: ctx.session.expiresAt.toISOString(),
    environment: (process.env.NODE_ENV as 'development' | 'test' | 'production' | undefined) ?? 'development',
  }
}

export { CSRF_COOKIE }
