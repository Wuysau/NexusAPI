// Next.js middleware — request-id, trace-id, and security headers.
//
// This runs on every request through the Next.js runtime (before route
// handlers). It:
//   1. Generates or accepts a request_id (X-Request-Id) and trace_id
//      (X-Trace-Id) and propagates them as request headers so route handlers
//      can read them.
//   2. Sets security headers on the response (CSP, HSTS, X-Content-Type-
//      Options, X-Frame-Options, Referrer-Policy, Permissions-Policy).
//
// The middleware is intentionally minimal — no auth, no DB, no logging. Auth
// is handled by the route handlers (control-plane.ts) so a middleware failure
// can never bypass it.

import { NextResponse, type NextRequest } from 'next/server'
import { generateRequestId, REQUEST_ID_HEADER, TRACE_ID_HEADER } from '@/lib/middleware/request-id'
import { applySecurityHeaders } from '@/lib/middleware/security-headers'

export function middleware(req: NextRequest): NextResponse {
  // Resolve or generate request/trace ids.
  const requestId = req.headers.get(REQUEST_ID_HEADER) || generateRequestId()
  const traceId = req.headers.get(TRACE_ID_HEADER) || requestId

  // Propagate to the route handler via request headers.
  const requestHeaders = new Headers(req.headers)
  requestHeaders.set(REQUEST_ID_HEADER, requestId)
  requestHeaders.set(TRACE_ID_HEADER, traceId)

  const res = NextResponse.next({
    request: { headers: requestHeaders },
  })

  // Echo the ids on the response so a client can correlate.
  res.headers.set(REQUEST_ID_HEADER, requestId)
  res.headers.set(TRACE_ID_HEADER, traceId)

  // Security headers.
  applySecurityHeaders(res.headers)

  return res
}

export const config = {
  // Run on all routes except static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
