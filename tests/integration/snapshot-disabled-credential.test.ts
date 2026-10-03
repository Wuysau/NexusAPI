import { createHmac } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { pool } from '@/db'
import { buildKeyring, sha256hex } from '@/lib/crypto'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { buildSnapshotPayload, canonicalJson, signSnapshot } from '@/lib/catalog/snapshot'
import { GET as session } from '@/app/api/auth/session/route'
import { POST as createChannel } from '@/app/api/channels/route'
import { DELETE as deleteChannel, PATCH as patchChannel } from '@/app/api/channels/[id]/route'
import { GET as resources } from '@/app/api/resources/route'
import { GET as snapshot } from '@/app/api/internal/gateway/snapshot/route'

// Destructive setup accepts only this independent fixture or the verified serial CI database.
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('Explicit independent DATABASE_URL required')
let target: URL
try {
  target = new URL(databaseUrl)
} catch {
  throw new Error('Invalid independent DATABASE_URL')
}
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.port !== '55439' ||
  !['/gateway_test_disabled_credential_round64', '/convergence_ci15'].includes(target.pathname) ||
  databaseUrl.includes('?') ||
  databaseUrl.includes('#') ||
  process.env.NODE_ENV === 'production'
)
  throw new Error('Dedicated loopback disabled credential database required')
const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
const tenant = 'disabled-credential-tenant'
const organization = 'disabled-credential-org'
const administrator = 'disabled-credential-admin'
const provider = 'disabled-credential-provider'
const sharedCredential = 'disabled-credential-shared'
const independentCredential = 'disabled-credential-independent'
const csrf = 'disabled-credential-csrf'
const internalToken = 'snapshot-test-token'
const signing = 'snapshot-test-signing-key'
const keyring = buildKeyring({ upstreamEncryptionKey: signing })
const observations: Record<string, unknown>[] = []
let cookie: string
const tables = [
  'organizations',
  'users',
  'sessions',
  'organization_memberships',
  'projects',
  'project_memberships',
  'project_workspace_roots',
  'downstream_api_keys',
  'owned_connections',
  'providers',
  'channels',
  'provider_credentials',
  'connector_pairings',
  'connector_identities',
  'connector_leases',
  'quota_snapshots',
  'external_observed_usage',
  'audit_events',
  'gateway_snapshots',
  'upstream_models',
  'model_aliases',
  'request_records',
  'attempts',
  'usage_events',
  'usage_records',
  'outbox_events',
  'ledger_transactions',
  'ledger_postings',
  'wallet_ledger_entries',
] as const
type Row = Record<string, unknown>
type Facts = Record<(typeof tables)[number], Row[]>
interface Bundle extends Row {
  channels: Row[]
  models: unknown[]
  keys: unknown[]
}
interface SnapshotRead {
  status: number
  body: { bundle?: Bundle; signature?: string; signing_key_id?: string; error?: { code: string; message: string } }
}
const same = (actual: unknown, expected: unknown, label: string) =>
  expect(isDeepStrictEqual(actual, expected), label).toBe(true)
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const request = (method: string, path: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: {
      cookie: `${cookie}; nexus_csrf=${csrf}`,
      'x-csrf-token': csrf,
      'content-type': 'application/json',
      'x-forwarded-for': '127.0.0.1',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

beforeAll(() => {
  vi.stubEnv('GATEWAY_INTERNAL_TOKEN', internalToken)
  vi.stubEnv('SNAPSHOT_SIGNING_KEY', signing)
  vi.stubEnv('SNAPSHOT_SIGNING_KEY_VERSION', '1')
  vi.stubEnv('SNAPSHOT_SIGNING_KEY_PREVIOUS', '')
  vi.stubEnv('NEXUS_DESKTOP_ORIGIN', '')
  vi.stubEnv('NEXUS_CONNECTORS_ENABLED', 'false')
})

beforeEach(async () => {
  expect((await pool.query('SELECT current_database() AS name')).rows[0].name === target.pathname.slice(1)).toBe(true)
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  expect((await runMigrations(pool)).total).toBe(28)
  // The canonical schema permits one organization per tenant.
  await pool.query(
    `INSERT INTO organizations(id,tenant_id,name,slug) VALUES
      ($1,$2,'Disabled credential fixture','disabled-credential-org'),
      ('disabled-credential-other-org','disabled-credential-other-tenant','Other tenant','disabled-credential-other-org')`,
    [organization, tenant],
  )
  await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    administrator,
    'admin@disabled-credential.example.invalid',
    'synthetic-unused-password-hash',
  ])
  await pool.query(
    "INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,$3,'admin')",
    [organization, tenant, administrator],
  )
  cookie = `${SESSION_COOKIE}=${(await createSession({ userId: administrator })).token}`
  const response = await session(request('GET', '/api/auth/session'))
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.authenticated && body.freshAuth && body.role === 'admin').toBe(true)
  expect(body.capabilities.includes('credential:create') && body.capabilities.includes('credential:disable')).toBe(true)
  await pool.query(
    `INSERT INTO providers(id,code,name,official_base_url,auth_scheme) VALUES
      ($1,$1,'Fixture provider','https://example.invalid','bearer'),
      ('disabled-credential-other-provider','disabled-credential-other-provider','Other provider','https://example.invalid','bearer')`,
    [provider],
  )
  // A retained key makes accidental directory changes visible; no plaintext key is generated.
  await pool.query(
    `INSERT INTO downstream_api_keys(id,organization_id,tenant_id,name,hash,prefix,scopes,created_by)
      VALUES('disabled-credential-history',$1,$2,'Synthetic history',$3,'test',$4::jsonb,$5)`,
    [organization, tenant, sha256hex('disabled-credential-history'), JSON.stringify(['models:read']), administrator],
  )
  const signed = signSnapshot(
    buildSnapshotPayload({ tenantId: tenant, sequenceNumber: 1, priceVersions: [], routingPolicies: [] }),
    keyring,
  )
  await pool.query(
    `INSERT INTO gateway_snapshots(id,tenant_id,sequence_number,signature,signing_key_id,payload)
      VALUES('disabled-credential-snapshot',$1,1,$2,$3,$4::jsonb)`,
    [tenant, signed.signature, signed.signingKeyId, JSON.stringify(signed.payload)],
  )
}, 30000)

afterAll(async () => {
  if (process.env.NEXUS_DISABLED_CREDENTIAL_AUDIT_REPORT === '1')
    console.info('Disabled credential safe observations:', JSON.stringify(observations))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      pool.end(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Disabled credential fixture pool close timeout')), 5000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    vi.unstubAllEnvs()
  }
})

async function facts(): Promise<Facts> {
  const result = {} as Facts
  for (const table of tables) {
    const order =
      table === 'connector_pairings'
        ? 'connection_id'
        : table === 'project_workspace_roots'
          ? 'tenant_id,organization_id,root'
          : 'id'
    result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows
  }
  return result
}

async function channel(name: string, credentialId = sharedCredential): Promise<string> {
  const response = await createChannel(
    request('POST', '/api/channels', {
      name,
      provider,
      credentialId,
      credentialVersion: 1,
      capabilities: ['chat'],
      priority: name === 'Independent C' ? 10 : 0,
      weight: 10,
    }),
  )
  expect(response.status, 'Real external reference channel creation').toBe(201)
  const body = await response.json()
  expect(typeof body.channel?.id === 'string').toBe(true)
  expect(body.channel.credential?.id === credentialId && body.channel.credential?.enabled === true).toBe(true)
  return body.channel.id
}

async function readSnapshot(local = false): Promise<SnapshotRead> {
  const response = await snapshot(
    new Request(`http://localhost/api/internal/gateway/snapshot?tenant_id=${tenant}`, {
      headers: { authorization: `Bearer ${internalToken}`, ...(local ? { host: 'localhost:3000' } : {}) },
    }),
  )
  expect(response.headers.get('cache-control') === 'no-store' || response.status !== 200).toBe(true)
  return { status: response.status, body: await response.json() }
}

function signedBundle(read: SnapshotRead, ids: string[]): Bundle {
  expect(read.status, 'Signed snapshot status').toBe(200)
  if (!read.body.bundle) throw new Error('Signed fixture bundle missing')
  const bundle = read.body.bundle
  same(bundle.channels.map((row) => row.id).sort(), [...ids].sort(), 'Exact signed channel identities')
  expect(read.body.signing_key_id === 'hmac-sha256:v1').toBe(true)
  expect(
    read.body.signature === createHmac('sha256', keyring.current.key).update(canonicalJson(bundle)).digest('hex'),
    'Actual canonical bundle HMAC',
  ).toBe(true)
  expect(bundle.tenant_id === tenant && bundle.keys.length === 1 && bundle.models.length === 0).toBe(true)
  return bundle
}

function sameRetainedBundle(before: Bundle, after: Bundle, retained: string[]) {
  same(
    after.channels,
    before.channels.filter((row) => retained.includes(String(row.id))),
    'Retained signed channel fields unchanged',
  )
  const stable = ({ generated_at: _generated, expires_at: _expires, channels: _channels, ...rest }: Bundle) => rest
  same(stable(after), stable(before), 'Nested snapshot, keys, models and other signed facts unchanged')
}

async function resourceStates(expected: Array<{ id: string; credentialId: string; status: 'active' | 'disabled' }>) {
  const response = await resources(request('GET', '/api/resources'))
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const body = await response.json()
  expect(Array.isArray(body.resources) && body.resources.length === expected.length).toBe(true)
  for (const item of expected) {
    const row = body.resources.find((resource: Row) => resource.id === `channel:${item.id}`)
    expect(
      row?.channelId === item.id &&
        row?.accountId === item.credentialId &&
        row?.connectionId === null &&
        row?.status === item.status &&
        row?.health === 'unknown' &&
        row?.quotaState === 'unknown' &&
        row?.routingStatus === (item.status === 'active' ? 'configured' : 'not_configured'),
      'Resource identity, configuration status and unknown health',
    ).toBe(true)
  }
}

function mutations(
  before: Facts,
  after: Facts,
  changes: Array<{ table: 'channels' | 'provider_credentials'; id: string }>,
  audits: Array<{ action: string; target_type: string; target_id: string; metadata: Row }>,
) {
  for (const table of tables) {
    if (table === 'audit_events') continue
    const expected = before[table].map((row) => {
      if (!changes.some((change) => change.table === table && change.id === row.id)) return row
      const current = after[table].find((candidate) => candidate.id === row.id)
      expect(current?.updated_at instanceof Date && row.updated_at instanceof Date).toBe(true)
      expect((current!.updated_at as Date).getTime() >= (row.updated_at as Date).getTime()).toBe(true)
      return { ...row, enabled: false, updated_at: current!.updated_at }
    })
    same(after[table], expected, `Only expected ${table} facts changed`)
  }
  const originalIds = new Set(before.audit_events.map((row) => row.id))
  same(
    after.audit_events.filter((row) => originalIds.has(row.id)),
    before.audit_events,
    'Prior audits retained exactly',
  )
  const added = after.audit_events.filter((row) => !originalIds.has(row.id))
  expect(added.length).toBe(audits.length)
  same(
    added
      .map((row) => ({
        actor_user_id: row.actor_user_id,
        tenant_id: row.tenant_id,
        action: row.action,
        target_type: row.target_type,
        target_id: row.target_id,
        metadata: row.metadata,
      }))
      .sort((a, b) => String(a.action).localeCompare(String(b.action))),
    audits
      .map((audit) => ({ actor_user_id: administrator, tenant_id: tenant, ...audit }))
      .sort((a, b) => a.action.localeCompare(b.action)),
    'Exactly the legitimate management audits',
  )
}

it('publishes the healthy independent channel after real deletion disables a shared credential', async () => {
  const a = await channel('Shared A')
  const b = await channel('Shared B')
  const c = await channel('Independent C', independentCredential)
  const baseline = signedBundle(await readSnapshot(), [a, b, c])
  const before = await facts()
  expect(before.channels.length === 3 && before.provider_credentials.length === 2).toBe(true)
  await resourceStates([
    { id: a, credentialId: sharedCredential, status: 'active' },
    { id: b, credentialId: sharedCredential, status: 'active' },
    { id: c, credentialId: independentCredential, status: 'active' },
  ])
  same(await facts(), before, 'Baseline resource and snapshot reads are pure')
  const deleted = await deleteChannel(request('DELETE', `/api/channels/${a}`), params(a))
  expect(deleted.status).toBe(200)
  const deletedBody = await deleted.json()
  expect(deletedBody.id === a && deletedBody.disabled === true).toBe(true)
  const afterDelete = await facts()
  mutations(
    before,
    afterDelete,
    [
      { table: 'channels', id: a },
      { table: 'provider_credentials', id: sharedCredential },
    ],
    [
      {
        action: 'credential.disabled',
        target_type: 'provider_credential',
        target_id: sharedCredential,
        metadata: { reason: 'channel removed' },
      },
      {
        action: 'channel.disabled',
        target_type: 'channel',
        target_id: a,
        metadata: { credentialId: sharedCredential },
      },
    ],
  )
  await resourceStates([
    { id: a, credentialId: sharedCredential, status: 'disabled' },
    { id: b, credentialId: sharedCredential, status: 'disabled' },
    { id: c, credentialId: independentCredential, status: 'active' },
  ])
  const afterDisabled = await readSnapshot()
  same(await facts(), afterDelete, 'Disabled resource and snapshot reads are pure')
  // Observe supported pause recovery before the desired assertion can fail on the old implementation.
  const paused = await patchChannel(request('PATCH', `/api/channels/${b}`, { enabled: false }), params(b))
  expect(paused.status).toBe(200)
  const afterPause = await facts()
  mutations(
    afterDelete,
    afterPause,
    [{ table: 'channels', id: b }],
    [{ action: 'channel.updated', target_type: 'channel', target_id: b, metadata: { fields: ['enabled'] } }],
  )
  const recovered = signedBundle(await readSnapshot(), [c])
  sameRetainedBundle(baseline, recovered, [c])
  same(await facts(), afterPause, 'Recovered snapshot read is pure')
  observations.push({
    case: 'real-shared-delete',
    baselineStatus: 200,
    baselineChannels: 3,
    deleteStatus: deleted.status,
    disabledSnapshotStatus: afterDisabled.status,
    disabledSigned: typeof afterDisabled.body.signature === 'string',
    recoveryStatus: 200,
    recoveryChannels: recovered.channels.length,
    deleteAudits: afterDelete.audit_events.length - before.audit_events.length,
    pauseAudits: afterPause.audit_events.length - afterDelete.audit_events.length,
    readsPure: true,
  })
  sameRetainedBundle(baseline, signedBundle(afterDisabled, [c]), [c])
})

it.each(['tenant', 'platform'] as const)(
  'omits an explicitly disabled, correctly bound %s credential',
  async (scope) => {
    const c = await channel('Independent C', independentCredential)
    let disabled: string
    if (scope === 'tenant') disabled = await channel('Operator disabled')
    else {
      // Platform credentials cannot be mutated through a customer route; this is a canonical operator fixture.
      await pool.query(
        `INSERT INTO provider_credentials(id,provider_id,name,encrypted_secret,is_platform_managed)
        VALUES($1,$2,'Synthetic platform reference','external-registry:v1',true)`,
        [sharedCredential, provider],
      )
      disabled = 'disabled-credential-platform-channel'
      await pool.query(
        `INSERT INTO channels(id,provider_id,provider_credential_id,name,capabilities)
        VALUES($1,$2,$3,'Platform channel','["chat"]')`,
        [disabled, provider, sharedCredential],
      )
    }
    const baseline = signedBundle(await readSnapshot(), [disabled, c])
    await pool.query('UPDATE provider_credentials SET enabled=false WHERE id=$1', [sharedCredential])
    const before = await facts()
    await resourceStates([
      { id: disabled, credentialId: sharedCredential, status: 'disabled' },
      { id: c, credentialId: independentCredential, status: 'active' },
    ])
    const observed = await readSnapshot()
    same(await facts(), before, 'Correctly bound disabled reference reads are pure')
    observations.push({
      case: `${scope}-disabled`,
      snapshotStatus: observed.status,
      signed: typeof observed.body.signature === 'string',
      readsPure: true,
    })
    sameRetainedBundle(baseline, signedBundle(observed, [c]), [c])
  },
)

it.each(['tenant', 'provider', 'organization', 'null-organization', 'connection'] as const)(
  'still refuses a disabled credential with invalid %s identity',
  async (kind) => {
    const invalid = await channel('Invalid identity')
    const c = await channel('Independent C', independentCredential)
    signedBundle(await readSnapshot(), [invalid, c])
    if (kind === 'tenant')
      await pool.query("UPDATE provider_credentials SET tenant_id='disabled-credential-other-tenant' WHERE id=$1", [
        sharedCredential,
      ])
    if (kind === 'provider')
      await pool.query("UPDATE provider_credentials SET provider_id='disabled-credential-other-provider' WHERE id=$1", [
        sharedCredential,
      ])
    if (kind === 'organization')
      await pool.query("UPDATE provider_credentials SET organization_id='disabled-credential-other-org' WHERE id=$1", [
        sharedCredential,
      ])
    if (kind === 'null-organization')
      await pool.query('UPDATE provider_credentials SET organization_id=NULL WHERE id=$1', [sharedCredential])
    await pool.query('UPDATE provider_credentials SET enabled=false WHERE id=$1', [sharedCredential])
    const metadata: Row[] = [{}]
    if (kind === 'connection') {
      await pool.query(
        `INSERT INTO owned_connections(id,tenant_id,provider,mode,status,revoked_at) VALUES
          ('disabled-credential-foreign-connection','disabled-credential-other-tenant',$1,'external_endpoint','active',NULL),
          ('disabled-credential-revoked-connection',$2,$1,'external_endpoint','active',now())`,
        [provider, tenant],
      )
      metadata.splice(
        0,
        1,
        { connection_id: 'disabled-credential-foreign-connection' },
        { connection_id: 'disabled-credential-revoked-connection' },
        { connection_id: 'disabled-credential-missing-connection' },
        { connection_id: null },
        { connection_id: 42 },
      )
    }
    for (const value of metadata) {
      if (kind === 'connection')
        await pool.query('UPDATE channels SET metadata=$1::jsonb WHERE id=$2', [JSON.stringify(value), invalid])
      const before = await facts()
      const observed = await readSnapshot()
      expect(observed.status).toBe(500)
      same(
        observed.body,
        { error: { code: 'internal_error', message: 'Snapshot identity validation failed.' } },
        'Fixed unsigned identity failure',
      )
      same(await facts(), before, 'Invalid identity snapshot read is pure')
    }
    observations.push({
      case: `invalid-${kind}`,
      snapshotStatus: 500,
      checks: metadata.length,
      signed: false,
      readsPure: true,
    })
  },
)

it('preserves the legacy channel with a null credential reference', async () => {
  const c = await channel('Independent C', independentCredential)
  const legacy = 'disabled-credential-null-reference'
  await pool.query(
    `INSERT INTO channels(id,tenant_id,provider_id,name,capabilities) VALUES($1,$2,$3,'Legacy empty reference','["chat"]')`,
    [legacy, tenant, provider],
  )
  const before = await facts()
  const bundle = signedBundle(await readSnapshot(), [legacy, c])
  const row = bundle.channels.find((candidate) => candidate.id === legacy)
  expect(row?.credential_mode === 'managed' && row?.credential_ref === '' && row?.credential_fingerprint === '').toBe(
    true,
  )
  same(await facts(), before, 'Legacy null reference snapshot read is pure')
  observations.push({
    case: 'legacy-null-reference',
    snapshotStatus: 200,
    channels: bundle.channels.length,
    readsPure: true,
  })
})

it('omits a valid disabled local binding while still rejecting malformed local version and capabilities', async () => {
  const local = await channel('Local binding')
  const connection = 'disabled-credential-local-connection'
  await pool.query(
    `INSERT INTO owned_connections(id,tenant_id,provider,mode,status,credential_ref)
      VALUES($1,$2,$3,'external_endpoint','active',$4)`,
    [connection, tenant, provider, sharedCredential],
  )
  const metadata = {
    credential_storage: 'local',
    credential_version: 1,
    connection_id: connection,
    base_url: 'http://127.0.0.1:11434/v1',
    protocol: 'openai',
    model: 'fixture-model',
  }
  await pool.query('UPDATE channels SET metadata=$1::jsonb WHERE id=$2', [JSON.stringify(metadata), local])
  vi.stubEnv('NEXUS_DESKTOP_ORIGIN', 'http://localhost:3000')
  try {
    const healthy = await readSnapshot(true)
    expect(healthy.status).toBe(200)
    expect(
      healthy.body.bundle?.channels.length === 1 &&
        healthy.body.bundle.channels[0].id === local &&
        healthy.body.bundle.models.length === 1,
    ).toBe(true)
    expect(
      healthy.body.signature ===
        createHmac('sha256', keyring.current.key).update(canonicalJson(healthy.body.bundle)).digest('hex'),
    ).toBe(true)
    await pool.query('UPDATE provider_credentials SET enabled=false WHERE id=$1', [sharedCredential])
    const beforeDisabled = await facts()
    const disabled = await readSnapshot(true)
    same(await facts(), beforeDisabled, 'Valid disabled local snapshot read is pure')
    const versions = [undefined, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]
    for (const version of versions) {
      await pool.query('UPDATE channels SET metadata=$1::jsonb WHERE id=$2', [
        JSON.stringify({ ...metadata, credential_version: version }),
        local,
      ])
      const before = await facts()
      const invalid = await readSnapshot(true)
      expect(invalid.status).toBe(500)
      same(
        invalid.body,
        { error: { code: 'internal_error', message: 'Local snapshot identity validation failed.' } },
        'Malformed local version still fails without a signature',
      )
      same(await facts(), before, 'Malformed local version read is pure')
    }
    await pool.query('UPDATE channels SET metadata=$1::jsonb WHERE id=$2', [JSON.stringify(metadata), local])
    for (const capabilities of [{ chat: true }, 'chat']) {
      await pool.query('UPDATE channels SET capabilities=$1::jsonb WHERE id=$2', [JSON.stringify(capabilities), local])
      const before = await facts()
      const invalid = await readSnapshot(true)
      expect(invalid.status).toBe(500)
      same(
        invalid.body,
        { error: { code: 'internal_error', message: 'Local snapshot identity validation failed.' } },
        'Malformed local capability shape still fails without a signature',
      )
      same(await facts(), before, 'Malformed local capability read is pure')
    }
    observations.push({
      case: 'local-disabled-and-invalid-shape',
      healthyStatus: healthy.status,
      disabledStatus: disabled.status,
      disabledSigned: typeof disabled.body.signature === 'string',
      invalidVersionChecks: versions.length,
      invalidCapabilityChecks: 2,
      invalidStatus: 500,
      readsPure: true,
    })
    expect(disabled.status, 'Valid disabled local snapshot status').toBe(200)
    expect(disabled.body.bundle?.channels.length === 0 && disabled.body.bundle.models.length === 0).toBe(true)
    expect(
      disabled.body.signature ===
        createHmac('sha256', keyring.current.key).update(canonicalJson(disabled.body.bundle)).digest('hex'),
    ).toBe(true)
  } finally {
    vi.stubEnv('NEXUS_DESKTOP_ORIGIN', '')
  }
})

it('keeps the canonical missing credential foreign key and existing signed channel intact', async () => {
  const valid = await channel('Valid identity')
  const before = await facts()
  let code: unknown
  try {
    await pool.query('UPDATE channels SET provider_credential_id=$1 WHERE id=$2', [
      'disabled-credential-missing',
      valid,
    ])
  } catch (error) {
    code = error && typeof error === 'object' && 'code' in error ? error.code : null
  }
  expect(code === '23503', 'Canonical foreign key rejects a dangling reference').toBe(true)
  same(await facts(), before, 'Rejected missing credential binding changes no facts')
  signedBundle(await readSnapshot(), [valid])
  same(await facts(), before, 'Post-rejection snapshot read is pure')
  observations.push({ case: 'missing-reference-fk', rejected: true, snapshotStatus: 200, readsPure: true })
})
