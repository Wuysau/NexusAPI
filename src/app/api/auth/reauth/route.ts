import { pool } from '@/db'
import { verifyPassword } from '@/lib/crypto'
import { createSession, parseSessionCookie, revokeSession } from '@/lib/auth/sessions'
import { safeLogAudit } from '@/lib/audit'
import { apiError, clientIp, readJsonBody, requireContext, routeError } from '../../_lib/control-plane'
import { authJson, issueAuth, sessionPayload } from '../_lib'

export const dynamic = 'force-dynamic'

/**
 * Re-authentication for high-risk operations. Verifying the password rotates
 * the session: the old token is revoked and a new one is issued, which resets
 * `ageSeconds` and puts the caller back inside the fresh-auth window that
 * `requireRecentAuth` checks.
 *
 * This is deliberately NOT a capability — a viewer can refresh their own
 * session, but still cannot approve prices or revoke keys.
 */
export async function POST(req: Request) {
  try {
    const ctx = await requireContext(req)
    const userId = ctx.principal.userId
    if (!userId) return apiError(401, 'unauthenticated', '请先登录')
    const body = await readJsonBody<{ password?: unknown }>(req)
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!password) return apiError(400, 'invalid_request', '请输入密码以继续')

    const result = await pool.query<{ password_hash: string; email: string; name: string | null }>(
      'SELECT password_hash, email, name FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
      [userId],
    )
    const user = result.rows[0]
    if (!user || !verifyPassword(password, user.password_hash)) {
      await safeLogAudit({
        actorUserId: userId,
        tenantId: ctx.tenantId,
        action: 'auth.reauth_failed',
        targetType: 'user',
        targetId: userId,
        ip: clientIp(req),
      })
      return apiError(401, 'invalid_credentials', '密码不正确')
    }

    const oldToken = parseSessionCookie(req.headers.get('cookie'))
    await revokeSession(oldToken, { actorUserId: userId, ip: clientIp(req) })
    const { token, session } = await createSession({ userId: userId, ip: clientIp(req) })
    await safeLogAudit({
      actorUserId: userId,
      tenantId: ctx.tenantId,
      action: 'auth.reauth_succeeded',
      targetType: 'user',
      targetId: userId,
      ip: clientIp(req),
    })
    // The old session is revoked, so re-derive the payload from the freshly
    // created session rather than re-reading the request cookie.
    const refreshed = { ...ctx, session: { ...session, ageSeconds: 0 } }
    return authJson(sessionPayload(refreshed, user.email, user.name), issueAuth(token))
  } catch (error) {
    return routeError(error)
  }
}
