// Session management for the control plane.
//
// Threat model: session tokens are bearer credentials. We therefore:
//   - generate 256 bits of entropy (crypto.newSessionToken),
//   - store ONLY sha256(token) in the sessions table (never the plaintext),
//   - return the plaintext once, to be put in an httpOnly cookie,
//   - scope the cookie to Path=/ with SameSite=Lax and Secure in production,
//   - default to an 8h TTL and support a shorter "fresh auth" window for
//     high-risk operations (requireRecentAuth).
//
// The sessions table (schema.ts) is user-scoped, not tenant-scoped: a user can
// belong to multiple organizations with different roles.

import { pool } from '@/db'
import { env } from '@/lib/config'
import { constantTimeEqual, newSessionToken, sha256hex } from '@/lib/crypto'
import { logAudit, safeLogAudit, AUDIT_ACTIONS } from '@/lib/audit'
import { AuthzError } from '@/lib/auth/capabilities'

export const SESSION_COOKIE = 'nexus_session'
export const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60
export const DEFAULT_FRESH_AUTH_SECONDS = 15 * 60

export interface SessionRecord {
  id: string
  userId: string
  expiresAt: Date
  createdAt: Date
  lastSeenAt?: Date | null
}

export interface CookieOptions {
  isProduction?: boolean
  domain?: string
  ttlSeconds?: number
  path?: string
}

export interface CreateSessionInput {
  userId: string
  ip?: string
  userAgent?: string
  ttlSeconds?: number
  actorUserId?: string
  traceId?: string
}

export interface VerifiedSession extends SessionRecord {
  /** Seconds since the session was created. */
  ageSeconds: number
}

export function sessionTtlSeconds(override?: number): number {
  if (override && Number.isFinite(override) && override > 0) return Math.floor(override)
  try {
    return env().sessionTtlSeconds
  } catch {
    // Config unavailable (e.g. unit context): fail to the safe default.
    return DEFAULT_SESSION_TTL_SECONDS
  }
}

export function serializeSessionCookie(token: string, opts: CookieOptions = {}): string {
  const ttl = opts.ttlSeconds ?? sessionTtlSeconds()
  const parts = [`${SESSION_COOKIE}=${token}`, `Path=${opts.path ?? '/'}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${ttl}`]
  if (opts.isProduction) parts.push('Secure')
  if (opts.domain) parts.push(`Domain=${opts.domain}`)
  return parts.join('; ')
}

export function clearSessionCookie(opts: CookieOptions = {}): string {
  const parts = [`${SESSION_COOKIE}=`, `Path=${opts.path ?? '/'}`, 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (opts.isProduction) parts.push('Secure')
  if (opts.domain) parts.push(`Domain=${opts.domain}`)
  return parts.join('; ')
}

/** Parse the session token out of a raw Cookie header. */
export function parseSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === SESSION_COOKIE) return part.slice(idx + 1).trim()
  }
  return null
}

/**
 * Create a session. Returns the plaintext token exactly once; only its hash is
 * persisted.
 */
export async function createSession(input: CreateSessionInput): Promise<{
  token: string
  session: SessionRecord
  cookie: string
}> {
  if (!input.userId) throw new Error('createSession: userId is required')
  const token = newSessionToken()
  const tokenHash = sha256hex(token)
  const ttl = sessionTtlSeconds(input.ttlSeconds)
  const expiresAt = new Date(Date.now() + ttl * 1000)

  const result = await pool.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, ip, user_agent)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
     RETURNING id, user_id, expires_at, created_at`,
    [input.userId, tokenHash, expiresAt, input.ip ?? null, input.userAgent ?? null],
  )
  const row = result.rows[0]
  const session: SessionRecord = {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }

  await logAudit({
    actorUserId: input.actorUserId ?? input.userId,
    tenantId: null,
    action: AUDIT_ACTIONS.sessionCreated,
    targetType: 'session',
    targetId: session.id,
    metadata: { ttlSeconds: ttl, ip: input.ip ?? null },
    ip: input.ip,
    traceId: input.traceId,
  })

  return {
    token,
    session,
    cookie: serializeSessionCookie(token, {
      isProduction: process.env.NODE_ENV === 'production',
      ttlSeconds: ttl,
    }),
  }
}

/**
 * Verify a presented token. Returns null for unknown, revoked or expired
 * sessions, or an inactive/deleted user — callers must not distinguish these.
 */
export async function verifySession(token: string | null | undefined): Promise<VerifiedSession | null> {
  if (!token || token.length < 32) return null
  const tokenHash = sha256hex(token)

  const result = await pool.query(
    `SELECT s.id, s.user_id, s.token_hash, s.expires_at, s.revoked_at, s.created_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND u.status = 'active' AND u.deleted_at IS NULL
     LIMIT 1`,
    [tokenHash],
  )
  if (!result.rows.length) return null
  const row = result.rows[0]

  // Defence in depth: the indexed lookup above is not constant-time.
  if (!constantTimeEqual(row.token_hash, tokenHash)) return null
  if (row.revoked_at) return null
  if (new Date(row.expires_at).getTime() <= Date.now()) return null

  const createdAt = new Date(row.created_at)
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: new Date(row.expires_at),
    createdAt,
    ageSeconds: Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 1000)),
  }
}

/** Revoke one session by token. Idempotent; returns whether a row changed. */
export async function revokeSession(
  token: string | null | undefined,
  ctx: { actorUserId?: string; ip?: string; traceId?: string } = {},
): Promise<boolean> {
  if (!token) return false
  const tokenHash = sha256hex(token)
  const result = await pool.query(
    `UPDATE sessions SET revoked_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL
     RETURNING id, user_id`,
    [tokenHash],
  )
  if (!result.rows.length) return false
  await safeLogAudit({
    actorUserId: ctx.actorUserId ?? result.rows[0].user_id,
    tenantId: null,
    action: AUDIT_ACTIONS.sessionRevoked,
    targetType: 'session',
    targetId: result.rows[0].id,
    ip: ctx.ip,
    traceId: ctx.traceId,
  })
  return true
}

/** Revoke every active session for a user (password change, break-glass). */
export async function revokeAllUserSessions(
  userId: string,
  ctx: { actorUserId?: string; ip?: string; traceId?: string } = {},
): Promise<number> {
  const result = await pool.query(
    `UPDATE sessions SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL
     RETURNING id`,
    [userId],
  )
  if (result.rowCount) {
    await safeLogAudit({
      actorUserId: ctx.actorUserId ?? userId,
      tenantId: null,
      action: AUDIT_ACTIONS.sessionRevoked,
      targetType: 'user',
      targetId: userId,
      metadata: { revokedCount: result.rowCount, all: true },
      ip: ctx.ip,
      traceId: ctx.traceId,
    })
  }
  return result.rowCount ?? 0
}

/**
 * Short-lived high-risk authorization: a valid session is not enough for
 * destructive/secret operations; it must have been created within
 * `maxAgeSeconds` (default 15 min), or the caller must re-authenticate.
 */
export function requireRecentAuth(session: VerifiedSession | null, maxAgeSeconds = DEFAULT_FRESH_AUTH_SECONDS): void {
  if (!session) throw new AuthzError('unauthenticated', 'authentication required')
  if (session.ageSeconds > maxAgeSeconds) {
    throw new AuthzError('forbidden', 'recent authentication required', 401)
  }
}

/** Test/maintenance helper: delete expired or long-revoked session rows. */
export async function purgeExpiredSessions(olderThanSeconds = 30 * 24 * 60 * 60): Promise<number> {
  const result = await pool.query(
    `DELETE FROM sessions WHERE expires_at < now() - ($1::text || ' seconds')::interval`,
    [String(olderThanSeconds)],
  )
  return result.rowCount ?? 0
}
