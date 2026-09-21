// Legacy development fixture encryption and opaque credential lifecycle helpers.
// ADR-0009: Next never enrolls plaintext and no role string authorizes unwrap.
// Production provider crypto lives only in the independent operator/Gateway
// workloads. Local helpers cannot run in production, even with historical flags.
// Keep existing ciphertext intact for a separately authorized migration.

import { randomBytes } from 'crypto'
import { pool } from '@/db'
import { buildKeyring, decrypt as aesDecrypt, encrypt as aesEncrypt, sha256hex } from '@/lib/crypto'
import type { Keyring } from '@/lib/crypto'
import { env } from '@/lib/config'
import { safeLogAudit, AUDIT_ACTIONS } from '@/lib/audit'

// ── Workload identity ─────────────────────────────────────────────────

export type WorkloadIdentity = 'gateway' | 'control-plane' | 'worker' | 'system'

const DEFAULT_UNWRAP_WORKLOADS: readonly WorkloadIdentity[] = []

/** No in-process identity assertion grants Control Plane decrypt access. */
export function allowedUnwrapWorkloads(): ReadonlySet<string> {
  return new Set(DEFAULT_UNWRAP_WORKLOADS)
}

// ── Errors ────────────────────────────────────────────────────────────

export type KmsErrorCode =
  | 'kms_local_in_production'
  | 'kms_not_implemented'
  | 'kms_key_version_mismatch'
  | 'kms_decrypt_failed'
  | 'kms_encrypt_failed'
  | 'workload_not_permitted'
  | 'credential_not_found'
  | 'credential_disabled'
  | 'fingerprint_mismatch'

export class KmsError extends Error {
  readonly code: KmsErrorCode
  readonly status: number

  constructor(code: KmsErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'KmsError'
    this.code = code
    this.status = status ?? (code === 'credential_not_found' ? 404 : code === 'workload_not_permitted' ? 403 : 500)
  }
}

// ── KMS interface ─────────────────────────────────────────────────────

export interface KmsEncryptResult {
  encryptedDataKey: string
  keyVersion: number
}

export interface KmsClient {
  readonly provider: string
  /** Wrap a plaintext DEK. */
  encryptDataKey(dataKey: Buffer): Promise<KmsEncryptResult>
  /** Unwrap a DEK for an explicit key version. Must throw on any mismatch. */
  decryptDataKey(encryptedDataKey: string, keyVersion: number): Promise<Buffer>
}

export interface KmsResolutionOptions {
  provider?: string
  isProduction?: boolean
  /** Feature flags already loaded from feature_flags; skips the DB read. */
  featureFlags?: ReadonlySet<string>
  masterKey?: string
  keyVersion?: number
}

export type KmsProviderFactory = (config: { masterKey?: string; keyVersion: number }) => KmsClient

const kmsProviderRegistry = new Map<string, KmsProviderFactory>()

/**
 * Register a real KMS implementation (AWS/GCP/Vault adapter). Work Item E/I or
 * a deployment-specific module calls this, then sets KMS_PROVIDER + enables
 * the matching feature flag.
 */
export function registerKmsProvider(name: string, factory: KmsProviderFactory): void {
  if (!name || name === 'local') throw new Error('registerKmsProvider: a non-local provider name is required')
  kmsProviderRegistry.set(name, factory)
}

/** Test-only reset of the registry. */
export function __resetKmsRegistryForTests(): void {
  kmsProviderRegistry.clear()
}

const KMS_PROVIDER_FEATURE_FLAG: Record<string, string> = {
  aws: 'kms.aws.enabled',
  gcp: 'kms.gcp.enabled',
  vault: 'kms.vault.enabled',
}

/** Read enabled feature flags. Fail-closed: on any error the set is empty. */
export async function loadEnabledFeatureFlags(): Promise<Set<string>> {
  try {
    const result = await pool.query(`SELECT key FROM feature_flags WHERE enabled = true`)
    return new Set(result.rows.map((r) => r.key as string))
  } catch {
    return new Set()
  }
}

function assertLocalDevelopment(): void {
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? 'development')) {
    throw new KmsError(
      'kms_local_in_production',
      'Local credential helpers are restricted to development fixtures; production uses independent operator enrollment',
    )
  }
}

// ── LocalKms (DEV ONLY) ───────────────────────────────────────────────

/** Deterministic key material per KMS key version, derived via crypto.ts. */
function kmsKeyringForVersion(master: string, version: number): Keyring {
  const derived = buildKeyring({ upstreamEncryptionKey: `${master}|nexus-kms|v${version}` })
  return { current: { version, key: derived.current.key } }
}

function embeddedVersion(payload: string): number | null {
  const head = payload.split(':', 1)[0]
  if (!/^v\d+$/.test(head)) return null
  return Number(head.slice(1))
}

/** Development fixture helper only; production has no flag or environment exception. */
export class LocalKms implements KmsClient {
  readonly provider = 'local'
  private readonly masterKey: string
  private readonly version: number

  constructor(masterKey: string, version = 1) {
    assertLocalDevelopment()
    this.masterKey = masterKey || 'local-development-only-key-DO-NOT-USE-IN-PROD'
    this.version = version
  }

  async encryptDataKey(dataKey: Buffer): Promise<KmsEncryptResult> {
    assertLocalDevelopment()
    if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) {
      throw new KmsError('kms_encrypt_failed', 'data key must be 32 bytes')
    }
    try {
      const encryptedDataKey = aesEncrypt(dataKey.toString('hex'), kmsKeyringForVersion(this.masterKey, this.version))
      return { encryptedDataKey, keyVersion: this.version }
    } catch {
      throw new KmsError('kms_encrypt_failed', 'failed to wrap data key')
    }
  }

  async decryptDataKey(encryptedDataKey: string, keyVersion: number): Promise<Buffer> {
    assertLocalDevelopment()
    const embedded = embeddedVersion(encryptedDataKey)
    // Fail closed on an explicit mismatch instead of trusting the payload.
    if (embedded === null || embedded !== keyVersion) {
      throw new KmsError('kms_key_version_mismatch', `kms key version mismatch (requested ${keyVersion})`)
    }
    try {
      const hex = aesDecrypt(encryptedDataKey, kmsKeyringForVersion(this.masterKey, keyVersion))
      return Buffer.from(hex, 'hex')
    } catch {
      throw new KmsError('kms_decrypt_failed', `failed to unwrap data key for version ${keyVersion}`)
    }
  }
}

/**
 * Resolve the KMS client from explicit options, env and the `feature_flags`
 * table. Never falls back to a weaker provider.
 */
export async function resolveKmsClient(opts: KmsResolutionOptions = {}): Promise<KmsClient> {
  if (process.env.NODE_ENV === 'production') {
    throw new KmsError('kms_local_in_production', 'Control Plane cryptography is unavailable in production')
  }
  let kmsProvider = opts.provider ?? process.env.KMS_PROVIDER
  let isProduction = opts.isProduction
  let keyVersion = opts.keyVersion
  let masterKey = opts.masterKey

  try {
    const e = env()
    kmsProvider = kmsProvider ?? e.kmsProvider
    isProduction = isProduction ?? e.isProduction
    keyVersion = keyVersion ?? e.kmsKeyVersion
    masterKey = masterKey ?? e.upstreamEncryptionKey
  } catch (err) {
    if (isProduction === undefined || kmsProvider === undefined) throw err
  }

  const provider = (kmsProvider ?? 'local').trim() || 'local'
  const flags = opts.featureFlags ?? (await loadEnabledFeatureFlags())

  if (provider === 'local') {
    if (isProduction) {
      throw new KmsError(
        'kms_local_in_production',
        'LocalKms is development-only; configure a real KMS_PROVIDER in production',
      )
    }
    return new LocalKms(masterKey ?? '', keyVersion ?? 1)
  }

  const factory = kmsProviderRegistry.get(provider)
  const flag = KMS_PROVIDER_FEATURE_FLAG[provider]
  if (!factory || (flag && !flags.has(flag))) {
    // Requested a real KMS that is not wired/enabled — refuse rather than
    // silently downgrading to local key material.
    throw new KmsError('kms_not_implemented', `KMS provider '${provider}' is not available; refusing to fall back`)
  }
  return factory({ masterKey, keyVersion: keyVersion ?? 1 })
}

// ── SecretHandle ──────────────────────────────────────────────────────

export interface SecretRecord {
  credentialId: string
  tenantId: string | null
  providerId: string
  name: string
  credentialType: string
  ciphertext: string
  encryptedDataKey: string
  kmsKeyVersion: number
  fingerprint: string
  enabled: boolean
  isPlatformManaged: boolean
}

export interface UnwrapOptions {
  /** Audit the use (default true). Disable only on a measured hot path. */
  audit?: boolean
  traceId?: string
  actorUserId?: string
}

export interface SecretHandle {
  readonly credentialId: string
  readonly tenantId: string | null
  readonly providerId: string
  readonly name: string
  readonly credentialType: string
  readonly kmsKeyVersion: number
  readonly fingerprint: string
  readonly enabled: boolean
  /** Retired compatibility method: always refuses in this process. */
  unwrap(workload: WorkloadIdentity, opts?: UnwrapOptions): Promise<string>
}

export interface SecretEnvelope {
  ciphertext: string
  encryptedDataKey: string
  kmsKeyVersion: number
  fingerprint: string
}

function fingerprintOf(plaintext: string): string {
  // Truncated sha256: enough to detect "same secret", useless for recovery.
  return sha256hex(plaintext).slice(0, 32)
}

function recordToHandle(record: SecretRecord, _kms: KmsClient): SecretHandle {
  return {
    credentialId: record.credentialId,
    tenantId: record.tenantId,
    providerId: record.providerId,
    name: record.name,
    credentialType: record.credentialType,
    kmsKeyVersion: record.kmsKeyVersion,
    fingerprint: record.fingerprint,
    enabled: record.enabled,
    async unwrap(workload: WorkloadIdentity, opts: UnwrapOptions = {}): Promise<string> {
      if (!allowedUnwrapWorkloads().has(workload)) {
        // Authorization event, not a cryptographic failure: audit it as such.
        await safeLogAudit({
          actorUserId: opts.actorUserId,
          tenantId: record.tenantId,
          action: AUDIT_ACTIONS.authzDenied,
          targetType: 'provider_credential',
          targetId: record.credentialId,
          metadata: { deniedAction: 'credential:use', reason: 'workload_not_permitted', workload },
          traceId: opts.traceId,
        })
        throw new KmsError('workload_not_permitted', `workload '${workload}' may not unwrap credentials`)
      }
      if (!record.enabled) {
        throw new KmsError('credential_disabled', 'credential is disabled')
      }
      throw new KmsError(
        'workload_not_permitted',
        'Provider unwrap is available only in the independent Gateway workload',
      )
    },
  }
}

function rowToRecord(row: Record<string, unknown>): SecretRecord {
  return {
    credentialId: row.id as string,
    tenantId: (row.tenant_id as string | null) ?? null,
    providerId: row.provider_id as string,
    name: row.name as string,
    credentialType: row.credential_type as string,
    ciphertext: row.encrypted_secret as string,
    encryptedDataKey: row.encrypted_data_key as string,
    kmsKeyVersion: row.encryption_key_version as number,
    fingerprint: row.fingerprint as string,
    enabled: row.enabled as boolean,
    isPlatformManaged: row.is_platform_managed as boolean,
  }
}

const ENVELOPE_SELECT = `id, tenant_id, provider_id, name, encrypted_secret, encrypted_data_key,
       encryption_key_version, fingerprint, credential_type, enabled, is_platform_managed`

async function encryptedOrganizationId(tenantId: string): Promise<string> {
  const result = await pool.query(`SELECT id FROM organizations WHERE tenant_id = $1 LIMIT 1`, [tenantId])
  if (!result.rows.length) throw new KmsError('credential_not_found', `no organization for tenant ${tenantId}`, 404)
  return result.rows[0].id as string
}

// ── Create / load / rotate / disable ──────────────────────────────────

export interface CreateCredentialInput {
  tenantId: string
  providerId: string
  name: string
  plaintext: string
  credentialType?: 'api_key' | 'oauth_token'
  isPlatformManaged?: boolean
  actorUserId?: string
  ip?: string
  traceId?: string
  kms?: KmsClient
}

// ── Credential config invalidation ────────────────────────────────────
// A gateway that caches SecretHandles must drop them when a credential is
// rotated, disabled or re-wrapped. Same shape as the downstream-key epoch in
// auth/api-keys.ts: a monotonic counter plus a listener hook.

let credentialEpoch = 0
const credentialListeners = new Set<(credentialId: string, epoch: number) => void>()

export function getCredentialEpoch(): number {
  return credentialEpoch
}

export function onCredentialInvalidated(listener: (credentialId: string, epoch: number) => void): () => void {
  credentialListeners.add(listener)
  return () => credentialListeners.delete(listener)
}

export function invalidateCredentialCache(credentialId = '*'): number {
  credentialEpoch += 1
  for (const listener of credentialListeners) {
    try {
      listener(credentialId, credentialEpoch)
    } catch {
      // A broken listener must never block invalidation.
    }
  }
  return credentialEpoch
}

/** Test-only reset. */
export function __resetCredentialEpochForTests(): void {
  credentialEpoch = 0
  credentialListeners.clear()
}

/**
 * Wrap a provider secret and persist the envelope. The plaintext is never
 * persisted and never returned — only a SecretHandle.
 */
export async function createCredential(input: CreateCredentialInput): Promise<SecretHandle> {
  assertLocalDevelopment()
  if (!input.plaintext) throw new KmsError('kms_encrypt_failed', 'credential secret is empty')
  const kms = input.kms ?? (await resolveKmsClient())
  const tenantId = input.isPlatformManaged ? null : input.tenantId
  const organizationId = input.isPlatformManaged ? null : await encryptedOrganizationId(input.tenantId)

  const dek = randomBytes(32)
  let envelope: SecretEnvelope
  try {
    const { encryptedDataKey, keyVersion } = await kms.encryptDataKey(dek)
    envelope = {
      ciphertext: aesEncrypt(input.plaintext, { current: { version: 1, key: dek } }),
      encryptedDataKey,
      kmsKeyVersion: keyVersion,
      fingerprint: fingerprintOf(input.plaintext),
    }
  } finally {
    dek.fill(0)
  }

  const result = await pool.query(
    `INSERT INTO provider_credentials
       (id, provider_id, organization_id, tenant_id, name, encrypted_secret, encryption_key_version,
        encrypted_data_key, fingerprint, credential_type, is_platform_managed)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${ENVELOPE_SELECT}`,
    [
      input.providerId,
      organizationId,
      tenantId,
      input.name,
      envelope.ciphertext,
      envelope.kmsKeyVersion,
      envelope.encryptedDataKey,
      envelope.fingerprint,
      input.credentialType ?? 'api_key',
      input.isPlatformManaged ?? false,
    ],
  )
  const record = rowToRecord(result.rows[0])

  await safeLogAudit({
    actorUserId: input.actorUserId,
    tenantId: record.tenantId,
    action: AUDIT_ACTIONS.credentialCreated,
    targetType: 'provider_credential',
    targetId: record.credentialId,
    metadata: {
      providerId: record.providerId,
      credentialType: record.credentialType,
      kmsKeyVersion: record.kmsKeyVersion,
      fingerprint: record.fingerprint,
      platformManaged: record.isPlatformManaged,
    },
    ip: input.ip,
    traceId: input.traceId,
  })

  return recordToHandle(record, kms)
}

/**
 * Load a credential handle scoped to a tenant. A cross-tenant id resolves to
 * "not found" (IDOR prevention).
 */
export async function loadSecretHandle(input: {
  credentialId: string
  tenantId: string
  kms?: KmsClient
}): Promise<SecretHandle> {
  const result = await pool.query(
    `SELECT ${ENVELOPE_SELECT} FROM provider_credentials
     WHERE id = $1 AND tenant_id = $2
     LIMIT 1`,
    [input.credentialId, input.tenantId],
  )
  if (!result.rows.length) throw new KmsError('credential_not_found', 'credential not found', 404)
  const kms = input.kms ?? (await resolveKmsClient())
  return recordToHandle(rowToRecord(result.rows[0]), kms)
}

/** Load a platform-managed credential. Callers must be system/gateway. */
export async function loadPlatformSecretHandle(input: {
  credentialId: string
  kms?: KmsClient
}): Promise<SecretHandle> {
  const result = await pool.query(
    `SELECT ${ENVELOPE_SELECT} FROM provider_credentials
     WHERE id = $1 AND is_platform_managed = true
     LIMIT 1`,
    [input.credentialId],
  )
  if (!result.rows.length) throw new KmsError('credential_not_found', 'credential not found', 404)
  const kms = input.kms ?? (await resolveKmsClient())
  return recordToHandle(rowToRecord(result.rows[0]), kms)
}

export interface RotateCredentialInput {
  credentialId: string
  tenantId: string
  plaintext: string
  actorUserId?: string
  ip?: string
  traceId?: string
  kms?: KmsClient
}

/** Re-wrap with a fresh DEK (and current KMS version). */
export async function rotateCredential(input: RotateCredentialInput): Promise<SecretHandle> {
  assertLocalDevelopment()
  if (!input.plaintext) throw new KmsError('kms_encrypt_failed', 'credential secret is empty')
  const existing = await pool.query(
    `SELECT provider_id, credential_type, is_platform_managed FROM provider_credentials
     WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [input.credentialId, input.tenantId],
  )
  if (!existing.rows.length) throw new KmsError('credential_not_found', 'credential not found', 404)

  const kms = input.kms ?? (await resolveKmsClient())
  const dek = randomBytes(32)
  let envelope: SecretEnvelope
  try {
    const { encryptedDataKey, keyVersion } = await kms.encryptDataKey(dek)
    envelope = {
      ciphertext: aesEncrypt(input.plaintext, { current: { version: 1, key: dek } }),
      encryptedDataKey,
      kmsKeyVersion: keyVersion,
      fingerprint: fingerprintOf(input.plaintext),
    }
  } finally {
    dek.fill(0)
  }

  const result = await pool.query(
    `UPDATE provider_credentials
     SET encrypted_secret = $1, encrypted_data_key = $2, encryption_key_version = $3,
         fingerprint = $4, updated_at = now()
     WHERE id = $5 AND tenant_id = $6
     RETURNING ${ENVELOPE_SELECT}`,
    [
      envelope.ciphertext,
      envelope.encryptedDataKey,
      envelope.kmsKeyVersion,
      envelope.fingerprint,
      input.credentialId,
      input.tenantId,
    ],
  )
  if (!result.rows.length) throw new KmsError('credential_not_found', 'credential not found', 404)
  const record = rowToRecord(result.rows[0])

  await safeLogAudit({
    actorUserId: input.actorUserId,
    tenantId: record.tenantId,
    action: AUDIT_ACTIONS.credentialRotated,
    targetType: 'provider_credential',
    targetId: record.credentialId,
    metadata: { kmsKeyVersion: record.kmsKeyVersion, fingerprint: record.fingerprint },
    ip: input.ip,
    traceId: input.traceId,
  })

  // Cached handles anywhere in the data plane are now stale.
  invalidateCredentialCache(record.credentialId)

  return recordToHandle(record, kms)
}

export async function disableCredential(input: {
  credentialId: string
  tenantId: string
  actorUserId?: string
  reason?: string
  traceId?: string
}): Promise<boolean> {
  const result = await pool.query(
    `UPDATE provider_credentials SET enabled = false, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND enabled = true
     RETURNING id`,
    [input.credentialId, input.tenantId],
  )
  if (!result.rows.length) return false
  await safeLogAudit({
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    action: AUDIT_ACTIONS.credentialDisabled,
    targetType: 'provider_credential',
    targetId: input.credentialId,
    metadata: { reason: input.reason ?? null },
    traceId: input.traceId,
  })
  invalidateCredentialCache(input.credentialId)
  return true
}
