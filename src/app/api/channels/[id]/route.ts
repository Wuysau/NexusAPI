// Single channel: configuration, credential rotation and disable.
//
// Only channels owned by the caller's tenant are mutable; platform channels
// (tenant_id IS NULL) are read-only from a customer console.

import { pool } from '@/db'
import { disableCredential } from '@/lib/secrets/envelope'
import { assertLocalKeyInput, LocalCredentialError } from '@/lib/channels/local-credentials'
import { replaceLocalKey, revokeLocalChannel } from '@/lib/channels/local-management'
import {
  apiError,
  auditControlPlane,
  jsonOk,
  readJsonBody,
  requireContext,
  requireHighRiskContext,
  routeError,
} from '../../_lib/control-plane'

export const dynamic = 'force-dynamic'

const CAPABILITIES = ['chat', 'embeddings', 'images', 'audio', 'tools', 'multimodal'] as const

async function ownedChannel(
  id: string,
  tenantId: string,
): Promise<{ id: string; credentialId: string | null; providerId: string } | null> {
  const result = await pool.query<{ id: string; provider_credential_id: string | null; provider_id: string }>(
    'SELECT id, provider_credential_id, provider_id FROM channels WHERE id = $1 AND tenant_id = $2 LIMIT 1',
    [id, tenantId],
  )
  const row = result.rows[0]
  return row ? { id: row.id, credentialId: row.provider_credential_id, providerId: row.provider_id } : null
}

interface PatchBody {
  enabled?: unknown
  weight?: unknown
  priority?: unknown
  region?: unknown
  capabilities?: unknown
  secret?: unknown
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const channel = await ownedChannel(id, (await requireContext(req)).tenantId)
    if (!channel) return apiError(404, 'not_found', '渠道不存在')

    const body = await readJsonBody<PatchBody>(req)

    if (body?.secret !== undefined) {
      const ctx = await requireHighRiskContext(req, 'credential:rotate')
      assertLocalKeyInput(req)
      return jsonOk(await replaceLocalKey(ctx, id, body.secret))
    }

    const ctx = await requireContext(req, 'credential:disable')
    const sets: string[] = []
    const values: unknown[] = [id, ctx.tenantId]
    const push = (column: string, value: unknown) => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }

    if (body?.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return apiError(400, 'invalid_request', 'enabled 必须为布尔值')
      if (body.enabled && channel.credentialId) {
        const credential = await pool.query('SELECT enabled FROM provider_credentials WHERE id=$1 AND tenant_id=$2', [
          channel.credentialId,
          ctx.tenantId,
        ])
        if (credential.rows[0]?.enabled !== true)
          return apiError(409, 'credential_disabled', '请先替换已禁用的 API Key，再启用渠道')
      }
      // A temporary channel pause must not irreversibly disable its credential.
      push('enabled', body.enabled)
    }
    if (body?.weight !== undefined) {
      const weight = Number(body.weight)
      if (!Number.isInteger(weight) || weight < 1 || weight > 100)
        return apiError(400, 'invalid_request', '权重范围为 1–100')
      push('weight', weight)
    }
    if (body?.priority !== undefined) {
      const priority = Number(body.priority)
      if (!Number.isInteger(priority) || priority < 0 || priority > 1000)
        return apiError(400, 'invalid_request', '优先级无效')
      push('priority', priority)
    }
    if (body?.region !== undefined) {
      const region = typeof body.region === 'string' ? body.region.trim().slice(0, 40) : ''
      if (!region) return apiError(400, 'invalid_request', '区域无效')
      push('region', region)
    }
    if (body?.capabilities !== undefined) {
      const capabilities = Array.isArray(body.capabilities)
        ? (body.capabilities as unknown[]).filter(
            (c): c is string => typeof c === 'string' && (CAPABILITIES as readonly string[]).includes(c),
          )
        : []
      if (!capabilities.length) return apiError(400, 'invalid_request', '请至少选择一种能力')
      values.push(JSON.stringify(capabilities))
      sets.push(`capabilities = $${values.length}::jsonb`)
    }
    if (!sets.length) return apiError(400, 'invalid_request', '没有可更新的字段')

    sets.push('updated_at = now()')
    await pool.query(`UPDATE channels SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2`, values)
    await auditControlPlane(
      ctx,
      'channel.updated',
      { type: 'channel', id },
      {
        fields: Object.keys(body ?? {}).filter((k) => k !== 'secret'),
      },
    )
    return jsonOk({ id, updated: true })
  } catch (error) {
    if (error instanceof LocalCredentialError) return apiError(error.status, error.code, error.message)
    return routeError(error)
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const ctx = await requireHighRiskContext(req, 'credential:disable')
    const channel = await ownedChannel(id, ctx.tenantId)
    if (!channel) return apiError(404, 'not_found', '渠道不存在')

    const local = await pool.query(
      `SELECT provider_id,provider_credential_id,metadata FROM channels WHERE id=$1 AND tenant_id=$2 AND metadata->>'credential_storage'='local'`,
      [id, ctx.tenantId],
    )
    if (local.rows[0]) {
      assertLocalKeyInput(req)
      return jsonOk(await revokeLocalChannel(ctx, id))
    }

    if (channel.credentialId) {
      await disableCredential({
        credentialId: channel.credentialId,
        tenantId: ctx.tenantId,
        actorUserId: ctx.principal.userId,
        reason: 'channel removed',
      })
    }
    // Soft-disable rather than delete so historical requests stay attributable.
    await pool.query('UPDATE channels SET enabled = false, updated_at = now() WHERE id = $1 AND tenant_id = $2', [
      id,
      ctx.tenantId,
    ])
    await auditControlPlane(ctx, 'channel.disabled', { type: 'channel', id }, { credentialId: channel.credentialId })
    return jsonOk({ id, disabled: true })
  } catch (error) {
    if (error instanceof LocalCredentialError) return apiError(error.status, error.code, error.message)
    return routeError(error)
  }
}
