import type { PoolClient } from 'pg'
import type { ControlPlaneContext } from '@/app/api/_lib/control-plane'
import { LocalCredentialError } from './local-credentials'

export async function createLocalConnection(
  db: PoolClient,
  ctx: ControlPlaneContext,
  providerId: string,
  credentialId: string,
  fingerprint: string,
) {
  const r = await db.query<{ id: string }>(
    `INSERT INTO owned_connections(tenant_id,owner_user_id,provider,mode,credential_ref,credential_fingerprint,capabilities)
    SELECT $1,$2,code,'external_endpoint',$3,$4,$5::jsonb FROM providers WHERE id=$6 RETURNING id`,
    [
      ctx.tenantId,
      ctx.session.userId,
      credentialId,
      fingerprint,
      JSON.stringify({ routing: true, execution_mode: 'byok', credential_storage: 'local' }),
      providerId,
    ],
  )
  if (!r.rows[0]) throw new LocalCredentialError('invalid_provider', '供应商不存在', 400)
  return r.rows[0].id
}

/** Link pre-existing local channels under the same locks as key mutation. */
export async function prepareLocalRouting(db: PoolClient, ctx: ControlPlaneContext, id: string) {
  const r = await db.query<{
    provider_id: string
    provider_credential_id: string
    fingerprint: string
    metadata: Record<string, unknown>
  }>(
    `SELECT c.provider_id,c.provider_credential_id,c.metadata,p.fingerprint FROM channels c
    JOIN provider_credentials p ON p.id=c.provider_credential_id AND p.tenant_id=c.tenant_id
    WHERE c.id=$1 AND c.tenant_id=$2 AND p.organization_id=$3 AND c.enabled=true AND p.enabled=true AND c.metadata->>'credential_storage'='local' FOR UPDATE OF c,p`,
    [id, ctx.tenantId, ctx.organizationId],
  )
  const row = r.rows[0]
  if (!row) throw new LocalCredentialError('not_found', '已启用的本地渠道不存在', 404)
  let connectionId = row.metadata.connection_id
  if (connectionId) {
    const found = await db.query(
      `SELECT id FROM owned_connections WHERE id=$1 AND tenant_id=$2 AND credential_ref=$3 AND revoked_at IS NULL AND mode='external_endpoint' FOR SHARE`,
      [connectionId, ctx.tenantId, row.provider_credential_id],
    )
    if (!found.rowCount) throw new LocalCredentialError('connection_unavailable', '渠道关联已失效，请重新配置渠道', 409)
  } else {
    connectionId = await createLocalConnection(db, ctx, row.provider_id, row.provider_credential_id, row.fingerprint)
    await db.query(
      `UPDATE channels SET metadata=jsonb_set(metadata,'{connection_id}',to_jsonb($1::text)),updated_at=now() WHERE id=$2 AND tenant_id=$3`,
      [connectionId, id, ctx.tenantId],
    )
  }
  return { id, connectionId, model: row.metadata.model, routingConfigured: true }
}
