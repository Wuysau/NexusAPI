import { randomUUID } from 'node:crypto'
import { pool } from '@/db'
import type { ControlPlaneContext } from '@/app/api/_lib/control-plane'
import { auditControlPlane } from '@/app/api/_lib/control-plane'
import { createLocalConnection } from './local-routing'
import {
  LocalCredentialError,
  localConnectionConfig,
  localModelIds,
  publishLocalCredential,
  readLocalCredential,
  removeLocalCredential,
  LOCAL_CREDENTIAL_FORMAT,
  LOCAL_CREDENTIAL_MODELS_FORMAT,
  type LocalCredentialBinding,
  type LocalCredentialEnvelope,
} from './local-credentials'

export async function createLocalChannel(
  ctx: ControlPlaneContext,
  input: {
    name: string
    providerId: string
    customProvider?: boolean
    secret: unknown
    baseUrl?: unknown
    protocol?: unknown
    model?: unknown
    models?: unknown
    capabilities: string[]
    weight: number
    priority: number
    region: string
  },
) {
  const models = localModelIds(input.models ?? input.model)
  const config = localConnectionConfig({ ...input, model: models[0] })
  if (typeof input.secret !== 'string') throw new LocalCredentialError('invalid_api_key', '请填写 API Key')
  const binding: LocalCredentialBinding = {
    tenant_id: ctx.tenantId,
    credential_id: randomUUID(),
    credential_version: 1,
    provider_id: input.providerId,
    base_url: config.baseUrl,
    protocol: config.protocol,
    model: config.model,
    models,
  }
  const db = await pool.connect()
  let committed = false
  let published = false
  try {
    await db.query('BEGIN')
    if (input.customProvider) {
      await db.query(
        `INSERT INTO providers(code,name,official_base_url)
         VALUES('custom','自定义','https://custom.invalid')
         ON CONFLICT(code) DO NOTHING`,
      )
      const provider = await db.query<{ id: string }>("SELECT id FROM providers WHERE code='custom' AND enabled=true")
      if (!provider.rows[0]) throw new LocalCredentialError('invalid_provider', '自定义供应商不可用', 409)
      binding.provider_id = provider.rows[0].id
    }
    const envelope = await publishLocalCredential(binding, input.secret)
    published = true
    await db.query(
      `INSERT INTO provider_credentials(id,provider_id,organization_id,tenant_id,name,encrypted_secret,fingerprint)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        binding.credential_id,
        binding.provider_id,
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
      binding.provider_id,
      binding.credential_id,
      envelope.fingerprint,
    )
    const created = await db.query<{ id: string }>(
      `INSERT INTO channels(tenant_id,provider_id,provider_credential_id,name,capabilities,region,weight,priority,metadata)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb) RETURNING id`,
      [
        ctx.tenantId,
        binding.provider_id,
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
          models,
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

/** Explicit local repair: re-enroll the saved model list without changing the API key. */
export async function upgradeLocalChannelCredentialModels(
  ctx: ControlPlaneContext,
  id: string,
  expectedVersion: number,
) {
  const conflict = () =>
    new LocalCredentialError('credential_version_conflict', '渠道密钥版本已变化，请重新检查后再升级', 409)
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion >= Number.MAX_SAFE_INTEGER)
    throw conflict()
  const db = await pool.connect()
  let next: LocalCredentialBinding | undefined
  let published = false
  let committed = false
  try {
    await db.query('BEGIN')
    const result = await db.query<{
      provider_credential_id: string
      provider_id: string
      metadata: Record<string, unknown>
      encrypted_secret: string
    }>(
      `SELECT c.provider_credential_id,c.provider_id,c.metadata,p.encrypted_secret FROM channels c
       JOIN provider_credentials p ON p.id=c.provider_credential_id AND p.tenant_id=c.tenant_id AND p.provider_id=c.provider_id
       WHERE c.id=$1 AND c.tenant_id=$2 AND p.organization_id=$3 FOR UPDATE OF c,p`,
      [id, ctx.tenantId, ctx.organizationId],
    )
    const row = result.rows[0]
    if (!row || row.metadata.credential_storage !== 'local')
      throw new LocalCredentialError('not_found', '本地渠道不存在', 404)
    const old = bindingForChannel(ctx.tenantId, row)
    if (old.credential_version !== expectedVersion) throw conflict()
    let envelope: LocalCredentialEnvelope
    try {
      envelope = JSON.parse(row.encrypted_secret) as LocalCredentialEnvelope
      if (!envelope || ![LOCAL_CREDENTIAL_FORMAT, LOCAL_CREDENTIAL_MODELS_FORMAT].includes(envelope.format))
        throw new Error()
    } catch {
      throw new LocalCredentialError('credential_unavailable', '本地加密密钥记录不一致，未执行升级', 409)
    }
    // The file must equal the locked database envelope, authenticate under the
    // existing key, and match every old identity/endpoint/primary-model field.
    const secret = await readLocalCredential(old, undefined, envelope)
    if (envelope.format === LOCAL_CREDENTIAL_MODELS_FORMAT || old.models!.length === 1) {
      await db.query('COMMIT')
      committed = true
      return { id, updated: false, version: old.credential_version }
    }
    next = { ...old, credential_version: old.credential_version + 1 }
    const upgraded = await publishLocalCredential(next, secret)
    published = true
    const credential = await db.query(
      `UPDATE provider_credentials SET encrypted_secret=$1,updated_at=now()
       WHERE id=$2 AND tenant_id=$3 AND organization_id=$4 AND encrypted_secret=$5`,
      [JSON.stringify(upgraded), old.credential_id, ctx.tenantId, ctx.organizationId, row.encrypted_secret],
    )
    const channel = await db.query(
      `UPDATE channels SET metadata=metadata || $1::jsonb,updated_at=now()
       WHERE id=$2 AND tenant_id=$3 AND metadata->>'credential_version'=$4`,
      [JSON.stringify({ credential_version: next.credential_version }), id, ctx.tenantId, String(expectedVersion)],
    )
    if (credential.rowCount !== 1 || channel.rowCount !== 1) throw conflict()
    await db.query('COMMIT')
    committed = true
    await removeLocalCredential(old)
    await auditControlPlane(
      ctx,
      'credential.models_upgraded',
      { type: 'channel', id },
      {
        credentialId: next.credential_id,
        version: next.credential_version,
        modelCount: next.models!.length,
      },
    )
    return { id, updated: true, version: next.credential_version }
  } catch (error) {
    if (!committed) {
      await db.query('ROLLBACK')
      if (published && next) await removeLocalCredential(next)
    }
    throw error
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
    models: localModelIds(m.models ?? m.model),
  }
}
