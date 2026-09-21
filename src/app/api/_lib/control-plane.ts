// Shared plumbing for the control-plane (dashboard) API surface.
//
// Every dashboard endpoint authenticates through Work Item C's session system
// (httpOnly cookie) and enforces its capability server-side with
// `requireCapability`. The UI is allowed to hide a button; that is never the
// security boundary. State-changing requests additionally require the
// double-submit CSRF token (C), and high-risk operations (price approval, key
// revocation, credential rotation/disable) additionally require a *fresh*
// session via `requireRecentAuth` — re-authenticate at `/api/auth/reauth`.
//
// This module is the only place that maps auth failures to HTTP. It never
// leaks an upstream error body: unexpected errors become a generic 500 and are
// logged server-side.

import { NextResponse } from 'next/server'
import { pool } from '@/db'
import { CSRF_COOKIE, CSRF_HEADER, CsrfError, assertCsrf, parseCookie } from '@/lib/auth/csrf'
import { SESSION_COOKIE, requireRecentAuth, verifySession, type VerifiedSession } from '@/lib/auth/sessions'
import {
  AuthzError,
  capabilitiesForRole,
  isRole,
  requireCapability,
  type Capability,
  type Principal,
  type Role,
} from '@/lib/auth/capabilities'
import { safeLogAudit } from '@/lib/audit'
import { getRootLogger, hashTenantId } from '@/../packages/observability/logger'
import { resolveRequestIds, stampResponseHeaders, REQUEST_ID_HEADER } from '@/lib/middleware/request-id'
import { applySecurityHeaders } from '@/lib/middleware/security-headers'

export interface Membership {
  organizationId: string
  tenantId: string
  organizationName: string
  organizationSlug: string
  role: Role
}

export interface ControlPlaneContext {
  principal: Principal
  session: VerifiedSession
  membership: Membership
  tenantId: string
  organizationId: string
  capabilities: readonly Capability[]
}

// ── Response helpers ──────────────────────────────────────────────────

export interface ApiErrorBody {
  error: { code: string; message: string }
}

/**
 * Stamp request-id, trace-id, and security headers on a response. Called by
 * `apiError` and `jsonOk` so every control-plane response is correlatable and
 * security-hardened.
 */
function stamp<T>(res: NextResponse<T>, req?: Request): NextResponse<T> {
  if (req) {
    const ids = resolveRequestIds(req)
    stampResponseHeaders(res.headers, ids)
  }
  applySecurityHeaders(res.headers)
  return res
}

export function apiError(status: number, code: string, message: string, req?: Request): NextResponse<ApiErrorBody> {
  return stamp(NextResponse.json({ error: { code, message } }, { status }), req)
}

export function jsonOk<T>(data: T, status = 200, req?: Request): NextResponse {
  return stamp(NextResponse.json(data, { status }), req)
}

/**
 * Map a thrown error to a safe HTTP response. AuthzError/CsrfError carry an
 * intentional status; everything else is a generic 500 (no internal detail).
 * The internal message is logged (redacted) but never sent to the client.
 */
export function routeError(error: unknown, req?: Request): NextResponse<ApiErrorBody> {
  if (error instanceof AuthzError) {
    return apiError(error.status, error.code, error.message, req)
  }
  if (error instanceof CsrfError) {
    return apiError(error.status, error.code, error.message, req)
  }
  const message = error instanceof Error ? error.message : String(error)
  const logger = getRootLogger()
  logger.error('control-plane route error', {
    error_kind: error instanceof Error ? error.name : 'unknown',
    msg: message,
  })
  return apiError(500, 'internal_error', '服务暂时不可用，请稍后重试', req)
}

export async function readJsonBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T
  } catch {
    return null
  }
}

// ── Principal resolution ──────────────────────────────────────────────

async function loadMembership(userId: string): Promise<Membership | null> {
  const result = await pool.query<{
    organization_id: string
    tenant_id: string
    name: string
    slug: string
    role: string
  }>(
    `SELECT m.organization_id, m.tenant_id, o.name, o.slug, m.role
       FROM organization_memberships m
       JOIN organizations o ON o.id = m.organization_id AND o.tenant_id = m.tenant_id
      WHERE m.user_id = $1 AND o.status = 'active' AND o.deleted_at IS NULL
      ORDER BY m.created_at ASC
      LIMIT 1`,
    [userId],
  )
  const row = result.rows[0]
  if (!row || !isRole(row.role)) return null
  return {
    organizationId: row.organization_id,
    tenantId: row.tenant_id,
    organizationName: row.name,
    organizationSlug: row.slug,
    role: row.role,
  }
}

/**
 * Resolve the cookie session to a tenant-scoped principal. Returns null when
 * there is no valid session or the user holds no organization membership.
 * A valid session belonging to a user with no membership is NOT a control-plane
 * principal — it must not inherit any capability.
 */
export async function resolveContext(req: Request): Promise<ControlPlaneContext | null> {
  const token = parseCookie(req.headers.get('cookie'), SESSION_COOKIE)
  const session = await verifySession(token)
  if (!session) return null
  const membership = await loadMembership(session.userId)
  if (!membership) return null
  const principal: Principal = {
    kind: 'user',
    role: membership.role,
    userId: session.userId,
    tenantId: membership.tenantId,
  }
  return {
    principal,
    session,
    membership,
    tenantId: membership.tenantId,
    organizationId: membership.organizationId,
    capabilities: capabilitiesForRole(membership.role),
  }
}

/**
 * Resolve and authorize. Throws AuthzError (401/403) when the caller is not
 * permitted, so route handlers can simply try/catch → `routeError`.
 *
 * CSRF is enforced here for every state-changing request: by the time a route
 * is reached, an authenticated mutating call MUST carry `x-csrf-token` matching
 * the `nexus_csrf` cookie.
 */
export async function requireContext(req: Request, capability?: Capability): Promise<ControlPlaneContext> {
  const ctx = await resolveContext(req)
  if (!ctx) throw new AuthzError('unauthenticated', '请先登录')
  if (capability) requireCapability(ctx.principal, capability)
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    assertCsrf({
      method: req.method,
      headerToken: req.headers.get(CSRF_HEADER),
      cookieToken: parseCookie(req.headers.get('cookie'), CSRF_COOKIE),
    })
  }
  return ctx
}

/** Same as `requireContext` but also demands a session created within the fresh-auth window. */
export async function requireHighRiskContext(req: Request, capability: Capability): Promise<ControlPlaneContext> {
  const ctx = await requireContext(req, capability)
  requireRecentAuth(ctx.session)
  return ctx
}

/** Best-effort audit for control-plane actions not already audited by a backend service. */
export async function auditControlPlane(
  ctx: ControlPlaneContext,
  action: string,
  target: { type: string; id?: string },
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await safeLogAudit({
    actorUserId: ctx.principal.userId,
    tenantId: ctx.tenantId,
    action,
    targetType: target.type,
    targetId: target.id,
    metadata,
  })
}

/** Client IP, tolerant of proxies (first hop only, never trusted beyond logging). */
export function clientIp(req: Request): string | undefined {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim() || undefined
  return req.headers.get('x-real-ip') ?? undefined
}
