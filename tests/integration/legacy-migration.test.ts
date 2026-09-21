import { expect, it, describe, beforeAll, beforeEach, afterAll } from 'vitest'
import { generateKeyPairSync, createHash } from 'node:crypto'
import pg from 'pg'
// @ts-expect-error Operational ESM runner is exercised directly.
import { decimalMicros, runLegacyMigration } from '../../scripts/legacy-migration.mjs'
// @ts-expect-error Operational ESM runner is exercised directly.
import { runMigrations } from '../../scripts/db-migrate.mjs'
import { buildKeyring, encrypt as aesEncrypt } from '../../src/lib/crypto'
// @ts-expect-error Operational ESM runner is exercised directly.
import { runLegacySecretMigration, legacySourceDigest } from '../../scripts/migrate-legacy-secrets.mjs'
// @ts-expect-error Operational ESM runner is exercised directly.
import { credentialContext } from '../../scripts/secret-enroll.mjs'

describe('legacy exact decimal migration', () => {
  it('rounds half away from zero without binary floating point', () => {
    expect(decimalMicros('1.0000005')).toBe('1000001')
    expect(decimalMicros('-0.0000005')).toBe('-1')
    expect(decimalMicros('9.223372036854775807e12')).toBe('9223372036854775807')
  })
  it('rejects nonfinite and bigint overflow', () => {
    for (const value of ['NaN', 'Infinity', '9223372036854.775808']) {
      expect(() => decimalMicros(value)).toThrow()
    }
  })
})

// Caller must explicitly supply a disposable database; this suite resets its schemas.
const connectionString = process.env.LEGACY_MIGRATION_TEST_DATABASE_URL ?? process.env.DATABASE_URL
if (!connectionString) throw new Error('LEGACY_MIGRATION_TEST_DATABASE_URL or DATABASE_URL is required')
const pool = new pg.Pool({ connectionString })
let client: pg.PoolClient
const owner = { tenantId: 'tenant-a', organizationId: 'org-a' }
const manifest = () => ({
  version: 1,
  namespace: 'fixture16',
  sourceSchema: 'public',
  currency: 'USD',
  timezone: 'UTC',
  backup: { reference: 'isolated-fixture-backup', sha256: 'a'.repeat(64) },
  freeze: { reference: 'isolated-fixture-freeze', confirmed: true },
  rows: {
    relay_channels: { c1: owner },
    relay_keys: { k1: owner, k2: owner },
    relay_logs: { l1: owner, l2: owner },
    relay_settings: { retention: owner },
  },
})
const run = (mode: string, options = {}) => runLegacyMigration({ client, mode, manifest: manifest(), ...options })

describe('explicit legacy migration on PostgreSQL', () => {
  beforeAll(async () => {
    client = await pool.connect()
  })
  beforeEach(async () => {
    await client.query('DROP SCHEMA public CASCADE')
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE')
    await client.query('CREATE SCHEMA public')
    await runMigrations(pool)
    await client.query(
      "INSERT INTO organizations(id,tenant_id,name,slug,kind) VALUES('org-a','tenant-a','A','a','customer'),('org-b','tenant-b','B','b','customer')",
    )
    await client.query(
      "INSERT INTO providers(id,code,name,official_base_url) VALUES('p1','fixture','Fixture','https://example.invalid')",
    )
    await client.query(
      "INSERT INTO relay_channels(id,name,provider,base_url,models) VALUES('c1','same','fixture','https://example.invalid','[]')",
    )
    await client.query(
      "INSERT INTO relay_keys(id,name,hash,prefix,budget,spent) VALUES('k1','same',$1,'test',1.0000005,0),('k2','same',$2,'test',2.0000005,1)",
      ['a'.repeat(64), 'b'.repeat(64)],
    )
    await client.query(
      "INSERT INTO relay_logs(id,model,channel,key_name,status,input_tokens,output_tokens,cost,created_at) VALUES('l1','model','same','same',200,3,4,0.0000005,'2026-01-01'),('l2','model','same','same',200,3,4,0.0000005,'2026-01-01')",
    )
    await client.query(
      `INSERT INTO relay_settings(id,value) VALUES('retention','{"retention_days":90,"hard_delete_days":365}')`,
    )
  })
  afterAll(async () => {
    client?.release()
    await pool.end()
  })
  it('preflights and dry-runs without any persistent target writes', async () => {
    expect((await run('preflight')).openingMicros).toBe('2000002')
    expect((await run('dry-run')).migrated).toBe(6)
    for (const table of [
      'legacy_migration_runs',
      'legacy_migration_mappings',
      'ledger_postings',
      'legacy_usage_archive',
      'downstream_api_keys',
    ])
      expect((await client.query(`SELECT count(*) FROM ${table}`)).rows[0].count).toBe('0')
  })
  it('preserves duplicate-looking source IDs, balanced exact openings and unknown historical dimensions on replay', async () => {
    await run('migrate')
    expect((await run('migrate')).migrated).toBe(0)
    expect((await run('verify')).after).toEqual({ mappings: 18, openingTransactions: 2, archivedUsage: 2 })
    const archive = await client.query('SELECT * FROM legacy_usage_archive')
    expect(archive.rowCount).toBe(2)
    expect(
      archive.rows.every(
        (r) =>
          r.cached_tokens === null &&
          r.reasoning_tokens === null &&
          r.project_id === null &&
          r.price_version_id === null &&
          r.cost_amount === '1',
      ),
    ).toBe(true)
    expect((await client.query('SELECT count(*),sum(amount)::text FROM ledger_postings')).rows[0]).toEqual({
      count: '4',
      sum: '0',
    })
    expect((await client.query('SELECT count(*) FROM usage_records')).rows[0].count).toBe('0')
  })
  it('rolls back an interrupted import and safely retries', async () => {
    await expect(
      run('migrate', {
        fault: () => {
          throw new Error('injected crash')
        },
      }),
    ).rejects.toThrow('injected crash')
    expect((await client.query('SELECT count(*) FROM legacy_migration_runs')).rows[0].count).toBe('0')
    await run('migrate')
    await run('verify')
  })
  it('refuses source and manifest drift after committing', async () => {
    await run('migrate')
    const changed = manifest()
    changed.timezone = 'Asia/Shanghai'
    await expect(run('migrate', { manifest: changed })).rejects.toThrow('drift')
    await client.query("UPDATE relay_logs SET key_name='changed' WHERE id='l1'")
    await expect(run('verify')).rejects.toThrow('drift')
  })
  it('rejects missing, extra and cross-tenant ownership mappings', async () => {
    const missing = manifest()
    delete (missing.rows.relay_keys as Record<string, unknown>).k1
    await expect(run('preflight', { manifest: missing })).rejects.toThrow('ownership')
    const extra = manifest()
    Object.assign(extra.rows.relay_logs, { bogus: owner })
    await expect(run('preflight', { manifest: extra })).rejects.toThrow('ownership')
    const crossed = manifest()
    crossed.rows.relay_keys.k1 = { tenantId: 'tenant-b', organizationId: 'org-a' }
    await expect(run('preflight', { manifest: crossed })).rejects.toThrow('mapping mismatch')
  })
  it('rejects reservations, negative amounts, nonfinite and overflow', async () => {
    for (const expression of ['reserved=0.1', 'budget=-1', "budget='NaN'", 'budget=1e20']) {
      await client.query(
        `UPDATE relay_keys SET budget=1,spent=0,reserved=0,${expression} WHERE id='k1'`.replace(
          'budget=1,spent=0,reserved=0,',
          'spent=0,',
        ),
      )
      await expect(run('preflight')).rejects.toThrow()
      await client.query("UPDATE relay_keys SET budget=1,spent=0,reserved=0 WHERE id='k1'")
    }
  })
  it('fails closed on secret-bearing channels and accepts only bound enrolled references', async () => {
    await client.query("UPDATE relay_channels SET secret='synthetic-opaque-legacy-ciphertext' WHERE id='c1'")
    await expect(run('preflight')).rejects.toThrow('Secret Plane')
    await client.query(
      "INSERT INTO provider_credentials(id,provider_id,organization_id,tenant_id,name,encrypted_secret,encrypted_data_key,last_verified_at) VALUES('cred1','p1','org-a','tenant-a','fixture','fixture-envelope','fixture-wrapped-dek',now())",
    )
    const enrollCredential = async (binding: Record<string, unknown>) => ({
      ...binding,
      verified: true,
      credentialId: 'cred1',
    })
    await expect(run('migrate', { enrollCredential: async () => ({ verified: true }) })).rejects.toThrow('binding')
    await expect(
      run('migrate', {
        enrollCredential,
        fault: () => {
          throw new Error('atomicity')
        },
      }),
    ).rejects.toThrow('atomicity')
    expect((await client.query('SELECT count(*) FROM channels')).rows[0].count).toBe('0')
    const credentialWriter = await pool.connect()
    try {
      await credentialWriter.query("SET lock_timeout='100ms'")
      await run('dry-run', {
        enrollCredential,
        fault: async () => {
          await expect(
            credentialWriter.query(
              "UPDATE provider_credentials SET encrypted_secret='racing-envelope' WHERE id='cred1'",
            ),
          ).rejects.toMatchObject({ code: '55P03' })
        },
      })
    } finally {
      credentialWriter.release()
    }
    await run('migrate', { enrollCredential })
    await run('verify', { enrollCredential })
    expect((await client.query('SELECT provider_credential_id FROM channels')).rows[0].provider_credential_id).toBe(
      'cred1',
    )
  })
  it('accepts an external-registry opaque credential via signed migration proofs+trust', async () => {
    // Mint a real versioned-scrypt-v1 legacy ciphertext and the matching proof.
    const passphrase = 'fixture-upstream-key'
    const plaintext = 'sk-integration-legacy'
    const ciphertext = aesEncrypt(plaintext, buildKeyring({ upstreamEncryptionKey: passphrase }))
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const signingKey = privateKey.export({ type: 'pkcs8', format: 'pem' })
    const trust = {
      operator: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    }
    const enroll = async ({ request, secret }: { request: Record<string, unknown>; secret: Buffer }) => {
      const entry = {
        tenant_id: request.tenant_id,
        credential_id: request.credential_id,
        credential_version: request.credential_version,
        provider_id: request.provider_id,
        allowed_https_origins: request.allowed_https_origins,
        context_base64: '',
        vault: {
          ...(request.vault as Record<string, unknown>),
          wrapped_dek: 'vault:v1:' + Buffer.alloc(48).toString('base64'),
        },
        encrypted: {
          algorithm: 'AES-256-GCM',
          nonce_base64: Buffer.alloc(12).toString('base64'),
          ciphertext_base64: secret.toString('base64'),
          tag_base64: Buffer.alloc(16).toString('base64'),
        },
      }
      entry.context_base64 = credentialContext(entry).toString('base64')
      return entry
    }
    const { proofs, signedRegistry: registry } = await runLegacySecretMigration({
      manifest: {
        namespace: 'fixture16',
        registry_id: 'fixture-registry',
        registry_version: 1,
        revocation_epoch: 0,
        allowed_https_origins: ['https://api.example.com'],
        vault: { mount: 'transit', key: 'nexus-provider-v1' },
        records: [
          {
            source_table: 'relay_channels',
            source_id: 'c1',
            tenant_id: 'tenant-a',
            provider_id: 'p1',
            credential_id: 'cred1',
            credential_version: 1,
            format: 'versioned-scrypt-v1',
            key_version: 1,
            ciphertext,
            fingerprint: createHash('sha256').update(plaintext).digest('hex').slice(0, 32),
          },
        ],
      },
      keyPassphrase: passphrase,
      enroll,
      signingKey,
      signingKeyId: 'operator',
      now: Date.now(),
    })
    // Operator provisions the opaque external-registry reference row.
    await client.query(
      "INSERT INTO provider_credentials(id,provider_id,organization_id,tenant_id,name,encrypted_secret,encrypted_data_key,credential_type,is_platform_managed,last_verified_at) VALUES('cred1','p1','org-a','tenant-a','fixture','external-registry:v1',NULL,'api_key',false,now())",
    )
    await client.query("UPDATE relay_channels SET secret=$1 WHERE id='c1'", [ciphertext])
    // Without proofs the importer fails closed on the secret-bearing channel.
    await expect(run('preflight')).rejects.toThrow('Secret Plane')
    // With proofs+trust the signed proof verifies and the opaque row is accepted.
    await expect(run('preflight', { proofs, trust })).rejects.toThrow('registry required')
    await expect(run('preflight', { proofs: [{ verified: true }], trust, registry })).rejects.toThrow()
    const altered = JSON.parse(Buffer.from(registry.payload_base64, 'base64').toString())
    altered.entries[0].encrypted.ciphertext_base64 = Buffer.from('unrelated').toString('base64')
    await expect(
      run('preflight', {
        proofs,
        trust,
        registry: { ...registry, payload_base64: Buffer.from(JSON.stringify(altered)).toString('base64') },
      }),
    ).rejects.toThrow('verification rejected')
    await run('migrate', { proofs, trust, registry })
    await run('verify', { proofs, trust, registry })
    expect((await client.query('SELECT provider_credential_id FROM channels')).rows[0].provider_credential_id).toBe(
      'cred1',
    )
    // A proof whose source binding does not match the actual ciphertext is rejected.
    const tamperedProofs = proofs.map((p: Record<string, unknown>) => ({
      ...p,
      source: { ...(p.source as Record<string, unknown>), id: 'not-c1' },
    }))
    await expect(run('preflight', { proofs: tamperedProofs, trust, registry })).rejects.toThrow()
  })

  it('detects target archive tampering', async () => {
    await run('migrate')
    await client.query('UPDATE legacy_usage_archive SET cached_tokens=0')
    await expect(run('verify')).rejects.toThrow('archive verification')
  })
  it('rejects schema drift, unsupported settings and missing operator evidence', async () => {
    const unfreezed = manifest()
    unfreezed.freeze.confirmed = false
    await expect(run('preflight', { manifest: unfreezed })).rejects.toThrow('evidence')
    await client.query('UPDATE relay_settings SET value=value || \'{"unknown_field":true}\'::jsonb')
    await expect(run('preflight')).rejects.toThrow('retention')
    await client.query('ALTER TABLE relay_channels ADD COLUMN unknown_field text')
    await expect(run('preflight')).rejects.toThrow('source schema')
  })
  it('uses the declared currency and source timezone', async () => {
    await client.query("UPDATE organizations SET base_currency='EUR' WHERE id='org-a'")
    const euro = manifest()
    euro.currency = 'EUR'
    euro.timezone = 'Asia/Shanghai'
    await run('migrate', { manifest: euro })
    await run('verify', { manifest: euro })
    expect((await client.query('SELECT DISTINCT currency FROM ledger_postings')).rows).toEqual([{ currency: 'EUR' }])
    expect(
      (await client.query('SELECT created_at AS stamp FROM legacy_usage_archive LIMIT 1')).rows[0].stamp.toISOString(),
    ).toBe('2025-12-31T16:00:00.000Z')
  })
  it('detects tampered provenance identity and retention targets', async () => {
    await run('migrate')
    await client.query(
      "UPDATE legacy_migration_mappings SET source_id='bogus' WHERE source_table='relay_logs' AND source_id='l1'",
    )
    await expect(run('verify')).rejects.toThrow('Mapping verification')
    await client.query("UPDATE legacy_migration_mappings SET source_id='l1' WHERE source_id='bogus'")
    await client.query("UPDATE retention_policies SET target_type='wrong_target'")
    await expect(run('verify')).rejects.toThrow('Retention verification')
  })
  it('adds opening balances to an existing wallet without obscuring existing postings', async () => {
    await client.query(
      "INSERT INTO wallet_accounts(id,tenant_id,organization_id,currency) VALUES('existing-wallet','tenant-a','org-a','USD')",
    )
    await client.query(
      "INSERT INTO ledger_accounts(id,tenant_id,wallet_id,type,currency,code) VALUES('existing-account','tenant-a','existing-wallet','wallet','USD','wallet:existing-wallet'),('existing-clearing','tenant-a',NULL,'clearing','USD','clearing:USD')",
    )
    await client.query('BEGIN')
    await client.query(
      "INSERT INTO ledger_transactions(id,tenant_id,type,currency,idempotency_key) VALUES('existing-tx','tenant-a','recharge','USD','existing-tx')",
    )
    await client.query(
      "INSERT INTO ledger_postings(id,transaction_id,tenant_id,account_id,currency,amount,entry_type) VALUES('existing-credit','existing-tx','tenant-a','existing-account','USD',5000000,'credit'),('existing-debit','existing-tx','tenant-a','existing-clearing','USD',-5000000,'debit')",
    )
    await client.query('COMMIT')
    await run('migrate')
    await run('verify')
    // Same wallet join used by the production getWalletBalance helper.
    expect(
      (
        await client.query(
          "SELECT sum(p.amount)::text AS balance FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id WHERE p.tenant_id='tenant-a' AND a.wallet_id='existing-wallet'",
        )
      ).rows[0].balance,
    ).toBe('7000002')
    expect((await client.query('SELECT count(*) FROM wallet_accounts')).rows[0].count).toBe('1')
  })
  it('holds source-table and ownership locks while inspecting the frozen source', async () => {
    const writer = await pool.connect()
    try {
      await writer.query("SET lock_timeout='100ms'")
      await run('dry-run', {
        fault: async () => {
          await expect(writer.query("UPDATE relay_keys SET name='racing writer' WHERE id='k1'")).rejects.toMatchObject({
            code: '55P03',
          })
          await expect(
            writer.query("UPDATE organizations SET tenant_id='racing-tenant' WHERE id='org-a'"),
          ).rejects.toMatchObject({ code: '55P03' })
          await expect(writer.query("UPDATE providers SET code='racing-provider' WHERE id='p1'")).rejects.toMatchObject(
            { code: '55P03' },
          )
        },
      })
      await run('migrate')
      await run('verify')
    } finally {
      writer.release()
    }
  })
})
