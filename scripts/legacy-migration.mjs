import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import pg from 'pg'

const tables = ['relay_channels', 'relay_keys', 'relay_logs', 'relay_settings']
const sourceColumns = {
  relay_channels: {
    id: 'text',
    name: 'text',
    provider: 'text',
    base_url: 'text',
    secret: 'text',
    models: 'jsonb',
    weight: 'integer',
    enabled: 'boolean',
    latency: 'integer',
    created_at: 'timestamp without time zone',
  },
  relay_keys: {
    id: 'text',
    name: 'text',
    hash: 'text',
    prefix: 'text',
    budget: 'double precision',
    spent: 'double precision',
    reserved: 'double precision',
    enabled: 'boolean',
    created_at: 'timestamp without time zone',
  },
  relay_logs: {
    id: 'text',
    model: 'text',
    channel: 'text',
    key_name: 'text',
    status: 'integer',
    input_tokens: 'integer',
    output_tokens: 'integer',
    cost: 'double precision',
    latency: 'integer',
    demo: 'boolean',
    created_at: 'timestamp without time zone',
  },
  relay_settings: { id: 'text', value: 'jsonb' },
}
const canonical = (v) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  )
const digest = (v) => createHash('sha256').update(canonical(v)).digest('hex')
const id = (...parts) => `legacy:${digest(parts)}`
const fail = (message) => {
  throw new Error(message)
}
function decimal(value) {
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value)
  if (!m || value.length > 100 || Math.abs(Number(m[4] ?? 0)) > 100) fail('Invalid decimal amount')
  const scale = (m[3]?.length ?? 0) - Number(m[4] ?? 0)
  return [BigInt(`${m[1] === '-' ? '-' : ''}${m[2]}${m[3] ?? ''}`), scale]
}
function micros(n, scale) {
  if (scale <= 6) n *= 10n ** BigInt(6 - scale)
  else {
    const divisor = 10n ** BigInt(scale - 6)
    const sign = n < 0n ? -1n : 1n
    n = sign * ((sign * n + divisor / 2n) / divisor)
  }
  if (n > 9223372036854775807n || n < -9223372036854775808n) fail('Amount overflows bigint micros')
  return n.toString()
}
export function decimalMicros(value) {
  return micros(...decimal(value))
}
function opening(row) {
  const [b, bs] = decimal(row.budget),
    [s, ss] = decimal(row.spent),
    [r] = decimal(row.reserved)
  if (b < 0n || s < 0n || r !== 0n) fail('Negative amount or unresolved reservation')
  const scale = Math.max(bs, ss)
  const n = b * 10n ** BigInt(scale - bs) - s * 10n ** BigInt(scale - ss)
  if (n < 0n) fail('Negative opening balance')
  return micros(n, scale)
}
function exactKeys(value, keys, name) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    fail(`Invalid ${name} fields`)
}
function manifestCheck(m) {
  exactKeys(m, ['version', 'namespace', 'sourceSchema', 'currency', 'timezone', 'backup', 'freeze', 'rows'], 'manifest')
  if (
    m.version !== 1 ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(m.namespace) ||
    !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(m.sourceSchema) ||
    !/^[A-Z]{3}$/.test(m.currency)
  )
    fail('Invalid manifest identity/currency')
  try {
    new Intl.DateTimeFormat('en', { timeZone: m.timezone }).format()
  } catch {
    fail('Invalid source timezone')
  }
  exactKeys(m.backup, ['reference', 'sha256'], 'backup')
  exactKeys(m.freeze, ['reference', 'confirmed'], 'freeze')
  if (
    !m.backup.reference ||
    !/^[a-f0-9]{64}$/.test(m.backup.sha256) ||
    m.freeze.confirmed !== true ||
    !m.freeze.reference
  )
    fail('Backup/freeze operator evidence required')
  exactKeys(m.rows, tables, 'row mappings')
}

/** Adapter is trusted Secret Plane authority, never operator-supplied JSON assertions.
 * It verifies an EXISTING enrolled provider_credentials reference and binds digest,
 * tenant and provider. No source plaintext/decryption is passed to Control Plane.
 *
 * When an operator supplies signed migration proofs + a trusted key
 * (--proofs/--trust/--registry) instead of an inline enrollCredential verifier, the
 * importer verifies each proof's Ed25519 signature and source/target binding
 * itself and accepts the new external-registry opaque credential rows
 * (encrypted_secret = 'external-registry:v1', encrypted_data_key NULL). A
 * missing or unverified proof fails closed; the legacy encrypted_data_key
 * IS NOT NULL path is unchanged.
 */
export async function proofBasedVerifier({ proofs, trust, registry }) {
  // Lazy import keeps the operator migration module out of the hot import graph.
  const { verifyMigrationProof, entryDigest, payloadDigest } = await import('./migrate-legacy-secrets.mjs')
  const { parseStrictJson } = await import('./secret-enroll.mjs')
  if (
    !Array.isArray(proofs) ||
    !registry ||
    registry.format !== 'nexus.secret-registry.signed.v1' ||
    typeof registry.payload_base64 !== 'string' ||
    registry.payload_base64.length > 16 * 1024 * 1024
  )
    fail('Signed migration registry required')
  const payloadBytes = Buffer.from(registry.payload_base64, 'base64')
  if (payloadBytes.toString('base64') !== registry.payload_base64) fail('Invalid migration registry encoding')
  const payload = parseStrictJson(payloadBytes)
  if (payload.format !== 'nexus.secret-registry.payload.v1' || !Array.isArray(payload.entries))
    fail('Invalid migration registry payload')
  return async ({ sourceCipherDigest, tenantId, providerId, sourceId, namespace, sourceCiphertext }) => {
    const matching = proofs.filter(
      (p) =>
        p &&
        p.source &&
        p.source.ciphertext_digest === sourceCipherDigest &&
        p.source.namespace === namespace &&
        p.source.table === 'relay_channels' &&
        p.source.id === sourceId,
    )
    if (matching.length !== 1) fail('Exactly one signed migration proof required for source ciphertext')
    const proof = matching[0]
    const entries = payload.entries.filter(
      (e) =>
        e.tenant_id === tenantId &&
        e.provider_id === providerId &&
        e.credential_id === proof.target?.credential_id &&
        e.credential_version === proof.target?.credential_version,
    )
    if (
      entries.length !== 1 ||
      payload.registry_id !== proof.target.registry_id ||
      payload.registry_version !== proof.target.registry_version
    )
      fail('Migration proof registry binding mismatch')
    let verified
    try {
      verified = verifyMigrationProof({
        proof,
        trust,
        recomputedEntryDigest: entryDigest(entries[0]),
        recomputedPayloadDigest: payloadDigest(payloadBytes),
        expectedSource: {
          namespace,
          table: 'relay_channels',
          id: sourceId,
          ciphertext_digest: sourceCipherDigest,
          source_format: 'versioned-scrypt-v1',
          source_key_version: Number(/^v([1-9][0-9]*):/.exec(sourceCiphertext)?.[1]),
        },
      })
    } catch {
      fail('Signed migration proof verification rejected')
    }
    if (verified.target.tenant_id !== tenantId || verified.target.provider_id !== providerId)
      fail('Migration proof target binding mismatch')
    return {
      verified: true,
      credentialId: verified.target.credential_id,
      sourceCipherDigest,
      tenantId,
      providerId,
      externalRegistry: true,
    }
  }
}

export async function runLegacyMigration({ client, mode, manifest, enrollCredential, proofs, trust, registry, fault }) {
  if (!['preflight', 'dry-run', 'migrate', 'verify'].includes(mode)) fail('Invalid migration mode')
  manifestCheck(manifest)
  const verifier = enrollCredential ?? (proofs && trust ? await proofBasedVerifier({ proofs, trust, registry }) : null)
  const m = manifest,
    md = digest(m),
    data = {},
    credentials = new Map()
  await client.query('BEGIN')
  try {
    await client.query("SET LOCAL lock_timeout = '10s'")
    await client.query("SELECT pg_advisory_xact_lock(hashtext('nexus-explicit-legacy-import'))")
    await client.query("SELECT set_config('TimeZone', $1, true)", [m.timezone])
    await client.query(`LOCK TABLE ${tables.map((t) => `"${m.sourceSchema}"."${t}"`).join(',')} IN SHARE MODE`)
    for (const table of tables) {
      const columns = (
        await client.query(
          'SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',
          [m.sourceSchema, table],
        )
      ).rows
      if (
        canonical(Object.fromEntries(columns.map((c) => [c.column_name, c.data_type]))) !==
        canonical(sourceColumns[table])
      )
        fail('Unsupported legacy source schema')
      const expressions =
        table === 'relay_keys'
          ? "jsonb_build_object('budget',budget::text,'spent',spent::text,'reserved',reserved::text,'created_at',created_at::text)"
          : table === 'relay_logs'
            ? "jsonb_build_object('cost',cost::text,'created_at',created_at::text)"
            : table === 'relay_channels'
              ? "jsonb_build_object('created_at',created_at::text)"
              : "'{}'::jsonb"
      const rows = (
        await client.query(
          `SELECT to_jsonb(s) || ${expressions} AS row FROM "${m.sourceSchema}"."${table}" s ORDER BY id`,
        )
      ).rows.map((r) => r.row)
      exactKeys(
        m.rows[table],
        rows.map((r) => r.id),
        `${table} ownership`,
      )
      data[table] = rows
      for (const r of rows) {
        const owner = m.rows[table][r.id]
        exactKeys(owner, ['tenantId', 'organizationId'], 'owner')
        const org = await client.query(
          'SELECT id FROM organizations WHERE id=$1 AND tenant_id=$2 AND base_currency=$3 FOR SHARE',
          [owner.organizationId, owner.tenantId, m.currency],
        )
        if (org.rowCount !== 1) fail('Tenant/organization/currency mapping mismatch')
        if (table === 'relay_keys') {
          opening(r)
          decimalMicros(r.budget)
          decimalMicros(r.spent)
          if (!/^[a-f0-9]{64}$/i.test(r.hash)) fail('Unsupported legacy API key hash')
        }
        if (table === 'relay_logs') {
          if (decimal(r.cost)[0] < 0n || r.input_tokens < 0 || r.output_tokens < 0) fail('Invalid historical usage')
          decimalMicros(r.cost)
        }
        if (table === 'relay_settings') {
          if (r.id !== 'retention') fail('Unsupported legacy setting; explicit remediation required')
          exactKeys(r.value, ['retention_days', 'hard_delete_days'], 'retention')
          if (
            !Number.isInteger(r.value.retention_days) ||
            r.value.retention_days < 1 ||
            !Number.isInteger(r.value.hard_delete_days) ||
            r.value.hard_delete_days < r.value.retention_days
          )
            fail('Invalid retention policy')
        }
        if (table === 'relay_channels') {
          const provider = (await client.query('SELECT id FROM providers WHERE code=$1 FOR SHARE', [r.provider]))
            .rows[0]
          if (!provider) fail('Provider must already be explicitly provisioned')
          if (r.secret) {
            if (!verifier) fail('Authorized Secret Plane verifier required')
            const sourceCipherDigest = digest(r.secret)
            const proof = await verifier({
              sourceCipherDigest,
              sourceCiphertext: r.secret,
              tenantId: owner.tenantId,
              organizationId: owner.organizationId,
              providerId: provider.id,
              sourceId: r.id,
              namespace: m.namespace,
              mode,
            })
            if (
              !proof ||
              proof.sourceCipherDigest !== sourceCipherDigest ||
              proof.tenantId !== owner.tenantId ||
              proof.providerId !== provider.id ||
              proof.verified !== true
            )
              fail('Credential verification binding mismatch')
            let enrolled
            if (proof.externalRegistry) {
              // New external-registry opaque row: secret lives in the signed
              // Vault registry, not in CP columns. Verified only by the signed
              // migration proof checked above; never by JSON self-assertion.
              enrolled = await client.query(
                "SELECT id FROM provider_credentials WHERE id=$1 AND tenant_id=$2 AND organization_id=$3 AND provider_id=$4 AND encrypted_data_key IS NULL AND encrypted_secret = 'external-registry:v1' FOR SHARE",
                [proof.credentialId, owner.tenantId, owner.organizationId, provider.id],
              )
            } else {
              enrolled = await client.query(
                'SELECT id FROM provider_credentials WHERE id=$1 AND tenant_id=$2 AND organization_id=$3 AND provider_id=$4 AND encrypted_data_key IS NOT NULL AND last_verified_at IS NOT NULL AND encrypted_secret <> $5 FOR SHARE',
                [proof.credentialId, owner.tenantId, owner.organizationId, provider.id, r.secret],
              )
            }
            if (enrolled.rowCount !== 1) fail('Verified Secret Plane reference missing')
            credentials.set(r.id, proof.credentialId)
            r.secret = { sourceCipherDigest }
          }
          r.providerId = provider.id
        }
      }
    }
    const sd = digest(data)
    const prior = (await client.query('SELECT * FROM legacy_migration_runs WHERE namespace=$1', [m.namespace])).rows[0]
    if (prior && (prior.source_digest !== sd || prior.manifest_digest !== md))
      fail('Source or manifest drift conflicts with recorded migration')
    const before = Object.fromEntries(tables.map((t) => [t, data[t].length]))
    const report = {
      namespace: m.namespace,
      sourceDigest: sd,
      manifestDigest: md,
      before,
      after: {},
      migrated: 0,
      unknown: data.relay_logs.length,
      ambiguous: 0,
      rejected: 0,
      openingMicros: data.relay_keys.reduce((a, r) => a + BigInt(opening(r)), 0n).toString(),
      evidence: 'operator-attested backup/freeze; source locked and fingerprinted',
      rounding: 'decimal half-away-from-zero to micros',
    }
    if (mode === 'preflight') {
      await client.query('ROLLBACK')
      return report
    }
    if (mode === 'verify' && !prior) fail('No committed legacy migration to verify')
    if (!prior)
      await client.query(
        'INSERT INTO legacy_migration_runs(namespace,source_digest,manifest_digest,report) VALUES($1,$2,$3,$4)',
        [m.namespace, sd, md, report],
      )
    let expectedMappings = 0
    async function map(table, r, kind, targetId) {
      expectedMappings++
      const owner = m.rows[table][r.id],
        mid = id(m.namespace, table, r.id, kind)
      if (!prior)
        await client.query('INSERT INTO legacy_migration_mappings VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [
          mid,
          m.namespace,
          table,
          r.id,
          owner.tenantId,
          digest(r),
          kind,
          targetId,
        ])
      const found = (
        await client.query('SELECT * FROM legacy_migration_mappings WHERE id=$1 AND tenant_id=$2', [
          mid,
          owner.tenantId,
        ])
      ).rows[0]
      if (
        !found ||
        found.target_id !== targetId ||
        found.source_digest !== digest(r) ||
        found.namespace !== m.namespace ||
        found.source_table !== table ||
        found.source_id !== r.id ||
        found.target_kind !== kind
      )
        fail('Mapping verification failed')
    }
    for (const table of tables)
      for (const r of data[table]) {
        const o = m.rows[table][r.id],
          target = id(m.namespace, table, r.id)
        if (table === 'relay_channels') {
          if (!prior)
            await client.query(
              'INSERT INTO channels(id,tenant_id,provider_id,provider_credential_id,name,weight,enabled,created_at) VALUES($1,$2,$3,$4,$5,$6,false,$7)',
              [target, o.tenantId, r.providerId, credentials.get(r.id) ?? null, r.name, r.weight, r.created_at],
            )
          await map(table, r, 'channel', target)
          await map(table, r, 'provider', r.providerId)
          await map(table, r, 'credential', credentials.get(r.id) ?? null)
          const check = await client.query(
            'SELECT id FROM channels WHERE id=$1 AND tenant_id=$2 AND provider_id=$3 AND provider_credential_id IS NOT DISTINCT FROM $4',
            [target, o.tenantId, r.providerId, credentials.get(r.id) ?? null],
          )
          if (check.rowCount !== 1) fail('Channel verification failed')
        }
        if (table === 'relay_keys') {
          const amount = opening(r),
            wallet = id(o.tenantId, m.currency, 'wallet'),
            account = id(o.tenantId, m.currency, 'wallet-account'),
            clearing = id(o.tenantId, m.currency, 'legacy-clearing'),
            tx = id(m.namespace, r.id, 'opening')
          if (!prior) {
            await client.query(
              'INSERT INTO downstream_api_keys(id,tenant_id,organization_id,name,hash,prefix,enabled,created_at) VALUES($1,$2,$3,$4,$5,$6,false,$7)',
              [target, o.tenantId, o.organizationId, r.name, r.hash, r.prefix, r.created_at],
            )
            await client.query(
              'INSERT INTO wallet_accounts(id,tenant_id,organization_id,currency) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,currency) DO NOTHING',
              [wallet, o.tenantId, o.organizationId, m.currency],
            )
            const actualWallet = (
              await client.query(
                'SELECT id FROM wallet_accounts WHERE tenant_id=$1 AND organization_id=$2 AND currency=$3',
                [o.tenantId, o.organizationId, m.currency],
              )
            ).rows[0]?.id
            if (!actualWallet) fail('Wallet ownership conflict')
            await client.query(
              "INSERT INTO ledger_accounts(id,tenant_id,wallet_id,type,currency,code) VALUES($1,$2,$3,'wallet',$4,$1),($5,$2,NULL,'clearing',$4,$5) ON CONFLICT(id) DO NOTHING",
              [account, o.tenantId, actualWallet, m.currency, clearing],
            )
            await client.query(
              "INSERT INTO ledger_transactions(id,tenant_id,type,currency,idempotency_key,reference_type,reference_id,description) VALUES($1,$2,'adjustment',$3,$1,'legacy_key',$4,'Estimated legacy opening balance; decimal half-away-from-zero')",
              [tx, o.tenantId, m.currency, target],
            )
            await client.query(
              "INSERT INTO ledger_postings(id,transaction_id,tenant_id,account_id,currency,amount,entry_type) VALUES($1,$2,$3,$4,$5,$6,'credit'),($7,$2,$3,$8,$5,$9,'debit')",
              [
                id(tx, 'credit'),
                tx,
                o.tenantId,
                account,
                m.currency,
                amount,
                id(tx, 'debit'),
                clearing,
                (-BigInt(amount)).toString(),
              ],
            )
          }
          await map(table, r, 'api_key', target)
          await map(table, r, 'project', null)
          await map(table, r, 'opening_ledger', tx)
          const key = await client.query(
            'SELECT id FROM downstream_api_keys WHERE id=$1 AND tenant_id=$2 AND organization_id=$3 AND hash=$4 AND project_id IS NULL',
            [target, o.tenantId, o.organizationId, r.hash],
          )
          const postings = await client.query(
            'SELECT account_id,amount::text,entry_type,currency,tenant_id FROM ledger_postings WHERE transaction_id=$1 ORDER BY entry_type',
            [tx],
          )
          const transaction = await client.query(
            "SELECT id FROM ledger_transactions WHERE id=$1 AND tenant_id=$2 AND currency=$3 AND reference_type='legacy_key' AND reference_id=$4 AND idempotency_key=$1 AND type='adjustment'",
            [tx, o.tenantId, m.currency, target],
          )
          const accounts = await client.query(
            "SELECT a.id FROM ledger_accounts a LEFT JOIN wallet_accounts w ON w.id=a.wallet_id WHERE a.tenant_id=$1 AND a.currency=$2 AND ((a.id=$3 AND a.type='wallet' AND w.tenant_id=$1 AND w.organization_id=$4 AND w.currency=$2) OR (a.id=$5 AND a.type='clearing' AND a.wallet_id IS NULL))",
            [o.tenantId, m.currency, account, o.organizationId, clearing],
          )
          if (
            key.rowCount !== 1 ||
            transaction.rowCount !== 1 ||
            accounts.rowCount !== 2 ||
            postings.rowCount !== 2 ||
            postings.rows[0].amount !== amount ||
            postings.rows[0].account_id !== account ||
            postings.rows[1].amount !== (-BigInt(amount)).toString() ||
            postings.rows[1].account_id !== clearing ||
            postings.rows.some((p) => p.currency !== m.currency || p.tenant_id !== o.tenantId)
          )
            fail('Opening balance verification failed')
        }
        if (table === 'relay_logs') {
          if (!prior)
            await client.query(
              'INSERT INTO legacy_usage_archive(id,tenant_id,organization_id,source_digest,input_tokens,output_tokens,cost_amount,currency,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
              [
                target,
                o.tenantId,
                o.organizationId,
                digest(r),
                r.input_tokens,
                r.output_tokens,
                decimalMicros(r.cost),
                m.currency,
                r.status,
                r.created_at,
              ],
            )
          await map(table, r, 'usage_archive', target)
          await map(table, r, 'historical_project', null)
          await map(table, r, 'historical_key', null)
          await map(table, r, 'historical_price', null)
          const check = await client.query(
            'SELECT id FROM legacy_usage_archive WHERE id=$1 AND tenant_id=$2 AND source_digest=$3 AND cost_amount=$4 AND organization_id=$5 AND input_tokens=$6 AND output_tokens=$7 AND currency=$8 AND status=$9 AND created_at=$10::timestamp AT TIME ZONE $11 AND cached_tokens IS NULL AND reasoning_tokens IS NULL AND project_id IS NULL AND downstream_key_id IS NULL AND price_version_id IS NULL AND estimated_amount=true',
            [
              target,
              o.tenantId,
              digest(r),
              decimalMicros(r.cost),
              o.organizationId,
              r.input_tokens,
              r.output_tokens,
              m.currency,
              r.status,
              r.created_at,
              m.timezone,
            ],
          )
          if (check.rowCount !== 1) fail('Usage archive verification failed')
        }
        if (table === 'relay_settings') {
          if (!prior)
            await client.query(
              "INSERT INTO retention_policies(id,tenant_id,target_type,retention_days,hard_delete_after_days) VALUES($1,$2,'legacy_usage_archive',$3,$4)",
              [target, o.tenantId, r.value.retention_days, r.value.hard_delete_days],
            )
          await map(table, r, 'retention_policy', target)
          const check = await client.query(
            "SELECT id FROM retention_policies WHERE id=$1 AND tenant_id=$2 AND retention_days=$3 AND hard_delete_after_days=$4 AND target_type='legacy_usage_archive'",
            [target, o.tenantId, r.value.retention_days, r.value.hard_delete_days],
          )
          if (check.rowCount !== 1) fail('Retention verification failed')
        }
        if (fault) await fault({ table, sourceId: r.id })
      }
    const mapped = Number(
      (await client.query('SELECT count(*) FROM legacy_migration_mappings WHERE namespace=$1', [m.namespace])).rows[0]
        .count,
    )
    if (mapped !== expectedMappings) fail('Mapping count verification failed')
    report.after = {
      mappings: mapped,
      openingTransactions: data.relay_keys.length,
      archivedUsage: data.relay_logs.length,
    }
    report.migrated = prior ? 0 : Object.values(before).reduce((a, b) => a + b, 0)
    report.replayed = Boolean(prior)
    if (!prior)
      await client.query('UPDATE legacy_migration_runs SET report=$2 WHERE namespace=$1', [m.namespace, report])
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    await client.query(mode === 'dry-run' || mode === 'verify' ? 'ROLLBACK' : 'COMMIT')
    return report
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...rest] = process.argv.slice(2)
  const flags = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]
    if (!key?.startsWith('--') || !rest[i + 1] || key in flags) {
      process.exitCode = 1
      break
    }
    flags[key] = rest[i + 1]
  }
  if (
    !mode ||
    !flags['--manifest'] ||
    !process.env.DATABASE_URL ||
    (flags['--proofs'] && !flags['--trust']) ||
    (flags['--trust'] && !flags['--proofs']) ||
    (flags['--proofs'] && !flags['--registry']) ||
    (flags['--registry'] && !flags['--proofs'])
  ) {
    console.error(
      'Usage: DATABASE_URL=... node scripts/legacy-migration.mjs preflight|dry-run|migrate|verify --manifest path.json [--proofs proofs.json --trust trust.json --registry registry.json]',
    )
    process.exitCode = 1
  } else {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
    try {
      await client.connect()
      const proofs = flags['--proofs'] ? JSON.parse(await readFile(flags['--proofs'], 'utf8')) : undefined
      const registry = flags['--registry'] ? JSON.parse(await readFile(flags['--registry'], 'utf8')) : undefined
      const trust = flags['--trust'] ? JSON.parse(await readFile(flags['--trust'], 'utf8')) : undefined
      console.log(
        JSON.stringify(
          await runLegacyMigration({
            client,
            mode,
            manifest: JSON.parse(await readFile(flags['--manifest'], 'utf8')),
            proofs,
            trust,
            registry,
          }),
          null,
          2,
        ),
      )
    } catch {
      console.error(
        'Legacy migration refused; no source credentials or database error details are emitted. Inspect the manifest and run the isolated verification suite.',
      )
      process.exitCode = 1
    } finally {
      await client.end()
    }
  }
}
