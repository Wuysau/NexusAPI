// Single downstream key: enable/disable (reversible) and revoke (terminal,
// high-risk → fresh session required).

import { pool } from '@/db'
import { apiKeyVisibility, workspaceParams } from '@/lib/workspace/management'
import { ApiKeyError, invalidateDownstreamKeyCache, revokeDownstreamKey } from '@/lib/auth/api-keys'
import {
  apiError,
  auditControlPlane,
  clientIp,
  jsonOk,
  readJsonBody,
  requireContext,
  requireHighRiskContext,
  routeError,
} from '../../_lib/control-plane'

export const dynamic = 'force-dynamic'

interface PatchBody {
  enabled?: unknown
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    await requireContext(req, 'apikey:revoke')
    const body = await readJsonBody<PatchBody>(req)
    const ctx = await requireContext(req, 'apikey:revoke')
    if (typeof body?.enabled !== 'boolean') return apiError(400, 'invalid_request', '缺少 enabled 字段')

    const updated = await pool.query(
      `UPDATE downstream_api_keys k SET enabled = $6
        WHERE ${apiKeyVisibility} AND k.id=$5 AND k.revoked_at IS NULL AND k.deleted_at IS NULL
        RETURNING k.id`,
      [...workspaceParams(ctx), id, body.enabled],
    )
    if (!updated.rowCount) return apiError(404, 'not_found', '密钥不存在或已撤销')
    if (!body.enabled) invalidateDownstreamKeyCache(id)
    await auditControlPlane(
      ctx,
      body.enabled ? 'apikey.enabled' : 'apikey.disabled',
      { type: 'downstream_api_key', id },
      {
        ip: clientIp(req),
      },
    )
    return jsonOk({ id, enabled: body.enabled })
  } catch (error) {
    return routeError(error)
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    // Revocation is terminal and cannot be undone → fresh session required.
    const ctx = await requireHighRiskContext(req, 'apikey:revoke')
    const visible = await pool.query(
      `SELECT k.id FROM downstream_api_keys k WHERE ${apiKeyVisibility} AND k.id=$5 AND k.deleted_at IS NULL`,
      [...workspaceParams(ctx), id],
    )
    if (!visible.rows.length) return apiError(404, 'not_found', '密钥不存在或已撤销')
    try {
      const revoked = await revokeDownstreamKey({
        tenantId: ctx.tenantId,
        keyId: id,
        actorUserId: ctx.principal.userId,
        ip: clientIp(req),
      })
      if (!revoked) return apiError(404, 'not_found', '密钥不存在或已撤销')
      return jsonOk({ id, revoked: true })
    } catch (error) {
      if (error instanceof ApiKeyError) return apiError(400, error.code, error.message)
      throw error
    }
  } catch (error) {
    return routeError(error)
  }
}
