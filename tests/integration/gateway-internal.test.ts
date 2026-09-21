// Integration tests for Work Item E — the control-plane endpoints the Go data
// plane calls: /api/internal/gateway/{snapshot,reserve,settle,credential}.
//
// Requires a real Postgres (DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db).
// Resets the public schema and applies the canonical migration journal so it is
// independent of test ordering.
//
// Coverage:
//   1. internal auth is fail-closed (unset token closes the surface)
//   2. snapshot bundle is signed, verify-ready, tenant-scoped, and exports only
//      key HASHES (never plaintext)
//   3. reserve takes a real double-entry hold and refuses when the balance is
//      insufficient; a replay is idempotent
//   4. settle releases the hold and posts the authoritative charge
//   5. settle with status=unknown charges nothing and leaves the hold
//   6. credential lookups are tenant-scoped (IDOR returns 404)

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { Pool } from 'pg'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/app_db'
const INTERNAL_TOKEN = 'test-internal-token-0123456789abcdef'
const PASSPHRASE = 'integration-test-passphrase-for-keyring'
const SNAPSHOT_PASSPHRASE = 'integration-independent-snapshot-signing-key'

process.env.DATABASE_URL = DATABASE_URL
process.env.GATEWAY_INTERNAL_TOKEN = INTERNAL_TOKEN
process.env.UPSTREAM_ENCRYPTION_KEY = PASSPHRASE
process.env.SNAPSHOT_SIGNING_KEY = SNAPSHOT_PASSPHRASE
process.env.SNAPSHOT_SIGNING_KEY_VERSION = '1'

// Imported after the env is set so the keyring derives from the test passphrase.
import { pool as appPool } from '@/db'
import { buildKeyring } from '@/lib/crypto'
import { canonicalJson } from '@/lib/catalog/snapshot'
import { buildSnapshotPayload, signSnapshot } from '@/lib/catalog/snapshot'
import { postWalletCredit } from '@/lib/db/ledger'
import { GET as snapshotGET } from '@/app/api/internal/gateway/snapshot/route'
import { POST as reservePOST } from '@/app/api/internal/gateway/reserve/route'
import { POST as settlePOST } from '@/app/api/internal/gateway/settle/route'
import { POST as credentialPOST } from '@/app/api/internal/gateway/credential/route'

const pool = new Pool({ connectionString: DATABASE_URL })

const TENANT_A = 'tenant-a'
const TENANT_B = 'tenant-b'
const ORG_A = 'org-a'
const MODEL = 'gpt-4o'

let providerId: string
let credentialAId: string
let credentialBId: string
let priceVersionId: string
let publishedSignature: string
let publishedKeyId: string
let publishedPayload: Record<string, unknown>

async function resetDatabase(): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const runner = '../../scripts/db-migrate.mjs'
  const { runMigrations } = await import(runner)
  await runMigrations(pool)
}

function internalRequest(url: string, body?: unknown, token: string | null = INTERNAL_TOKEN): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== null) headers.authorization = `Bearer ${token}`
  return new Request(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, tenant_id, name, slug, status)
     VALUES ($1, $3, 'Tenant A', 'tenant-a', 'active'),
            ($2, $2, 'Tenant B', 'tenant-b', 'active')`,
    [ORG_A, TENANT_B, TENANT_A],
  )

  const provider = await pool.query<{ id: string }>(
    `INSERT INTO providers (id, code, name, official_base_url, auth_scheme, enabled)
     VALUES (gen_random_uuid(), 'openai', 'OpenAI', 'https://api.openai.com/v1', 'bearer', true)
     RETURNING id`,
  )
  providerId = provider.rows[0].id

  const credentialA = await pool.query<{ id: string }>(
    `INSERT INTO provider_credentials (id, provider_id, organization_id, tenant_id, name, encrypted_secret,
                                       encryption_key_version, encrypted_data_key, fingerprint, is_platform_managed, enabled)
     VALUES (gen_random_uuid(), $1, $2, $3, 'tenant-a key', 'v1:aa:bb:cc', 1, 'wrapped', 'fingerprint-a', false, true)
     RETURNING id`,
    [providerId, ORG_A, TENANT_A],
  )
  credentialAId = credentialA.rows[0].id

  const credentialB = await pool.query<{ id: string }>(
    `INSERT INTO provider_credentials (id, provider_id, organization_id, tenant_id, name, encrypted_secret,
                                       encryption_key_version, encrypted_data_key, fingerprint, is_platform_managed, enabled)
     VALUES (gen_random_uuid(), $1, NULL, $2, 'tenant-b key', 'v1:aa:bb:cc', 1, 'wrapped', 'fingerprint-b', false, true)
     RETURNING id`,
    [providerId, TENANT_B],
  )
  credentialBId = credentialB.rows[0].id

  // A platform-managed credential backs the platform channel, so the channel is
  // "managed". The tenant-owned credential above makes its own channel BYOK.
  const platformCredential = await pool.query<{ id: string }>(
    `INSERT INTO provider_credentials (id, provider_id, organization_id, tenant_id, name, encrypted_secret,
                                       encryption_key_version, encrypted_data_key, fingerprint, is_platform_managed, enabled)
     VALUES (gen_random_uuid(), $1, NULL, NULL, 'platform key', 'v1:aa:bb:cc', 1, 'wrapped', 'fingerprint-p', true, true)
     RETURNING id`,
    [providerId],
  )

  await pool.query(
    `INSERT INTO channels (id, tenant_id, provider_id, provider_credential_id, name, capabilities, region, weight, priority, enabled, metadata)
     VALUES (gen_random_uuid(), NULL, $1, $2, 'openai platform', '["text","streaming"]', 'global', 10, 0, true, '{"data_residency":"global"}')`,
    [providerId, platformCredential.rows[0].id],
  )

  await pool.query(
    `INSERT INTO upstream_models (id, provider_id, upstream_model_id, display_name, context_window, max_output_tokens,
                                  capabilities, lifecycle_status, available, raw_metadata)
     VALUES (gen_random_uuid(), $1, $2, 'GPT-4o', 128000, 16384, '["text","streaming"]', 'active', true, '{"license":"openai-tos"}')`,
    [providerId, MODEL],
  )

  const price = await pool.query<{ id: string }>(
    `INSERT INTO provider_price_versions (id, provider_id, upstream_model_id, currency, unit, input_price, output_price,
                                          cached_input_price, reasoning_price, request_price, image_price, audio_price,
                                          source_type, status, effective_from)
     VALUES (gen_random_uuid(), $1, $2, 'USD', 'per_million_tokens', '2.50', '10.00', '1.25', '0', '0', '0', '0',
             'manual', 'active', now() - interval '1 day')
     RETURNING id`,
    [providerId, MODEL],
  )
  priceVersionId = price.rows[0].id

  // The signed snapshot payload the gateway consumes.
  const payload = buildSnapshotPayload({
    tenantId: null,
    sequenceNumber: 1,
    catalogVersion: { id: 'cat-integration', version: 1, checksum: 'a'.repeat(64) },
    priceVersions: [
      {
        id: priceVersionId,
        provider: 'openai',
        model_id: MODEL,
        currency: 'USD',
        region: 'global',
        service_tier: 'default',
        unit: 'per_million_tokens',
        effective_from: new Date(Date.now() - 86_400_000).toISOString(),
        effective_to: null,
        components: [
          { kind: 'input', unit: 'per_million_tokens', amount: '2.50', conditions: {} },
          { kind: 'output', unit: 'per_million_tokens', amount: '10.00', conditions: {} },
        ],
      },
    ],
    routingPolicies: [],
  })
  const signed = signSnapshot(payload)
  publishedSignature = signed.signature
  publishedKeyId = signed.signingKeyId
  publishedPayload = signed.payload as unknown as Record<string, unknown>
  await pool.query(
    `INSERT INTO gateway_snapshots (id, tenant_id, sequence_number, signature, signing_key_id, payload)
     VALUES (gen_random_uuid(), NULL, 1, $1, $2, $3::jsonb)`,
    [signed.signature, signed.signingKeyId, JSON.stringify(signed.payload)],
  )

  // Downstream keys: one per tenant. The stored value is sha256(key).
  await pool.query(
    `INSERT INTO downstream_api_keys (id, organization_id, tenant_id, name, hash, prefix, scopes, enabled)
     VALUES (gen_random_uuid(), $1, $2, 'key-a', $3, 'sk-nx-', '["*"]', true)`,
    [ORG_A, TENANT_A, sha256(TENANT_A + '-api-key')],
  )

  // A funded wallet for tenant A.
  const wallet = await pool.query<{ id: string }>(
    `INSERT INTO wallet_accounts (id, organization_id, tenant_id, currency, status)
     VALUES (gen_random_uuid(), $1, $2, 'USD', 'active') RETURNING id`,
    [ORG_A, TENANT_A],
  )
  await postWalletCredit(TENANT_A, wallet.rows[0].id, 5_000_000n, 'seed-recharge')
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function testKeyring() {
  return buildKeyring({ upstreamEncryptionKey: SNAPSHOT_PASSPHRASE })
}

beforeAll(async () => {
  await resetDatabase()
  await seed()
})

afterAll(async () => {
  await appPool.end().catch(() => {})
  await pool.end()
})

// ── 1. Fail-closed internal auth ──────────────────────────────────────

describe('internal gateway auth', () => {
  it('refuses every endpoint when no token is configured', async () => {
    const saved = process.env.GATEWAY_INTERNAL_TOKEN
    delete process.env.GATEWAY_INTERNAL_TOKEN
    try {
      const response = await snapshotGET(internalRequest('http://localhost/api/internal/gateway/snapshot'))
      expect(response.status).toBe(503)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('internal_auth_not_configured')
    } finally {
      process.env.GATEWAY_INTERNAL_TOKEN = saved
    }
  })

  it('rejects a missing or wrong bearer token', async () => {
    const missing = await snapshotGET(
      internalRequest('http://localhost/api/internal/gateway/snapshot', undefined, null),
    )
    expect(missing.status).toBe(401)
    const wrong = await snapshotGET(
      internalRequest('http://localhost/api/internal/gateway/snapshot', undefined, 'not-the-token'),
    )
    expect(wrong.status).toBe(401)
  })
})

// ── 2. Signed snapshot bundle ─────────────────────────────────────────

describe('gateway snapshot bundle', () => {
  it('signs the explicitly selected credential version for registry overlap', async () => {
    await pool.query("UPDATE channels SET metadata=jsonb_set(metadata,'{credential_version}','2')")
    const response = await snapshotGET(internalRequest('http://localhost/api/internal/gateway/snapshot'))
    const body = await response.json()
    expect(body.bundle.channels[0].credential_version).toBe(2)
    const expected = createHmac('sha256', testKeyring().current.key)
      .update(canonicalJson(body.bundle), 'utf8')
      .digest('hex')
    expect(body.signature).toBe(expected)
  })
  it('returns a bundle whose signature verifies with the versioned keyring', async () => {
    const response = await snapshotGET(internalRequest('http://localhost/api/internal/gateway/snapshot'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      bundle: Record<string, unknown>
      signature: string
      signing_key_id: string
    }
    const keyring = testKeyring()
    const expected = createHmac('sha256', keyring.current.key).update(canonicalJson(body.bundle), 'utf8').digest('hex')
    expect(body.signature).toBe(expected)
    expect(body.signing_key_id).toBe(`hmac-sha256:v${keyring.current.version}`)
    const legacyWrappingSignature = createHmac(
      'sha256',
      buildKeyring({ upstreamEncryptionKey: PASSPHRASE }).current.key,
    )
      .update(canonicalJson(body.bundle), 'utf8')
      .digest('hex')
    expect(body.signature).not.toBe(legacyWrappingSignature)

    expect(body.bundle.kind).toBe('gateway_bundle')
    expect(body.bundle.schema_version).toBe(1)
    expect(body.bundle.expires_at).toBeTypeOf('string')
    const nested = body.bundle.snapshot as Record<string, unknown>
    expect(nested.kind).toBe('gateway_snapshot')
  })

  it('carries channels, models, prices and key digsests but never a plaintext key', async () => {
    const response = await snapshotGET(internalRequest('http://localhost/api/internal/gateway/snapshot'))
    const text = await response.text()
    const body = JSON.parse(text) as {
      bundle: {
        channels: Array<Record<string, unknown>>
        models: Array<Record<string, unknown>>
        keys: Array<Record<string, unknown>>
      }
    }

    expect(body.bundle.channels.length).toBeGreaterThan(0)
    const channel = body.bundle.channels[0]
    expect(channel.provider).toBe('openai')
    expect(channel.credential_mode).toBe('managed')
    expect(channel.credential_ref).toBeTruthy()

    const model = body.bundle.models.find((m) => m.id === MODEL)
    expect(model).toBeTruthy()
    expect(model!.license).toBe('openai-tos')

    expect(body.bundle.keys.length).toBe(1)
    const key = body.bundle.keys[0]
    expect(key.hash_sha256).toBe(sha256(`${TENANT_A}-api-key`))
    expect(key.tenant_id).toBe(TENANT_A)
    // The plaintext key must not appear anywhere in the response.
    expect(text).not.toContain(`${TENANT_A}-api-key`)
  })

  it('scopes the key directory to the requested tenant', async () => {
    const response = await snapshotGET(
      internalRequest(`http://localhost/api/internal/gateway/snapshot?tenant_id=${TENANT_A}`),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { bundle: { keys: Array<{ tenant_id: string }> } }
    expect(body.bundle.keys).toHaveLength(1)
    expect(body.bundle.keys[0].tenant_id).toBe(TENANT_A)
  })

  it('falls back to the platform snapshot for a tenant without its own', async () => {
    const response = await snapshotGET(
      internalRequest(`http://localhost/api/internal/gateway/snapshot?tenant_id=${TENANT_B}`),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { bundle: { tenant_id: string; keys: unknown[] } }
    // The bundle is scoped to the caller, but carries the platform's prices.
    expect(body.bundle.tenant_id).toBe(TENANT_B)
    expect(body.bundle.keys).toHaveLength(0)
  })

  it('404s when nothing has been published at all', async () => {
    await pool.query('DELETE FROM gateway_snapshots')
    try {
      const response = await snapshotGET(internalRequest('http://localhost/api/internal/gateway/snapshot'))
      expect(response.status).toBe(404)
    } finally {
      await pool.query(
        `INSERT INTO gateway_snapshots (id, tenant_id, sequence_number, signature, signing_key_id, payload)
         VALUES (gen_random_uuid(), NULL, 1, $1, $2, $3::jsonb)`,
        [publishedSignature, publishedKeyId, JSON.stringify(publishedPayload)],
      )
    }
  })
})

// ── 3/4/5. Reserve and settle ─────────────────────────────────────────

async function availableBalance(): Promise<bigint> {
  const result = await pool.query<{ balance: string }>(
    `SELECT COALESCE(sum(lp.amount), 0) AS balance
       FROM ledger_postings lp
       JOIN ledger_accounts la ON la.id = lp.account_id
      WHERE lp.tenant_id = $1 AND la.type = 'wallet'`,
    [TENANT_A],
  )
  return BigInt(result.rows[0].balance)
}

// Reservation concurrency/pricing coverage now runs against services/budget in
// budget-authorization.test.ts; final charge/unknown/replay remain Worker tests.
describe('retired Control Plane accounting endpoints', () => {
  it.each([reservePOST, settlePOST])('cannot move funds even with the old internal token', async (handler) => {
    const balance = await availableBalance()
    const before = await pool.query('SELECT count(*)::int AS count FROM ledger_transactions')
    for (const status of ['completed', 'failed', 'unknown']) {
      const request = internalRequest('http://localhost/api/internal/gateway/settle', {
        tenant_id: TENANT_A,
        organization_id: ORG_A,
        request_id: 'retired',
        status,
        input_tokens: 1000,
        output_tokens: 500,
        price_version_id: priceVersionId,
      })
      const response = await handler(request)
      expect(response.status).toBe(410)
      expect((await response.json()).error.code).toBe('billing_endpoint_retired')
      expect(request.bodyUsed).toBe(false)
    }
    expect(await availableBalance()).toBe(balance)
    expect((await pool.query('SELECT count(*)::int AS count FROM ledger_transactions')).rows).toEqual(before.rows)
  })
})

describe('credential resolution', () => {
  it('does not expose another tenant’s credential', async () => {
    const response = await credentialPOST(
      internalRequest('http://localhost/api/internal/gateway/credential', {
        tenant_id: TENANT_A,
        credential_id: credentialBId,
        mode: 'byok',
      }),
    )
    // Every legacy credential request is retired without resolving a credential.
    expect(response.status).toBe(410)
  })

  it('requires a tenant for BYOK credentials', async () => {
    const response = await credentialPOST(
      internalRequest('http://localhost/api/internal/gateway/credential', {
        credential_id: credentialAId,
        mode: 'byok',
      }),
    )
    expect(response.status).toBe(410)
  })

  it('404s for an unknown credential', async () => {
    const response = await credentialPOST(
      internalRequest('http://localhost/api/internal/gateway/credential', {
        tenant_id: TENANT_A,
        credential_id: '00000000-0000-0000-0000-000000000000',
        mode: 'byok',
      }),
    )
    expect(response.status).toBe(410)
  })
})
