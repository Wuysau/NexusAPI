import { pool } from '@/db'
import { verifyPassword } from '@/lib/crypto'
import { createSession } from '@/lib/auth/sessions'
import { isRole } from '@/lib/auth/capabilities'
import { safeLogAudit } from '@/lib/audit'
import { apiError, clientIp, readJsonBody, routeError } from '../../_lib/control-plane'
import { authJson, issueAuth } from '../_lib'

export const dynamic = 'force-dynamic'

interface LoginBody {
  email?: unknown
  password?: unknown
}

/**
 * Email + password login. The response is deliberately identical for an
 * unknown user and a wrong password: no account enumeration. Sessions are
 * created through Work Item C's session service (only the hash is stored).
 */
export async function POST(req: Request) {
  try {
    const body = await readJsonBody<LoginBody>(req)
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!email || !password) return apiError(400, 'invalid_request', '请输入邮箱和密码')

    const result = await pool.query<{
      id: string
      email: string
      name: string | null
      password_hash: string
      status: string
    }>(
      'SELECT id, email, name, password_hash, status FROM users WHERE lower(email) = $1 AND deleted_at IS NULL LIMIT 1',
      [email],
    )
    const user = result.rows[0]

    // Constant-ish work either way: verify against a dummy hash when the user
    // does not exist so timing does not reveal account existence.
    const stored = user?.password_hash ?? 'scrypt$16384$8$1$00$00'
    const valid = verifyPassword(password, stored)
    if (!user || !valid || user.status !== 'active') {
      await safeLogAudit({
        action: 'auth.login_failed',
        targetType: 'user',
        targetId: user?.id,
        metadata: { email, reason: !user ? 'unknown_user' : !valid ? 'bad_password' : 'inactive' },
        ip: clientIp(req),
      })
      return apiError(401, 'invalid_credentials', '邮箱或密码不正确')
    }

    const membership = await pool.query<{
      role: string
      organization_id: string
      tenant_id: string
      name: string
      slug: string
    }>(
      `SELECT m.role, m.organization_id, m.tenant_id, o.name, o.slug
         FROM organization_memberships m
         JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1 AND o.deleted_at IS NULL
        ORDER BY m.created_at ASC LIMIT 1`,
      [user.id],
    )
    const m = membership.rows[0]
    if (!m || !isRole(m.role)) {
      return apiError(403, 'no_organization', '该账号未加入任何组织，请联系管理员')
    }

    const { token } = await createSession({
      userId: user.id,
      ip: clientIp(req),
      userAgent: req.headers.get('user-agent') ?? undefined,
    })
    return authJson(
      {
        authenticated: true,
        user: { id: user.id, email: user.email, name: user.name },
        organization: { id: m.organization_id, tenantId: m.tenant_id, name: m.name, slug: m.slug },
        role: m.role,
      },
      issueAuth(token),
    )
  } catch (error) {
    return routeError(error)
  }
}
