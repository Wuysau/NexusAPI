// GET /api/internal/gateway/snapshot?tenant_id=<id>
//
// Returns the signed bundle the Go data plane consumes: the latest published
// snapshot payload (Work Item D) plus everything else the hot path needs to
// route without a control-plane round trip — channels, models, the downstream
// key directory and per-tenant limits.
//
// The whole bundle is signed as one canonical JSON document with the versioned
// keyring (the same construction as src/lib/catalog/snapshot.ts, verified in Go
// by services/gateway/snapshot.go). The nested `snapshot` object keeps D's
// payload shape and schema version so the gateway can apply its N/N-1 rules to
// both layers.
//
// Keys: only sha256 digests are exported. The plaintext key never leaves the
// caller's Authorization header (INVARIANT #7), and the gateway verifies keys
// locally instead of calling back here on every request (INVARIANT #8).

import { createHmac } from 'node:crypto'
import { pool } from '@/db'
import { canonicalJson, signSnapshot, signingKeyIdFor } from '@/lib/catalog/snapshot'
import { snapshotSigningKeyring } from '@/lib/secrets/snapshot-signing'
import { localConnectionConfig, localKeyInputAllowed, localModelIds } from '@/lib/channels/local-credentials'
import { buildLocalSnapshot } from '@/lib/channels/local-snapshot'
import { internalError, normalizeTenantScope, requireGatewayToken } from '../_shared'

export const dynamic = 'force-dynamic'

/**
 * The signing keyring, built from the same env vars and with the same
 * precedence as src/lib/catalog/snapshot.ts:defaultKeyring(). It is constructed
 * here rather than via getKeyring() because that helper resolves config through
 * a CommonJS `require`, which does not resolve under the ESM test runner — the
 * same reason Work Item D built its own.
 */
const snapshotKeyring = snapshotSigningKeyring

/** How long a bundle stays valid. The gateway refreshes well inside this. */
const BUNDLE_TTL_SECONDS = Number(process.env.GATEWAY_SNAPSHOT_TTL_SECONDS ?? '120')

interface ChannelRow {
  id: string
  tenant_id: string | null
  provider_id: string
  provider_code: string
  official_base_url: string
  auth_scheme: string
  credential_id: string | null
  credential_fingerprint: string | null
  credential_tenant_id: string | null
  credential_platform_managed: boolean | null
  credential_provider_id: string | null
  credential_organization_id: string | null
  credential_org_tenant_id: string | null
  credential_enabled: boolean | null
  connection_id: string | null
  connection_tenant_id: string | null
  connection_revoked_at: Date | null
  connection_mode: string | null
  connection_provider: string | null
  connection_credential_ref: string | null
  name: string
  capabilities: string[] | null
  region: string
  weight: number
  priority: number
  metadata: Record<string, unknown> | null
  models: string[]
}

interface ModelRow {
  upstream_model_id: string
  provider_code: string
  display_name: string
  context_window: number | null
  max_output_tokens: number | null
  capabilities: string[] | null
  lifecycle_status: string
  aliases: string[] | null
  raw_metadata: Record<string, unknown> | null
}

export async function GET(req: Request): Promise<Response> {
  const denied = requireGatewayToken(req)
  if (denied) return denied

  const url = new URL(req.url)
  const tenantId = normalizeTenantScope(url.searchParams.get('tenant_id'))

  // This explicit loopback desktop profile publishes only saved owned local
  // configuration, never seed/managed prices or the shared provider catalog.
  if (localKeyInputAllowed(req)) {
    try {
      const [localChannels, keys] = await Promise.all([
        tenantId ? loadChannels(tenantId, true) : Promise.resolve([]),
        tenantId ? loadKeys(tenantId) : loadAllKeys(),
      ])
      const local = buildLocalSnapshot(tenantId, localChannels)
      const signed = signSnapshot(local.payload, snapshotKeyring())
      return signedBundleResponse(
        tenantId,
        { ...local.payload },
        signed.signature,
        signed.signingKeyId,
        local.payload.sequence_number,
        local.channels,
        local.models,
        keys,
      )
    } catch {
      return internalError(500, 'internal_error', 'Local snapshot identity validation failed.')
    }
  }

  let payload: Record<string, unknown>
  let signature: string
  let signingKeyId: string
  let sequenceNumber: number

  try {
    // Prefer the tenant's own snapshot; fall back to the platform snapshot.
    // Prices, catalogue and routing policies are platform-scoped facts (a
    // tenant override, when published, wins), while the key directory and the
    // channel list are always scoped to the requested tenant.
    const snapshot = await pool.query<{
      sequence_number: string
      signature: string
      signing_key_id: string
      payload: Record<string, unknown>
    }>(
      `SELECT sequence_number, signature, signing_key_id, payload
       FROM gateway_snapshots
       WHERE tenant_id IS NOT DISTINCT FROM $1 OR tenant_id IS NULL
       ORDER BY (tenant_id IS NOT DISTINCT FROM $1) DESC, sequence_number DESC
       LIMIT 1`,
      [tenantId],
    )
    if (!snapshot.rows.length) {
      return internalError(404, 'not_found', 'No published snapshot for this scope.')
    }
    const row = snapshot.rows[0]
    payload = row.payload
    signature = row.signature
    signingKeyId = row.signing_key_id
    sequenceNumber = Number(row.sequence_number)
  } catch {
    return internalError(500, 'internal_error', 'Snapshot lookup failed.')
  }

  let channels: unknown[], models: unknown[], keys: Array<{ revocation_epoch: number }>
  try {
    ;[channels, models, keys] = await Promise.all([
      loadChannels(tenantId),
      loadModels(),
      tenantId ? loadKeys(tenantId) : loadAllKeys(),
    ])
  } catch {
    return internalError(500, 'internal_error', 'Snapshot identity validation failed.')
  }

  return signedBundleResponse(tenantId, payload, signature, signingKeyId, sequenceNumber, channels, models, keys)
}

function signedBundleResponse(
  tenantId: string | null,
  payload: Record<string, unknown>,
  signature: string,
  signingKeyId: string,
  sequenceNumber: number,
  channels: unknown[],
  models: unknown[],
  keys: Array<{ revocation_epoch: number }>,
): Response {
  const now = new Date()
  const bundle = {
    schema_version: 1,
    kind: 'gateway_bundle',
    tenant_id: tenantId,
    sequence_number: sequenceNumber,
    generated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + BUNDLE_TTL_SECONDS * 1000).toISOString(),
    snapshot: payload,
    channels,
    models,
    keys,
    revocation_epoch: keys.reduce((max, key) => Math.max(max, key.revocation_epoch), 0),
    limits: loadLimits(),
  }

  // Sign the canonical bytes of the bundle. The gateway re-canonicalizes and
  // verifies, so property order in this response is irrelevant.
  const keyring = snapshotKeyring()
  const canonical = canonicalJson(bundle)
  const bundleSignature = createHmac('sha256', keyring.current.key).update(canonical, 'utf8').digest('hex')

  return Response.json(
    {
      bundle,
      signature: bundleSignature,
      signing_key_id: signingKeyIdFor(keyring),
      // Recorded for audit only: the snapshot payload's own signature from
      // Work Item D. The gateway verifies the bundle signature, which covers
      // this payload as a nested object.
      snapshot_signature: signature,
      snapshot_signing_key_id: signingKeyId,
      expires_at: bundle.expires_at,
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}

/** Routable channels: tenant-owned plus platform ones, enabled only. */
async function loadChannels(tenantId: string | null, localOnly = false) {
  const result = await pool.query<ChannelRow>(
    `SELECT c.id,
            c.tenant_id,
            c.provider_id,
            p.code AS provider_code,
            p.official_base_url,
            p.auth_scheme,
            c.provider_credential_id AS credential_id,
            cred.fingerprint AS credential_fingerprint,
            cred.tenant_id AS credential_tenant_id,
            cred.is_platform_managed AS credential_platform_managed,
            cred.provider_id AS credential_provider_id,
            cred.organization_id AS credential_organization_id,
            credential_org.tenant_id AS credential_org_tenant_id,
            cred.enabled AS credential_enabled,
            connection.id AS connection_id,
            connection.tenant_id AS connection_tenant_id,
            connection.revoked_at AS connection_revoked_at,
            connection.mode AS connection_mode,
            connection.provider AS connection_provider,
            connection.credential_ref AS connection_credential_ref,
            c.name,
            c.capabilities,
            c.region,
            c.weight,
            c.priority,
            c.metadata,
            ${
              localOnly
                ? 'ARRAY[]::text[]'
                : `COALESCE(
              (SELECT array_agg(DISTINCT um.upstream_model_id)
               FROM upstream_models um
               WHERE um.provider_id = c.provider_id AND um.available = true),
              ARRAY[]::text[]
            )`
            } AS models
     FROM channels c
     JOIN providers p ON p.id = c.provider_id
     LEFT JOIN provider_credentials cred ON cred.id = c.provider_credential_id
     LEFT JOIN organizations credential_org ON credential_org.id = cred.organization_id
     LEFT JOIN owned_connections connection ON connection.id = c.metadata->>'connection_id'
     WHERE c.enabled = true
       AND p.enabled = true
       AND (connection.mode IS NULL OR connection.mode <> 'subscription_interactive')
       AND (c.tenant_id IS NOT DISTINCT FROM $1 OR c.tenant_id IS NULL)
       ${localOnly ? "AND c.tenant_id = $1 AND c.metadata->>'credential_storage' = 'local'" : ''}
     ORDER BY c.priority ASC, c.weight DESC, c.id ASC`,
    [tenantId],
  )
  return result.rows
    .filter((row) => process.env.NODE_ENV !== 'production' || row.metadata?.credential_storage !== 'local')
    .map((row) => {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>
      const local =
        metadata.credential_storage === 'local'
          ? localConnectionConfig({ baseUrl: metadata.base_url, protocol: metadata.protocol, model: metadata.model })
          : null
      const localModels = local ? localModelIds(metadata.models ?? metadata.model) : null
      if (local && localModels?.[0] !== local.model) throw new Error('Invalid local channel model binding')
      if (row.credential_id) {
        const owned =
          row.credential_tenant_id !== null &&
          row.credential_tenant_id === row.tenant_id &&
          row.credential_org_tenant_id === row.tenant_id &&
          row.credential_organization_id !== null &&
          row.credential_platform_managed === false
        const managed =
          row.credential_tenant_id === null &&
          row.credential_organization_id === null &&
          row.credential_platform_managed === true
        if ((!owned && !managed) || row.credential_provider_id !== row.provider_id || !row.credential_enabled)
          throw new Error('Invalid channel credential scope')
      }
      if (Object.hasOwn(metadata, 'connection_id')) {
        if (
          typeof metadata.connection_id !== 'string' ||
          !metadata.connection_id.trim() ||
          !row.connection_id ||
          row.connection_tenant_id !== row.tenant_id ||
          row.connection_revoked_at !== null
        )
          throw new Error('Invalid channel connection scope')
      }
      // BYOK vs managed is a property of the credential, never of the channel
      // name: a tenant-owned credential is BYOK, a platform one is managed.
      // INVARIANT #13 — the two must stay distinguishable everywhere.
      const credentialMode = row.credential_id ? (row.credential_tenant_id ? 'byok' : 'managed') : 'managed'
      if (
        localOnly &&
        (!local ||
          credentialMode !== 'byok' ||
          !row.connection_id ||
          row.connection_mode !== 'external_endpoint' ||
          row.connection_provider !== row.provider_code ||
          row.connection_credential_ref !== row.credential_id)
      )
        throw new Error('Invalid local channel binding')
      return {
        ...(localOnly ? { tenant_id: row.tenant_id } : {}),
        id: row.id,
        provider_id: row.provider_id,
        provider: row.provider_code,
        base_url: local?.baseUrl ?? row.official_base_url,
        ...(local ? { protocol: local.protocol } : {}),
        auth_scheme: local
          ? local.protocol === 'anthropic'
            ? 'x_api_key'
            : 'bearer'
          : row.auth_scheme === 'x-api-key'
            ? 'x_api_key'
            : row.auth_scheme,
        models: localModels ?? row.models ?? [],
        region: row.region,
        data_residency: typeof metadata.data_residency === 'string' ? metadata.data_residency : row.region,
        credential_mode: credentialMode,
        credential_ref: row.credential_id ?? '',
        connection_id: row.connection_id,
        ...(typeof metadata.credential_version === 'number' &&
        Number.isSafeInteger(metadata.credential_version) &&
        metadata.credential_version > 0
          ? { credential_version: metadata.credential_version }
          : {}),
        credential_fingerprint: row.credential_fingerprint ?? '',
        weight: row.weight,
        priority: row.priority,
        capabilities: row.capabilities ?? [],
        enabled: true,
      }
    })
}

/** Published models plus their aliases. */
async function loadModels(): Promise<unknown[]> {
  const result = await pool.query<ModelRow>(
    `SELECT um.upstream_model_id,
            p.code AS provider_code,
            um.display_name,
            um.context_window,
            um.max_output_tokens,
            um.capabilities,
            um.lifecycle_status,
            um.raw_metadata,
            COALESCE(
              (SELECT array_agg(ma.alias ORDER BY ma.priority ASC)
               FROM model_aliases ma
               WHERE ma.provider_id = um.provider_id
                 AND ma.upstream_model_id = um.upstream_model_id
                 AND ma.enabled = true),
              ARRAY[]::text[]
            ) AS aliases
     FROM upstream_models um
     JOIN providers p ON p.id = um.provider_id
     WHERE um.lifecycle_status IN ('active', 'deprecated')
     ORDER BY um.upstream_model_id ASC`,
  )
  return result.rows.map((row) => ({
    id: row.upstream_model_id,
    provider: row.provider_code,
    aliases: row.aliases ?? [],
    capabilities: row.capabilities ?? [],
    context_window: row.context_window ?? 0,
    max_output_tokens: row.max_output_tokens ?? 0,
    // A published model is licensed by the act of publication; raw metadata may
    // name the licence explicitly. An EMPTY value would mean "not cleared" and
    // the gateway hard-filters on it, so the default is the provider terms.
    license: licenseOf(row),
    status: row.lifecycle_status,
    display_name: row.display_name,
  }))
}

function licenseOf(row: ModelRow): string {
  const metadata = (row.raw_metadata ?? {}) as Record<string, unknown>
  const license = metadata.license
  return typeof license === 'string' && license.trim() ? license.trim() : 'provider-terms'
}

interface KeyRow {
  id: string
  tenant_id: string
  organization_id: string
  hash: string
  fingerprint: string | null
  scopes: string[] | null
  enabled: boolean
  expires_at: Date | null
  revoked_at: Date | null
  project_id: string | null
  project_name: string | null
  project_tenant_id: string | null
  project_organization_id: string | null
  project_status: string | null
  project_archived_at: Date | null
  org_tenant_id: string | null
  org_deleted_at: Date | null
}

function mapKey(row: KeyRow): { revocation_epoch: number } & Record<string, unknown> {
  if (
    row.org_tenant_id !== row.tenant_id ||
    (row.project_tenant_id !== null &&
      (row.project_tenant_id !== row.tenant_id || row.project_organization_id !== row.organization_id))
  )
    throw new Error('Invalid key organization or project scope')
  const projectKnown =
    row.project_id !== null &&
    row.project_tenant_id !== null &&
    row.project_status === 'active' &&
    row.project_archived_at === null
  const attributionStatus = row.project_id === null ? 'unattributed' : projectKnown ? 'attributed' : 'unknown'
  return {
    key_id: row.id,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    hash_sha256: row.hash,
    scopes: row.scopes ?? [],
    enabled: row.enabled && attributionStatus !== 'unknown' && row.org_deleted_at === null,
    project_id: projectKnown ? row.project_id : null,
    project_name: projectKnown ? row.project_name : null,
    key_kind: 'shared',
    principal_id: null,
    attribution_status: attributionStatus,
    expires_at: row.expires_at ? row.expires_at.toISOString() : null,
    revoked_at: row.revoked_at ? row.revoked_at.toISOString() : null,
    fingerprint: row.fingerprint ?? '',
    revocation_epoch: row.revoked_at ? row.revoked_at.getTime() : 0,
  }
}

const keyDirectoryQuery = `SELECT k.id, k.tenant_id, k.organization_id, k.hash, k.fingerprint, k.scopes,
  k.enabled, k.expires_at, k.revoked_at, k.project_id,
  p.name AS project_name, p.tenant_id AS project_tenant_id, p.organization_id AS project_organization_id,
  p.status AS project_status, p.archived_at AS project_archived_at,
  o.tenant_id AS org_tenant_id, o.deleted_at AS org_deleted_at
  FROM downstream_api_keys k
  LEFT JOIN organizations o ON o.id=k.organization_id
  LEFT JOIN projects p ON p.id=k.project_id`

/** The tenant's key directory. */
async function loadKeys(tenantId: string): Promise<Array<{ revocation_epoch: number }>> {
  const result = await pool.query<KeyRow>(
    `${keyDirectoryQuery}
     WHERE k.tenant_id = $1 AND k.deleted_at IS NULL
     ORDER BY k.created_at ASC`,
    [tenantId],
  )
  return result.rows.map(mapKey)
}

/**
 * The platform key directory: every tenant's keys in one signed document, so
 * the gateway can resolve a presented key to a tenant before it knows which
 * tenant to ask about. Revoked keys are included so the gateway can answer
 * "revoked" rather than "unknown".
 */
async function loadAllKeys(): Promise<Array<{ revocation_epoch: number }>> {
  const result = await pool.query<KeyRow>(
    `${keyDirectoryQuery}
     WHERE k.deleted_at IS NULL
     ORDER BY k.created_at ASC
     LIMIT 50000`,
  )
  return result.rows.map(mapKey)
}

/** Per-tenant limit overrides. Zero/absent means "use the system cap". */
function loadLimits(): Record<string, number | boolean> {
  const parse = (name: string): number => {
    const n = Number(process.env[name] ?? '0')
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
  return {
    requests_per_minute: parse('GATEWAY_TENANT_REQUESTS_PER_MINUTE'),
    tokens_per_minute: parse('GATEWAY_TENANT_TOKENS_PER_MINUTE'),
    max_concurrent: parse('GATEWAY_TENANT_MAX_CONCURRENT'),
    byok_continue_when_stale: process.env.GATEWAY_BYOK_CONTINUE_WHEN_STALE === 'true',
  }
}

// Exported for the integration test only.
export const __test = { loadChannels, loadModels }
