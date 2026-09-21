import { pool } from '@/db'
import { apiError, auditControlPlane, jsonOk, requireContext, routeError } from '../../../_lib/control-plane'
import { assertLocalKeyInput, LocalCredentialError, readLocalCredential } from '@/lib/channels/local-credentials'
import { bindingForChannel } from '@/lib/channels/local-management'
import { diagnoseConnection } from '@/lib/channels/diagnostic'

export const dynamic = 'force-dynamic'
const state = globalThis as typeof globalThis & { nexusChannelTests?: Set<string> }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let busyId: string | undefined
  try {
    const ctx = await requireContext(req, 'credential:create')
    assertLocalKeyInput(req)
    const { id } = await params
    const found = await pool.query(
      `SELECT c.provider_id,c.provider_credential_id,c.metadata FROM channels c
      JOIN provider_credentials p ON p.id=c.provider_credential_id AND p.tenant_id=c.tenant_id
      WHERE c.id=$1 AND c.tenant_id=$2 AND p.organization_id=$3 AND c.enabled=true AND p.enabled=true AND c.metadata->>'credential_storage'='local'`,
      [id, ctx.tenantId, ctx.organizationId],
    )
    const row = found.rows[0]
    if (!row) return apiError(404, 'not_found', '可测试的本地渠道不存在或已停用')
    const key = ctx.tenantId + ':' + id
    state.nexusChannelTests ??= new Set()
    if (state.nexusChannelTests.has(key)) return apiError(409, 'test_in_progress', '该渠道正在测试，请稍候')
    state.nexusChannelTests.add(key)
    busyId = key
    const binding = bindingForChannel(ctx.tenantId, row)
    const secret = await readLocalCredential(binding)
    const verification = await diagnoseConnection(binding, secret)
    const db = await pool.connect()
    try {
      await db.query('BEGIN')
      const updated = await db.query(
        `UPDATE channels SET metadata=jsonb_set(metadata,'{verification}',$1::jsonb),updated_at=now()
        WHERE id=$2 AND tenant_id=$3 AND enabled=true AND provider_credential_id=$4 AND metadata->>'credential_version'=$5 RETURNING id`,
        [JSON.stringify(verification), id, ctx.tenantId, binding.credential_id, String(binding.credential_version)],
      )
      if (updated.rowCount)
        await db.query(
          `UPDATE provider_credentials SET last_verified_at=$1,last_error_code=$2,updated_at=now() WHERE id=$3 AND tenant_id=$4`,
          [
            verification.ok ? verification.checkedAt : null,
            verification.ok ? null : String(verification.status),
            binding.credential_id,
            ctx.tenantId,
          ],
        )
      await db.query('COMMIT')
    } catch (e) {
      await db.query('ROLLBACK')
      throw e
    } finally {
      db.release()
    }
    await auditControlPlane(
      ctx,
      'channel.tested',
      { type: 'channel', id },
      { ok: verification.ok, status: verification.status },
    )
    return jsonOk({ verification })
  } catch (e) {
    if (e instanceof LocalCredentialError) return apiError(e.status, e.code, e.message)
    return routeError(e)
  } finally {
    if (busyId) state.nexusChannelTests?.delete(busyId)
  }
}
