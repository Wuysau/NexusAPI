import { randomUUID } from 'node:crypto'
import { pool } from '@/db'
import type { ControlPlaneContext } from '@/app/api/_lib/control-plane'
import { auditControlPlane } from '@/app/api/_lib/control-plane'
import { createLocalConnection } from './local-routing'
import {
  LocalCredentialError,
  localConnectionConfig,
  publishLocalCredential,
  removeLocalCredential,
  type LocalCredentialBinding,
} from './local-credentials'

export async function createLocalChannel(
  ctx: ControlPlaneContext,
  input: {
    name: string
    providerId: string
    secret: unknown
    baseUrl?: unknown
    protocol?: unknown
    model?: unknown
    capabilities: string[]
    weight: number
    priority: number
    region: string
  },
) {
  const config = localConnectionConfig(input)
  if (typeof input.secret !== 'string') throw new LocalCredentialError('invalid_api_key', '请填写 API Key')
  const binding: LocalCredentialBinding = {
    tenant_id: ctx.tenantId,
    credential_id: randomUUID(),
    credential_version: 1,
    provider_id: input.providerId,
    base_url: config.baseUrl,
    protocol: config.protocol,
    model: config.model,
  }
  const db = await pool.connect()
  let committed = false
  let published = false
  try {
    await db.query('BEGIN')
    const envelope = await publishLocalCredential(binding, input.secret)
    published = true
    await db.query(
      `INSERT INTO provider_credentials(id,provider_id,organization_id,tenant_id,name,encrypted_secret,fingerprint)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        binding.credential_id,
        input.providerId,
        ctx.organizationId,
        ctx.tenantId,
        `${input.name} API Key`,
        JSON.stringify(envelope),
        envelope.fingerprint,
      ],
    )
    const connectionId = await createLocalConnection(
      db,
      ctx,
      input.providerId,
      binding.credential_id,
      envelope.fingerprint,
    )
    const created = await db.query<{ id: string }>(
      `INSERT INTO channels(tenant_id,provider_id,provider_credential_id,name,capabilities,region,weight,priority,metadata)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb) RETURNING id`,
      [
        ctx.tenantId,
        input.providerId,
        binding.credential_id,
        input.name,
        JSON.stringify(input.capabilities),
        input.region,
        input.weight,
        input.priority,
        JSON.stringify({
          credential_storage: 'local',
          credential_version: 1,
          base_url: config.baseUrl,
          protocol: config.protocol,
          model: config.model,
          connection_id: connectionId,
        }),
      ],
    )
    await db.query('COMMIT')
    committed = true
    await auditControlPlane(
      ctx,
      'channel.created',
      { type: 'channel', id: created.rows[0].id },
      { credentialId: binding.credential_id, storage: 'local', protocol: config.protocol },
    )
    return { id: created.rows[0].id, created: true }
  } catch (e) {
    if (!committed) {
      await db.query('ROLLBACK')
      if (published) await removeLocalCredential(binding)
    }
    throw e
  } finally {
    db.release()
  }
}

export async function replaceLocalKey(ctx: ControlPlaneContext, id: string, secret: unknown) {
  if (typeof secret !== 'string') throw new LocalCredentialError('invalid_api_key', '请填写新的 API Key')
  const db = await pool.connect()
  let next: LocalCredentialBinding | undefined
  let committed = false
  let published = false
  try {
    await db.query('BEGIN')
    const r = await db.query<{
      provider_credential_id: string
      provider_id: string
      metadata: Record<string, unknown>
    }>(
      `SELECT c.provider_credential_id,c.provider_id,c.metadata FROM channels c
      JOIN provider_credentials p ON p.id=c.provider_credential_id AND p.tenant_id=c.tenant_id
      WHERE c.id=$1 AND c.tenant_id=$2 AND p.organization_id=$3 FOR UPDATE OF c,p`,
      [id, ctx.tenantId, ctx.organizationId],
    )
    const row = r.rows[0]
    if (!row || row.metadata.credential_storage !== 'local')
      throw new LocalCredentialError('not_found', '本地渠道不存在', 404)
    const old = bindingForChannel(ctx.tenantId, row)
    next = { ...old, credential_version: old.credential_version + 1 }
    const envelope = await publishLocalCredential(next, secret)
    published = true
    await db.query(
      `UPDATE provider_credentials SET encrypted_secret=$1,fingerprint=$2,enabled=true,last_verified_at=NULL,last_error_code=NULL,updated_at=now() WHERE id=$3 AND tenant_id=$4`,
      [JSON.stringify(envelope), envelope.fingerprint, old.credential_id, ctx.tenantId],
    )
    await db.query(
      `UPDATE channels SET metadata=(metadata-'verification') || $1::jsonb,updated_at=now() WHERE id=$2 AND tenant_id=$3`,
      [JSON.stringify({ credential_version: next.credential_version }), id, ctx.tenantId],
    )
    await db.query('COMMIT')
    committed = true
    await removeLocalCredential(old)
    await auditControlPlane(
      ctx,
      'credential.rotated',
      { type: 'channel', id },
      { credentialId: next.credential_id, version: next.credential_version },
    )
    return { id, updated: true }
  } catch (e) {
    if (!committed) {
      await db.query('ROLLBACK')
      if (published && next) await removeLocalCredential(next)
    }
    throw e
  } finally {
    db.release()
  }
}

export async function revokeLocalChannel(ctx: ControlPlaneContext, id: string) {
  const db = await pool.connect()
  try {
    await db.query('BEGIN')
    const r = await db.query(
      `SELECT c.provider_id,c.provider_credential_id,c.metadata FROM channels c
      JOIN provider_credentials p ON p.id=c.provider_credential_id AND p.tenant_id=c.tenant_id
      WHERE c.id=$1 AND c.tenant_id=$2 AND p.organization_id=$3 AND c.metadata->>'credential_storage'='local' FOR UPDATE OF c,p`,
      [id, ctx.tenantId, ctx.organizationId],
    )
    const row = r.rows[0]
    if (!row) throw new LocalCredentialError('not_found', '本地渠道不存在', 404)
    await removeLocalCredential(bindingForChannel(ctx.tenantId, row))
    await db.query('UPDATE provider_credentials SET enabled=false,updated_at=now() WHERE id=$1 AND tenant_id=$2', [
      row.provider_credential_id,
      ctx.tenantId,
    ])
    await db.query('UPDATE channels SET enabled=false,updated_at=now() WHERE id=$1 AND tenant_id=$2', [
      id,
      ctx.tenantId,
    ])
    await db.query('COMMIT')
    await auditControlPlane(
      ctx,
      'channel.disabled',
      { type: 'channel', id },
      { credentialId: row.provider_credential_id },
    )
    return { id, disabled: true }
  } catch (e) {
    await db.query('ROLLBACK')
    throw e
  } finally {
    db.release()
  }
}

export function bindingForChannel(
  tenantId: string,
  row: { provider_credential_id: string; provider_id: string; metadata: Record<string, unknown> },
): LocalCredentialBinding {
  const m = row.metadata
  return {
    tenant_id: tenantId,
    credential_id: row.provider_credential_id,
    credential_version: Number(m.credential_version),
    provider_id: row.provider_id,
    base_url: String(m.base_url),
    protocol: m.protocol as 'openai' | 'anthropic',
    model: String(m.model),
  }
}
