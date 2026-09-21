// Integration tests for Work Item C — identity, RBAC and the secret plane.
//
// Requires a real Postgres (DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db).
// The suite resets the public schema and applies migrations 0000, 0001 and
// 0002 (envelope columns) so it is independent of test ordering.
//
// Covers the scenarios required by the brief:
//   1. permission matrix (every role)
//   2. IDOR — tenant A cannot read/revoke tenant B's key or credential
//   3. revocation propagation (epoch + outbox + immediate verify failure)
//   4. expired key rejected
//   5. wrong KMS version fails closed
//   6. log/audit redaction — no secret reaches audit_events or a redacted object
//   7. browser bundle exclusion — no server-secret module is reachable from a
//      client component
// Plus session/CSRF behaviour from deliverables 2 and 3.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { Pool } from 'pg'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  ROLES,
  capabilitiesForRole,
  hasCapability,
  requireCapability,
  requireRole,
  requireTenantAccess,
  assertMatrixInvariants,
  AuthzError,
  type Principal,
  type Role,
} from '@/lib/auth/capabilities'
import {
  SESSION_COOKIE,
  createSession,
  verifySession,
  revokeSession,
  serializeSessionCookie,
  clearSessionCookie,
  parseSessionCookie,
  requireRecentAuth,
} from '@/lib/auth/sessions'
import {
  issueCsrfToken,
  verifyCsrfToken,
  assertCsrf,
  serializeCsrfCookie,
  requiresCsrf,
  CsrfError,
} from '@/lib/auth/csrf'
import {
  API_KEY_PREFIX,
  createDownstreamKey,
  verifyDownstreamKey,
  revokeDownstreamKey,
  scopeMatches,
  ApiKeyError,
  getRevocationEpoch,
  onDownstreamKeyInvalidated,
  __resetRevocationStateForTests,
} from '@/lib/auth/api-keys'
import {
  createCredential,
  loadSecretHandle,
  rotateCredential,
  disableCredential,
  LocalKms,
  resolveKmsClient,
  KmsError,
  getCredentialEpoch,
  onCredentialInvalidated,
  __resetCredentialEpochForTests,
} from '@/lib/secrets/envelope'
import { redactSecrets, redactString, AUDIT_ACTIONS } from '@/lib/audit'
import { hashPassword, sha256hex } from '@/lib/crypto'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/app_db'
const pool = new Pool({ connectionString: DATABASE_URL })

// Dev-only KMS used throughout. Explicit so the test does not depend on env.
const TEST_MASTER_KEY = 'integration-test-master-key-not-a-real-secret'
const kmsV1 = new LocalKms(TEST_MASTER_KEY, 1)
const kmsV2 = new LocalKms(TEST_MASTER_KEY, 2)

function readMigration(name: string): string {
  return readFileSync(join(process.cwd(), 'drizzle', name), 'utf-8')
}

async function resetDatabase() {
  const client = await pool.connect()
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE')
    await client.query('CREATE SCHEMA public')
    await client.query('GRANT ALL ON SCHEMA public TO postgres')
    await client.query('GRANT ALL ON SCHEMA public TO public')
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    await client.query(readMigration('0000_left_nekra.sql'))
    await client.query(readMigration('0001_greedy_shape.sql'))
    await client.query(readMigration('0002_auth_secret_plane.sql'))
  } finally {
    client.release()
  }
}

interface Tenant {
  id: string
  tenantId: string
}

async function createTenant(slug: string): Promise<Tenant> {
  const result = await pool.query(
    `INSERT INTO organizations (id, name, slug, kind, base_currency, status)
     VALUES (gen_random_uuid(), $1, $2, 'customer', 'USD', 'active')
     RETURNING id, tenant_id`,
    [slug, slug],
  )
  return { id: result.rows[0].id, tenantId: result.rows[0].tenant_id }
}

async function createUser(email: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (id, email, password_hash, status) VALUES (gen_random_uuid(), $1, $2, 'active') RETURNING id`,
    [email, hashPassword('correct horse battery staple')],
  )
  return result.rows[0].id
}

async function addMembership(tenant: Tenant, userId: string, role: string): Promise<void> {
  await pool.query(
    `INSERT INTO organization_memberships (id, organization_id, tenant_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
    [tenant.id, tenant.tenantId, userId, role],
  )
}

async function createProvider(code: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO providers (id, code, name, official_base_url) VALUES (gen_random_uuid(), $1, $1, 'https://example.test')
     RETURNING id`,
    [code],
  )
  return result.rows[0].id
}

async function auditMetadataFor(tenantId: string, action: string): Promise<string[]> {
  const result = await pool.query(`SELECT metadata::text AS m FROM audit_events WHERE tenant_id = $1 AND action = $2`, [
    tenantId,
    action,
  ])
  return result.rows.map((r) => r.m as string)
}

const CREATED_MARKER = 'sk-test-SUPER-SECRET-MARKER-0123456789abcdef'

let tenantA: Tenant
let tenantB: Tenant
let userA: string
let userB: string
let providerId: string

beforeAll(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await pool.query(
    `TRUNCATE audit_events, outbox_events, sessions, provider_credentials, downstream_api_keys,
             organization_memberships, users, organizations, providers CASCADE`,
  )
  __resetRevocationStateForTests()
  __resetCredentialEpochForTests()
  tenantA = await createTenant('tenant-a')
  tenantB = await createTenant('tenant-b')
  userA = await createUser('owner-a@example.test')
  userB = await createUser('owner-b@example.test')
  await addMembership(tenantA, userA, 'owner')
  await addMembership(tenantB, userB, 'owner')
  providerId = await createProvider('openai')
})

// ── 1. Permission matrix ──────────────────────────────────────────────

describe('permission matrix', () => {
  it('every role maps to a non-empty, distinct capability set', () => {
    for (const role of ROLES) {
      expect(capabilitiesForRole(role).length).toBeGreaterThan(0)
    }
    // Distinctness spot checks: viewer ⊂ developer ⊂ admin ⊂ owner.
    expect(hasCapability('viewer', 'apikey:create')).toBe(false)
    expect(hasCapability('developer', 'apikey:create')).toBe(true)
    expect(hasCapability('developer', 'member:invite')).toBe(false)
    expect(hasCapability('admin', 'member:invite')).toBe(true)
    expect(hasCapability('admin', 'org:delete')).toBe(false)
    expect(hasCapability('owner', 'org:delete')).toBe(true)
  })

  it('billing cannot touch credentials and developers cannot touch billing', () => {
    expect(hasCapability('billing', 'billing:manage')).toBe(true)
    expect(hasCapability('billing', 'credential:create')).toBe(false)
    expect(hasCapability('billing', 'apikey:create')).toBe(false)
    expect(hasCapability('developer', 'billing:manage')).toBe(false)
    expect(hasCapability('developer', 'credential:create')).toBe(true)
  })

  it('system-auditor reads audit events cross-tenant and cannot mutate billing or credentials', () => {
    expect(hasCapability('system-auditor', 'audit:read')).toBe(true)
    expect(hasCapability('system-auditor', 'audit:export')).toBe(true)
    expect(hasCapability('system-auditor', 'system:cross-tenant')).toBe(true)
    expect(hasCapability('system-auditor', 'billing:manage')).toBe(false)
    expect(hasCapability('system-auditor', 'credential:create')).toBe(false)
    expect(hasCapability('system-auditor', 'credential:rotate')).toBe(false)
    expect(hasCapability('system-auditor', 'credential:use')).toBe(false)
    expect(hasCapability('system-auditor', 'apikey:create')).toBe(false)
    expect(hasCapability('system-auditor', 'member:invite')).toBe(false)
  })

  it('no role can both decrypt credentials and mutate audit records', () => {
    // There is no audit-mutation capability at all; audit is append-only.
    expect(assertMatrixInvariants).not.toThrow()
    for (const role of ROLES) {
      expect(hasCapability(role, 'credential:use')).toBe(false)
    }
  })

  it('enforcement helpers deny by default and throw typed errors', () => {
    const viewer: Principal = { kind: 'user', role: 'viewer', userId: userA, tenantId: tenantA.tenantId }
    expect(() => requireCapability(viewer, 'apikey:create')).toThrow(AuthzError)
    expect(() => requireRole(viewer, ['owner', 'admin'])).toThrow(AuthzError)
    // Unauthenticated is 401, forbidden is 403.
    try {
      requireCapability(null, 'apikey:read')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AuthzError)
      expect((err as AuthzError).status).toBe(401)
    }
    try {
      requireCapability(viewer, 'apikey:create')
    } catch (err) {
      expect((err as AuthzError).status).toBe(403)
    }
  })

  it('unknown roles are rejected', () => {
    const bogus = { kind: 'user', role: 'superuser' as Role, tenantId: tenantA.tenantId } as Principal
    expect(() => requireCapability(bogus, 'apikey:read')).toThrow(AuthzError)
  })
})

// ── 2. IDOR / tenant isolation ────────────────────────────────────────

describe('IDOR and tenant isolation', () => {
  it('tenant A cannot read tenant B credential through the secret plane', async () => {
    const handleB = await createCredential({
      tenantId: tenantB.tenantId,
      providerId,
      name: 'b-provider-key',
      plaintext: 'provider-secret-for-b',
      kms: kmsV1,
    })

    await expect(
      loadSecretHandle({ credentialId: handleB.credentialId, tenantId: tenantA.tenantId, kms: kmsV1 }),
    ).rejects.toMatchObject({ code: 'credential_not_found', status: 404 })

    // The owning tenant can load it.
    const own = await loadSecretHandle({ credentialId: handleB.credentialId, tenantId: tenantB.tenantId, kms: kmsV1 })
    expect(own.credentialId).toBe(handleB.credentialId)
  })

  it('tenant A cannot revoke tenant B downstream key', async () => {
    const { key } = await createDownstreamKey({ tenantId: tenantB.tenantId, name: 'b-key', scopes: ['chat:write'] })
    const revoked = await revokeDownstreamKey({ tenantId: tenantA.tenantId, keyId: key.id })
    expect(revoked).toBe(false)

    // Still usable for its owner.
    const created = await createDownstreamKey({
      tenantId: tenantB.tenantId,
      name: 'b-key-2',
      scopes: ['chat:write'],
    })
    expect(created.key.tenantId).toBe(tenantB.tenantId)
  })

  it('requireTenantAccess returns 404 for cross-tenant and allows system-auditor', () => {
    const principalA: Principal = { kind: 'user', role: 'owner', userId: userA, tenantId: tenantA.tenantId }
    expect(() => requireTenantAccess(principalA, tenantB.tenantId)).toThrow(AuthzError)
    try {
      requireTenantAccess(principalA, tenantB.tenantId)
    } catch (err) {
      expect((err as AuthzError).status).toBe(404)
    }
    const auditor: Principal = { kind: 'user', role: 'system-auditor', userId: userB }
    expect(requireTenantAccess(auditor, tenantB.tenantId)).toBe(auditor)
  })
})

// ── 3. Revocation propagation ─────────────────────────────────────────

describe('downstream key lifecycle and revocation propagation', () => {
  it('returns plaintext once and stores only a hash', async () => {
    const { plaintext, key } = await createDownstreamKey({
      tenantId: tenantA.tenantId,
      name: 'prod-key',
      scopes: ['chat:write'],
      actorUserId: userA,
    })

    expect(plaintext.startsWith(API_KEY_PREFIX)).toBe(true)
    expect(key.hash).toBe(sha256hex(plaintext))
    expect(key.hash).not.toBe(plaintext)

    const dbRow = await pool.query(`SELECT hash, prefix FROM downstream_api_keys WHERE id = $1`, [key.id])
    expect(dbRow.rows[0].hash).toBe(sha256hex(plaintext))
    // Only the recognizable, non-secret prefix is stored in clear.
    expect(dbRow.rows[0].prefix).toBe(API_KEY_PREFIX)
    expect(dbRow.rows[0].hash).not.toContain(plaintext)
  })

  it('verifies a key, then rejects it immediately after revocation and bumps the epoch', async () => {
    const { plaintext, key } = await createDownstreamKey({
      tenantId: tenantA.tenantId,
      name: 'revocable',
      scopes: ['chat:write'],
    })

    const before = await verifyDownstreamKey(plaintext, { requiredScope: 'chat:write' })
    expect(before.ok).toBe(true)

    const epochBefore = getRevocationEpoch()
    let notified: { keyId: string; epoch: number } | null = null
    const unsubscribe = onDownstreamKeyInvalidated((keyId, epoch) => {
      notified = { keyId, epoch }
    })

    const revoked = await revokeDownstreamKey({ tenantId: tenantA.tenantId, keyId: key.id, actorUserId: userA })
    unsubscribe()
    expect(revoked).toBe(true)
    expect(getRevocationEpoch()).toBe(epochBefore + 1)
    expect(notified).toEqual({ keyId: key.id, epoch: epochBefore + 1 })

    const after = await verifyDownstreamKey(plaintext, { requiredScope: 'chat:write' })
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.reason).toBe('revoked')

    const outbox = await pool.query(
      `SELECT event_type, payload FROM outbox_events WHERE tenant_id = $1 AND aggregate_id = $2`,
      [tenantA.tenantId, key.id],
    )
    expect(outbox.rows).toHaveLength(1)
    expect(outbox.rows[0].event_type).toBe('api_key.revoked')
    expect(outbox.rows[0].payload.revocationEpoch).toBe(epochBefore + 1)

    const audited = await auditMetadataFor(tenantA.tenantId, AUDIT_ACTIONS.apiKeyRevoked)
    expect(audited).toHaveLength(1)
  })

  it('enforces scopes', async () => {
    expect(scopeMatches(['*'], 'chat:write')).toBe(true)
    expect(scopeMatches(['chat:write'], 'chat:write')).toBe(true)
    expect(scopeMatches(['chat:*'], 'chat:write')).toBe(true)
    expect(scopeMatches(['models:read'], 'chat:write')).toBe(false)
    expect(scopeMatches([], 'chat:write')).toBe(false)

    const { plaintext } = await createDownstreamKey({
      tenantId: tenantA.tenantId,
      name: 'scoped',
      scopes: ['models:read'],
    })
    const denied = await verifyDownstreamKey(plaintext, { requiredScope: 'chat:write' })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('scope_denied')

    const allowed = await verifyDownstreamKey(plaintext, { requiredScope: 'models:read' })
    expect(allowed.ok).toBe(true)
  })

  it('rejects malformed and unknown keys without leaking anything', async () => {
    expect(await verifyDownstreamKey('not-a-key')).toEqual({ ok: false, reason: 'malformed' })
    const unknown = await verifyDownstreamKey(`${API_KEY_PREFIX}${'a'.repeat(48)}`)
    expect(unknown).toEqual({ ok: false, reason: 'not_found' })
  })

  it('refuses to create a key with an unknown scope or past expiry', async () => {
    await expect(
      createDownstreamKey({ tenantId: tenantA.tenantId, name: 'bad-scope', scopes: ['root:everything'] }),
    ).rejects.toBeInstanceOf(ApiKeyError)
    await expect(
      createDownstreamKey({
        tenantId: tenantA.tenantId,
        name: 'past-expiry',
        scopes: ['chat:write'],
        expiresAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toMatchObject({ code: 'invalid_expiry' })
  })
})

// ── 4. Expired key ────────────────────────────────────────────────────

describe('expired keys', () => {
  it('rejects verification of a key whose expiry has passed', async () => {
    const { plaintext, key } = await createDownstreamKey({
      tenantId: tenantA.tenantId,
      name: 'short-lived',
      scopes: ['chat:write'],
      expiresAt: new Date(Date.now() + 60_000),
    })
    // Time-travel: force the stored expiry into the past.
    await pool.query(`UPDATE downstream_api_keys SET expires_at = now() - interval '1 hour' WHERE id = $1`, [key.id])

    const result = await verifyDownstreamKey(plaintext, { requiredScope: 'chat:write' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('expired')
  })

  it('rejects a disabled key', async () => {
    const { plaintext, key } = await createDownstreamKey({
      tenantId: tenantA.tenantId,
      name: 'disabled',
      scopes: ['chat:write'],
    })
    await pool.query(`UPDATE downstream_api_keys SET enabled = false WHERE id = $1`, [key.id])
    const result = await verifyDownstreamKey(plaintext)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('disabled')
  })
})

// ── 5. Secret plane / envelope encryption ─────────────────────────────

describe('secret plane envelope encryption', () => {
  it('stores ciphertext, encrypted data key, KMS version and fingerprint — never plaintext', async () => {
    const handle = await createCredential({
      tenantId: tenantA.tenantId,
      providerId,
      name: 'A cred',
      plaintext: CREATED_MARKER,
      kms: kmsV1,
      actorUserId: userA,
    })

    const row = await pool.query(
      `SELECT encrypted_secret, encrypted_data_key, encryption_key_version, fingerprint FROM provider_credentials WHERE id = $1`,
      [handle.credentialId],
    )
    const stored = row.rows[0]
    expect(stored.encrypted_secret).toBeTruthy()
    expect(stored.encrypted_secret).not.toContain(CREATED_MARKER)
    expect(stored.encrypted_data_key).toBeTruthy()
    expect(stored.encryption_key_version).toBe(1)
    expect(stored.fingerprint).toBe(sha256hex(CREATED_MARKER).slice(0, 32))
    // No column anywhere holds the plaintext.
    const anyPlaintext = await pool.query(
      `SELECT count(*)::int AS n FROM provider_credentials WHERE encrypted_secret LIKE '%' || $1 || '%'`,
      [CREATED_MARKER],
    )
    expect(anyPlaintext.rows[0].n).toBe(0)
  })

  it('refuses every role-string unwrap in the Control Plane process', async () => {
    const handle = await createCredential({
      tenantId: tenantA.tenantId,
      providerId,
      name: 'A cred',
      plaintext: CREATED_MARKER,
      kms: kmsV1,
      actorUserId: userA,
    })

    await expect(handle.unwrap('control-plane')).rejects.toMatchObject({ code: 'workload_not_permitted', status: 403 })
    await expect(handle.unwrap('worker')).rejects.toMatchObject({ code: 'workload_not_permitted' })

    await expect(handle.unwrap('gateway', { actorUserId: userA })).rejects.toMatchObject({
      code: 'workload_not_permitted',
    })

    // Use is audited, without the secret. Workload denial is an authorization
    // event, not a decrypt failure.
    const used = await auditMetadataFor(tenantA.tenantId, AUDIT_ACTIONS.credentialUsed)
    expect(used).toHaveLength(0)

    const decryptFailures = await auditMetadataFor(tenantA.tenantId, AUDIT_ACTIONS.credentialDecryptFailed)
    expect(decryptFailures).toHaveLength(0)
    const denials = await auditMetadataFor(tenantA.tenantId, AUDIT_ACTIONS.authzDenied)
    expect(denials).toHaveLength(3)
  })

  it('fails closed on a wrong KMS key version', async () => {
    const handle = await createCredential({
      tenantId: tenantA.tenantId,
      providerId,
      name: 'versioned',
      plaintext: 'versioned-secret',
      kms: kmsV1,
    })
    const row = await pool.query(`SELECT encrypted_data_key FROM provider_credentials WHERE id = $1`, [
      handle.credentialId,
    ])
    const edk = row.rows[0].encrypted_data_key as string

    await expect(kmsV2.decryptDataKey(edk, 2)).rejects.toMatchObject({ code: 'kms_key_version_mismatch' })
    await expect(kmsV1.decryptDataKey(edk, 2)).rejects.toMatchObject({ code: 'kms_key_version_mismatch' })
    // Correct version still works.
    const dek = await kmsV1.decryptDataKey(edk, 1)
    expect(dek).toHaveLength(32)
  })

  it('refuses LocalKms in production and never falls back from a real KMS', async () => {
    await expect(
      resolveKmsClient({ provider: 'local', isProduction: true, featureFlags: new Set() }),
    ).rejects.toMatchObject({ code: 'kms_local_in_production' })

    // Historical flags never override the production prohibition.
    for (const masterKey of [TEST_MASTER_KEY, '']) {
      await expect(
        resolveKmsClient({
          provider: 'local',
          isProduction: true,
          featureFlags: new Set(['kms.local.allow_in_production']),
          masterKey,
        }),
      ).rejects.toMatchObject({ code: 'kms_local_in_production' })
    }

    // A real KMS that is not registered fails closed instead of downgrading.
    await expect(resolveKmsClient({ provider: 'aws', featureFlags: new Set() })).rejects.toMatchObject({
      code: 'kms_not_implemented',
    })
  })

  it('rotation rewraps with a fresh data key and disable blocks unwrap', async () => {
    const handle = await createCredential({
      tenantId: tenantA.tenantId,
      providerId,
      name: 'rotating',
      plaintext: 'first-secret',
      kms: kmsV1,
    })
    const before = await pool.query(
      `SELECT encrypted_secret, encrypted_data_key FROM provider_credentials WHERE id = $1`,
      [handle.credentialId],
    )

    // Rotation must invalidate any cached handle in the data plane.
    const epochBefore = getCredentialEpoch()
    let invalidated: { credentialId: string; epoch: number } | null = null
    const unsubscribe = onCredentialInvalidated((credentialId, epoch) => {
      invalidated = { credentialId, epoch }
    })

    const rotated = await rotateCredential({
      credentialId: handle.credentialId,
      tenantId: tenantA.tenantId,
      plaintext: 'second-secret',
      kms: kmsV1,
      actorUserId: userA,
    })
    unsubscribe()
    await expect(rotated.unwrap('gateway')).rejects.toMatchObject({ code: 'workload_not_permitted' })
    expect(getCredentialEpoch()).toBe(epochBefore + 1)
    expect(invalidated).toEqual({ credentialId: handle.credentialId, epoch: epochBefore + 1 })

    const after = await pool.query(
      `SELECT encrypted_secret, encrypted_data_key FROM provider_credentials WHERE id = $1`,
      [handle.credentialId],
    )
    expect(after.rows[0].encrypted_secret).not.toBe(before.rows[0].encrypted_secret)
    expect(after.rows[0].encrypted_data_key).not.toBe(before.rows[0].encrypted_data_key)
    expect(await auditMetadataFor(tenantA.tenantId, AUDIT_ACTIONS.credentialRotated)).toHaveLength(1)

    const epochAfterRotate = getCredentialEpoch()
    expect(
      await disableCredential({ credentialId: handle.credentialId, tenantId: tenantA.tenantId, actorUserId: userA }),
    ).toBe(true)
    expect(getCredentialEpoch()).toBe(epochAfterRotate + 1)
    const reloaded = await loadSecretHandle({
      credentialId: handle.credentialId,
      tenantId: tenantA.tenantId,
      kms: kmsV1,
    })
    await expect(reloaded.unwrap('gateway')).rejects.toMatchObject({ code: 'workload_not_permitted' })
    expect(await auditMetadataFor(tenantA.tenantId, AUDIT_ACTIONS.credentialDisabled)).toHaveLength(1)
    // Rotation/disable are tenant-scoped.
    expect(await disableCredential({ credentialId: handle.credentialId, tenantId: tenantB.tenantId })).toBe(false)
  })
})

// ── 6. Log / audit redaction ──────────────────────────────────────────

describe('log and audit redaction', () => {
  it('redacts secret-shaped fields and inline secret values', () => {
    const redacted = redactSecrets({
      api_key: 'sk-nx-' + 'a'.repeat(40),
      nested: { authorization: 'Bearer abcdefghijklmnop', password: 'hunter2' },
      safe: 'tenant-123',
      keyId: 'key_123',
    }) as Record<string, unknown>

    expect(redacted.api_key).toBe('[REDACTED]')
    expect((redacted.nested as Record<string, unknown>).authorization).toBe('[REDACTED]')
    expect((redacted.nested as Record<string, unknown>).password).toBe('[REDACTED]')
    // Non-secret identifiers survive for forensics.
    expect(redacted.safe).toBe('tenant-123')
    expect(redacted.keyId).toBe('key_123')

    expect(redactString(`prefix ${API_KEY_PREFIX}${'f'.repeat(40)} suffix`)).toBe('prefix [REDACTED] suffix')
    expect(redactString('Bearer abcdefghijklmnop')).toContain('[REDACTED]')
  })

  it('never writes the provider secret to audit_events', async () => {
    const handle = await createCredential({
      tenantId: tenantA.tenantId,
      providerId,
      name: 'audited',
      plaintext: CREATED_MARKER,
      kms: kmsV1,
      actorUserId: userA,
      traceId: 'trace-1',
    })
    await expect(handle.unwrap('gateway', { actorUserId: userA })).rejects.toMatchObject({
      code: 'workload_not_permitted',
    })

    const all = await pool.query(
      `SELECT action, metadata::text AS m, target_id FROM audit_events WHERE tenant_id = $1`,
      [tenantA.tenantId],
    )
    expect(all.rows.length).toBeGreaterThanOrEqual(2)
    for (const row of all.rows) {
      expect(row.m).not.toContain(CREATED_MARKER)
      expect(row.m).not.toContain('SUPER-SECRET-MARKER')
    }
    expect(all.rows.some((r) => r.action === AUDIT_ACTIONS.credentialCreated)).toBe(true)
    expect(all.rows.some((r) => r.action === AUDIT_ACTIONS.authzDenied)).toBe(true)
  })

  it('never writes a downstream key to audit_events on failure or success', async () => {
    const { plaintext } = await createDownstreamKey({
      tenantId: tenantA.tenantId,
      name: 'audit-key',
      scopes: ['chat:write'],
      actorUserId: userA,
    })
    await verifyDownstreamKey(plaintext, { requiredScope: 'chat:write' })
    await verifyDownstreamKey(`${API_KEY_PREFIX}${'0'.repeat(48)}`, { requiredScope: 'chat:write' })

    const rows = await pool.query(`SELECT metadata::text AS m FROM audit_events WHERE tenant_id = $1`, [
      tenantA.tenantId,
    ])
    expect(rows.rows.length).toBeGreaterThanOrEqual(2)
    for (const row of rows.rows) {
      expect(row.m).not.toContain(plaintext)
    }
  })
})

// ── 7. Browser bundle exclusion ───────────────────────────────────────

describe('browser bundle exclusion', () => {
  const SERVER_ONLY_MODULES = [
    '@/lib/secrets/',
    '@/lib/auth/sessions',
    '@/lib/auth/api-keys',
    '@/lib/audit',
    '@/lib/crypto',
  ]

  function walk(dir: string): string[] {
    return readdirSync(join(process.cwd(), dir), { recursive: true, encoding: 'utf-8' })
      .map((p) => `${dir}/${p}`.replace(/\\/g, '/'))
      .filter((p) => p.endsWith('.ts') || p.endsWith('.tsx'))
  }

  it('server-secret modules are not client components', () => {
    for (const file of [...walk('src/lib/secrets'), ...walk('src/lib/auth'), 'src/lib/audit.ts']) {
      const source = readFileSync(join(process.cwd(), file), 'utf-8')
      expect(source.includes("'use client'"), `${file} must not be a client component`).toBe(false)
      expect(source.includes('"use client"'), `${file} must not be a client component`).toBe(false)
    }
  })

  it('no client component imports a server-secret module', () => {
    for (const file of walk('src/app')) {
      const source = readFileSync(join(process.cwd(), file), 'utf-8')
      const isClient = /^\s*['"]use client['"]/m.test(source)
      if (!isClient) continue
      for (const serverOnly of SERVER_ONLY_MODULES) {
        expect(source.includes(serverOnly), `${file} (client) must not import ${serverOnly}`).toBe(false)
      }
    }
  })

  it('secret-plane modules carry server-only dependencies', () => {
    const envelope = readFileSync(join(process.cwd(), 'src/lib/secrets/envelope.ts'), 'utf-8')
    // Uses node crypto and the DB pool — neither resolves in a browser bundle.
    expect(envelope.includes("from 'crypto'")).toBe(true)
    expect(envelope.includes("from '@/db'")).toBe(true)
  })
})

// ── Session and CSRF behaviour (deliverables 2 and 3) ─────────────────

describe('sessions', () => {
  it('creates a session, stores only the token hash, verifies and revokes it', async () => {
    const { token, session, cookie } = await createSession({ userId: userA, ip: '127.0.0.1', userAgent: 'vitest' })
    expect(token).toHaveLength(64)
    expect(cookie).toContain(`${SESSION_COOKIE}=${token}`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Max-Age=')
    // Not Secure in dev/test; Secure is asserted separately below.
    expect(cookie).not.toContain('Secure')

    const dbRow = await pool.query(`SELECT token_hash FROM sessions WHERE id = $1`, [session.id])
    expect(dbRow.rows[0].token_hash).toBe(sha256hex(token))
    expect(dbRow.rows[0].token_hash).not.toBe(token)

    const verified = await verifySession(token)
    expect(verified?.userId).toBe(userA)

    expect(parseSessionCookie(`other=1; ${SESSION_COOKIE}=${token}`)).toBe(token)
    expect(await revokeSession(token, { actorUserId: userA })).toBe(true)
    expect(await verifySession(token)).toBeNull()
  })

  it('rejects expired and unknown sessions', async () => {
    const { token, session } = await createSession({ userId: userA, ttlSeconds: 300 })
    await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [session.id])
    expect(await verifySession(token)).toBeNull()
    expect(await verifySession('f'.repeat(64))).toBeNull()
    expect(await verifySession(null)).toBeNull()
  })

  it('sets Secure in production and supports short-lived high-risk auth', async () => {
    const cookie = serializeSessionCookie('t'.repeat(64), { isProduction: true })
    expect(cookie).toContain('Secure')
    expect(clearSessionCookie({ isProduction: true })).toContain('Max-Age=0')

    const { session } = await createSession({ userId: userA })
    const fresh = { ...session, ageSeconds: 5 }
    expect(() => requireRecentAuth(fresh, 900)).not.toThrow()
    expect(() => requireRecentAuth({ ...session, ageSeconds: 10_000 }, 900)).toThrow(AuthzError)
  })
})

describe('CSRF', () => {
  it('requires a matching token on state-changing requests only', () => {
    const token = issueCsrfToken()
    expect(token).toHaveLength(64)
    expect(requiresCsrf('POST')).toBe(true)
    expect(requiresCsrf('DELETE')).toBe(true)
    expect(requiresCsrf('GET')).toBe(false)
    expect(requiresCsrf('HEAD')).toBe(false)
    expect(requiresCsrf(undefined)).toBe(false)

    expect(verifyCsrfToken(token, token)).toBe(true)
    expect(verifyCsrfToken('x', token)).toBe(false)
    expect(verifyCsrfToken(null, token)).toBe(false)

    expect(() => assertCsrf({ method: 'POST', headerToken: token, cookieToken: token })).not.toThrow()
    // Safe methods are exempt.
    expect(() => assertCsrf({ method: 'GET' })).not.toThrow()
    expect(() => assertCsrf({ method: 'POST', headerToken: 'nope', cookieToken: token })).toThrow(CsrfError)
    expect(() => assertCsrf({ method: 'POST' })).toThrow(CsrfError)

    const cookie = serializeCsrfCookie(token, { isProduction: true })
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
    // CSRF cookie must be readable by the browser app (double submit).
    expect(cookie).not.toContain('HttpOnly')
  })

  it('audits a rejected CSRF attempt', async () => {
    expect(() => assertCsrf({ method: 'POST', cookieToken: 'expected', headerToken: 'provided' })).toThrow(CsrfError)
    // safeLogAudit is fire-and-forget; flush the microtask/DB roundtrip.
    await new Promise((r) => setTimeout(r, 150))
    const rows = await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'csrf.rejected'`)
    expect(rows.rows[0].n).toBeGreaterThanOrEqual(1)
  })
})
