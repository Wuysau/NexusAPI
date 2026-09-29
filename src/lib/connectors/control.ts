import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from '@/db'
import { AuthzError } from '@/lib/auth/capabilities'
import type { ControlPlaneContext } from '@/app/api/_lib/control-plane'
import { connectionVisibility, workspaceParams } from '@/lib/workspace/management'

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
const secret = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`
const denied = () => new AuthzError('connector_unauthorized', '连接器凭据、租约或授权无效', 401)
export function modelIDs(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 64 ||
    value.some((v) => typeof v !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(v))
  )
    throw new AuthzError('invalid_models', '请配置 1–64 个有效模型 ID', 400)
  return [...new Set(value as string[])]
}
export function bearer(req: Request): string {
  const token = req.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{20,160})$/)?.[1]
  if (!token) throw denied()
  return token
}
export async function transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect()
  try {
    await db.query('BEGIN')
    const value = await fn(db)
    await db.query('COMMIT')
    return value
  } catch (e) {
    await db.query('ROLLBACK')
    throw e
  } finally {
    db.release()
  }
}

/** Re-pairing is also administrative rotation: old identity and leases stop immediately. */
export async function configureConnector(ctx: ControlPlaneContext, id: string, modelsInput: unknown) {
  if (!['owner', 'admin'].includes(ctx.membership.role)) throw new AuthzError('forbidden', '需要管理员权限', 403)
  const models = modelIDs(modelsInput)
  const token = secret('nxpair_')
  const result = await transaction(async (db) => {
    const connection = (
      await db.query(
        `SELECT c.id,c.project_id FROM owned_connections c WHERE ${connectionVisibility}
       AND c.id=$5 AND c.mode='local_sidecar' AND c.provider='ollama' AND c.revoked_at IS NULL FOR UPDATE OF c`,
        [...workspaceParams(ctx), id],
      )
    ).rows[0]
    if (!connection) throw new AuthzError('not_found', 'Ollama 本地连接不存在', 404)
    const project = (
      await db.query(
        `SELECT id FROM projects WHERE id=$1 AND tenant_id=$2 AND organization_id=$3
      AND status='active' AND archived_at IS NULL FOR SHARE`,
        [connection.project_id, ctx.tenantId, ctx.organizationId],
      )
    ).rows[0]
    if (!project) throw new AuthzError('invalid_project', '请先绑定当前组织的有效项目', 400)
    await db.query(
      `INSERT INTO providers(code,name,official_base_url) VALUES('ollama','Ollama connector','https://connector.invalid/v1') ON CONFLICT(code) DO NOTHING`,
    )
    const provider = (await db.query(`SELECT id FROM providers WHERE code='ollama' AND enabled=true`)).rows[0]
    if (!provider) throw new AuthzError('invalid_provider', 'Ollama 供应商未启用', 409)
    let channel = (
      await db.query(
        `SELECT id,provider_credential_id FROM channels WHERE tenant_id=$1 AND metadata->>'connection_id'=$2 AND metadata->>'transport'='local_sidecar' FOR UPDATE`,
        [ctx.tenantId, id],
      )
    ).rows[0]
    if (!channel) {
      const credentialId = randomUUID()
      // Opaque accounting identity only. No upstream or connector secret lives here.
      await db.query(
        `INSERT INTO provider_credentials(id,provider_id,organization_id,tenant_id,name,encrypted_secret,fingerprint)
        VALUES($1,$2,$3,$4,'Connector local upstream','{"format":"connector-local-only-v1"}',$5)`,
        [credentialId, provider.id, ctx.organizationId, ctx.tenantId, tokenHash(credentialId)],
      )
      channel = (
        await db.query(
          `INSERT INTO channels(tenant_id,provider_id,provider_credential_id,name,capabilities,metadata)
        VALUES($1,$2,$3,'Ollama local connector','["text","streaming"]',$4::jsonb) RETURNING id,provider_credential_id`,
          [
            ctx.tenantId,
            provider.id,
            credentialId,
            JSON.stringify({ connection_id: id, transport: 'local_sidecar', models }),
          ],
        )
      ).rows[0]
    }
    await db.query(
      `UPDATE channels SET enabled=true,metadata=metadata || $3::jsonb,updated_at=now() WHERE id=$1 AND tenant_id=$2`,
      [channel.id, ctx.tenantId, JSON.stringify({ models, protocol: 'openai' })],
    )
    await db.query(`UPDATE connector_identities SET revoked_at=now() WHERE connection_id=$1 AND tenant_id=$2`, [
      id,
      ctx.tenantId,
    ])
    await db.query(
      `UPDATE connector_leases SET revoked_at=now(),transport_seen_at=NULL WHERE connection_id=$1 AND tenant_id=$2`,
      [id, ctx.tenantId],
    )
    await db.query(
      `UPDATE owned_connections SET status='pending',last_heartbeat_at=NULL,capabilities=$3::jsonb,updated_at=now() WHERE id=$1 AND tenant_id=$2`,
      [id, ctx.tenantId, JSON.stringify({ routing: true, execution_mode: 'byok', transport: 'local_sidecar', models })],
    )
    const row = (
      await db.query(
        `INSERT INTO connector_pairings(connection_id,tenant_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')
      ON CONFLICT(connection_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,consumed_at=NULL RETURNING expires_at`,
        [id, ctx.tenantId, tokenHash(token)],
      )
    ).rows[0]
    return { channelId: channel.id, expiresAt: row.expires_at }
  })
  return { ...result, pairingToken: token, connectionId: id, models }
}

export async function pairConnector(token: string) {
  if (!/^nxpair_[A-Za-z0-9_-]{43}$/.test(token)) throw denied()
  const credential = secret('nxidentity_')
  return transaction(async (db) => {
    const pair = (
      await db.query(
        `SELECT p.connection_id,p.tenant_id FROM connector_pairings p
      JOIN owned_connections c ON c.id=p.connection_id AND c.tenant_id=p.tenant_id
      WHERE p.token_hash=$1 AND p.consumed_at IS NULL AND p.expires_at>now() AND c.mode='local_sidecar' AND c.revoked_at IS NULL
      FOR UPDATE OF c,p`,
        [tokenHash(token)],
      )
    ).rows[0]
    if (!pair) throw denied()
    await db.query(`UPDATE connector_pairings SET consumed_at=now() WHERE connection_id=$1`, [pair.connection_id])
    // Keep the identity ID stable for FK history; rotating the hash kills old credentials.
    const identity = (
      await db.query(
        `INSERT INTO connector_identities(connection_id,tenant_id,credential_hash) VALUES($1,$2,$3)
      ON CONFLICT(connection_id) DO UPDATE SET credential_hash=excluded.credential_hash,revoked_at=NULL RETURNING id`,
        [pair.connection_id, pair.tenant_id, tokenHash(credential)],
      )
    ).rows[0]
    return { connectorId: identity.id, connectionId: pair.connection_id, tenantId: pair.tenant_id, credential }
  })
}

export async function renewLease(credential: string, input: { leaseToken?: unknown; readyModels?: unknown }) {
  const ready =
    input.readyModels === undefined || (Array.isArray(input.readyModels) && input.readyModels.length === 0)
      ? []
      : modelIDs(input.readyModels)
  return transaction(async (db) => {
    const identity = (
      await db.query(
        `SELECT i.id,i.tenant_id,i.connection_id,c.capabilities FROM connector_identities i
      JOIN owned_connections c ON c.id=i.connection_id AND c.tenant_id=i.tenant_id
      JOIN projects p ON p.id=c.project_id AND p.tenant_id=c.tenant_id
      JOIN organizations o ON o.id=p.organization_id AND o.tenant_id=p.tenant_id
      WHERE i.credential_hash=$1 AND i.revoked_at IS NULL AND c.mode='local_sidecar' AND c.revoked_at IS NULL
      AND p.status='active' AND p.archived_at IS NULL AND o.status='active' AND o.deleted_at IS NULL FOR UPDATE OF c,i`,
        [tokenHash(credential)],
      )
    ).rows[0]
    if (!identity) throw denied()
    const approved = modelIDs(identity.capabilities.models)
    const models = ready.filter((v) => approved.includes(v))
    const old = (
      await db.query(
        `SELECT lease_token_hash,expires_at,revoked_at FROM connector_leases WHERE connection_id=$1 FOR UPDATE`,
        [identity.connection_id],
      )
    ).rows[0]
    const reuse =
      typeof input.leaseToken === 'string' &&
      old &&
      !old.revoked_at &&
      new Date(old.expires_at).getTime() > Date.now() &&
      old.lease_token_hash === tokenHash(input.leaseToken)
    const leaseToken = reuse ? (input.leaseToken as string) : secret('nxlease_')
    const lease = (
      await db.query(
        `INSERT INTO connector_leases(tenant_id,connection_id,connector_id,lease_token_hash,expires_at,last_heartbeat_at,ready_models)
      VALUES($1,$2,$3,$4,now()+interval '90 seconds',now(),$5::jsonb)
      ON CONFLICT(connection_id) DO UPDATE SET connector_id=excluded.connector_id,lease_token_hash=excluded.lease_token_hash,
      expires_at=excluded.expires_at,last_heartbeat_at=now(),ready_models=excluded.ready_models,revoked_at=NULL,
      transport_seen_at=CASE WHEN connector_leases.lease_token_hash=excluded.lease_token_hash THEN connector_leases.transport_seen_at ELSE NULL END
      RETURNING id,expires_at`,
        [identity.tenant_id, identity.connection_id, identity.id, tokenHash(leaseToken), JSON.stringify(models)],
      )
    ).rows[0]
    await db.query(`UPDATE owned_connections SET last_heartbeat_at=now(),updated_at=now() WHERE id=$1`, [
      identity.connection_id,
    ])
    return {
      leaseToken,
      leaseId: lease.id,
      connectorId: identity.id,
      connectionId: identity.connection_id,
      tenantId: identity.tenant_id,
      expiresAt: lease.expires_at,
      models,
    }
  })
}

export interface ConnectorAuthorization {
  leaseToken: string
  tenantId?: string
  connectionId?: string
  channelId?: string
  projectId?: string
  organizationId?: string
  keyId?: string
  model?: string
  scope?: string
  transport?: boolean
}
/** Metadata-only live authorization; prompts and provider secrets never enter Control Plane. */
export async function authorizeConnector(input: ConnectorAuthorization) {
  if (typeof input.leaseToken !== 'string') throw denied()
  const row = (
    await pool.query(
      `SELECT l.id lease_id,l.connector_id,l.connection_id,l.tenant_id,l.expires_at,l.ready_models,c.project_id,p.organization_id
    FROM connector_leases l JOIN connector_identities i ON i.id=l.connector_id AND i.connection_id=l.connection_id AND i.tenant_id=l.tenant_id
    JOIN owned_connections c ON c.id=l.connection_id AND c.tenant_id=l.tenant_id
    JOIN projects p ON p.id=c.project_id AND p.tenant_id=c.tenant_id
    JOIN organizations o ON o.id=p.organization_id AND o.tenant_id=p.tenant_id
    WHERE l.lease_token_hash=$1 AND l.revoked_at IS NULL AND l.expires_at>now() AND i.revoked_at IS NULL
    AND c.mode='local_sidecar' AND c.revoked_at IS NULL AND p.status='active' AND p.archived_at IS NULL
    AND o.status='active' AND o.deleted_at IS NULL`,
      [tokenHash(input.leaseToken)],
    )
  ).rows[0]
  if (!row) throw denied()
  if (input.channelId !== undefined) {
    if (
      input.tenantId !== row.tenant_id ||
      input.connectionId !== row.connection_id ||
      input.projectId !== row.project_id ||
      input.organizationId !== row.organization_id ||
      typeof input.model !== 'string' ||
      !row.ready_models.includes(input.model) ||
      !['chat:write', 'models:read'].includes(input.scope ?? '')
    )
      throw denied()
    const allowed = await pool.query(
      `SELECT ch.id FROM channels ch
      JOIN provider_credentials pc ON pc.id=ch.provider_credential_id AND pc.tenant_id=ch.tenant_id AND pc.provider_id=ch.provider_id
      JOIN providers provider ON provider.id=ch.provider_id AND provider.enabled=true
      JOIN downstream_api_keys k ON k.id=$4 AND k.tenant_id=ch.tenant_id AND k.organization_id=$5 AND k.project_id=$6
      WHERE ch.id=$1 AND ch.tenant_id=$2 AND ch.enabled=true AND ch.metadata->>'connection_id'=$3 AND ch.metadata->>'transport'='local_sidecar'
      AND ch.metadata->'models' ? $7 AND pc.enabled=true AND pc.organization_id=$5
      AND k.enabled=true AND k.revoked_at IS NULL AND k.deleted_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())
      AND (k.scopes ? '*' OR k.scopes ? $8)`,
      [
        input.channelId,
        row.tenant_id,
        row.connection_id,
        input.keyId,
        row.organization_id,
        row.project_id,
        input.model,
        input.scope,
      ],
    )
    if (!allowed.rowCount) throw denied()
  }
  if (input.transport)
    await pool.query(`UPDATE connector_leases SET transport_seen_at=now() WHERE id=$1 AND lease_token_hash=$2`, [
      row.lease_id,
      tokenHash(input.leaseToken),
    ])
  return {
    leaseId: row.lease_id,
    connectorId: row.connector_id,
    connectionId: row.connection_id,
    tenantId: row.tenant_id,
    expiresAt: row.expires_at,
    models: row.ready_models,
  }
}

export async function connectorState(ctx: ControlPlaneContext, id: string) {
  const row = (
    await pool.query(
      `SELECT c.id,c.revoked_at,c.project_id,c.capabilities->'models' models,
    l.expires_at,l.last_heartbeat_at,l.transport_seen_at,l.ready_models,l.revoked_at lease_revoked_at,i.revoked_at identity_revoked_at,
    p.status project_status,p.archived_at project_archived_at,
    EXISTS(SELECT 1 FROM channels ch WHERE ch.tenant_id=c.tenant_id AND ch.metadata->>'connection_id'=c.id AND ch.enabled=true) channel_enabled
    FROM owned_connections c LEFT JOIN connector_leases l ON l.connection_id=c.id AND l.tenant_id=c.tenant_id
    LEFT JOIN connector_identities i ON i.id=l.connector_id
    LEFT JOIN projects p ON p.id=c.project_id AND p.tenant_id=c.tenant_id
    WHERE ${connectionVisibility} AND c.id=$5 AND c.mode='local_sidecar'`,
      [...workspaceParams(ctx), id],
    )
  ).rows[0]
  if (!row) throw new AuthzError('not_found', '本地连接不存在', 404)
  const active =
    row.expires_at &&
    new Date(row.expires_at).getTime() > Date.now() &&
    !row.lease_revoked_at &&
    !row.identity_revoked_at
  const online = active && row.transport_seen_at && new Date(row.transport_seen_at).getTime() > Date.now() - 35_000
  return {
    connectionId: id,
    models: row.models ?? [],
    readyModels:
      online && row.channel_enabled && row.project_status === 'active' && !row.project_archived_at && !row.revoked_at
        ? row.ready_models
        : [],
    state: row.revoked_at
      ? 'revoked'
      : !row.expires_at
        ? 'registered'
        : !active
          ? 'expired'
          : online
            ? 'online'
            : 'offline',
    leaseExpiresAt: row.expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    transportSeenAt: row.transport_seen_at,
  }
}
