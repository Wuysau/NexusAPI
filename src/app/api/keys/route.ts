// Downstream API keys (customer-facing `sk-nx-*` credentials).
//
// Replaces the `resource: 'keys'` branch of the legacy monolithic admin route.
// The plaintext key is returned exactly once by `createDownstreamKey`; this
// route never returns a hash or fingerprint.

import { createDownstreamKey, ApiKeyError } from '@/lib/auth/api-keys'
import { pool } from '@/db'
import { listApiKeys } from '@/lib/db/repositories'
import { API_KEY_SCOPES } from '@/lib/auth/api-keys'
import { resolveManagedProject } from '@/lib/workspace/management'
import { apiError, clientIp, jsonOk, readJsonBody, requireContext, routeError } from '../_lib/control-plane'

export const dynamic = 'force-dynamic'

interface CreateKeyBody {
  name?: unknown
  projectId?: unknown
  scopes?: unknown
  expiresAt?: unknown
}

function safeKey(row: Awaited<ReturnType<typeof listApiKeys>>[number]) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    enabled: row.enabled,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    status: row.revokedAt ? 'revoked' : row.enabled ? 'active' : 'disabled',
  }
}

export async function GET(req: Request) {
  try {
    const ctx = await requireContext(req, 'apikey:read')
    const keys = await listApiKeys(ctx.tenantId)
    const usable = keys.filter((key) => key.id !== 'key-demo-production')
    return jsonOk({
      keys: usable.map(safeKey),
      scopes: API_KEY_SCOPES,
      excludedDevelopmentKeys: keys.length - usable.length,
    })
  } catch (error) {
    return routeError(error)
  }
}

export async function POST(req: Request) {
  try {
    await requireContext(req, 'apikey:create')
    const body = await readJsonBody<CreateKeyBody>(req)
    const ctx = await requireContext(req, 'apikey:create')
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name) return apiError(400, 'invalid_name', '请填写密钥名称')
    if (name.length > 80) return apiError(400, 'invalid_name', '密钥名称不能超过 80 个字符')

    let scopes: string[] | undefined
    if (body?.scopes !== undefined) {
      if (!Array.isArray(body.scopes) || body.scopes.some((s) => typeof s !== 'string')) {
        return apiError(400, 'invalid_scope', '权限范围格式无效')
      }
      scopes = body.scopes as string[]
    }
    let expiresAt: Date | undefined
    if (body?.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== '') {
      const parsed = new Date(String(body.expiresAt))
      if (Number.isNaN(parsed.getTime())) return apiError(400, 'invalid_expiry', '过期时间格式无效')
      expiresAt = parsed
    }

    try {
      const projectId = typeof body?.projectId === 'string' ? body.projectId : null
      if (projectId) {
        await resolveManagedProject(pool, ctx, projectId)
        const project = await pool.query(
          'SELECT id FROM projects WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL',
          [projectId, ctx.tenantId],
        )
        if (!project.rows[0]) return apiError(404, 'project_not_found', '项目不存在')
      }
      const { plaintext, key } = await createDownstreamKey({
        tenantId: ctx.tenantId,
        name,
        projectId,
        scopes,
        expiresAt,
        actorUserId: ctx.principal.userId,
        ip: clientIp(req),
      })
      return jsonOk({ token: plaintext, key: { ...safeKey(key), projectId } }, 201)
    } catch (error) {
      if (error instanceof ApiKeyError) return apiError(400, error.code, error.message)
      throw error
    }
  } catch (error) {
    return routeError(error)
  }
}
