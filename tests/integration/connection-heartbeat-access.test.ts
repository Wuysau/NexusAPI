import { isDeepStrictEqual } from 'node:util'
import { afterAll, beforeEach, expect, it } from 'vitest'
import { pool } from '@/db'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { GET as listConnections } from '@/app/api/connections/route'
import { POST as heartbeat } from '@/app/api/connections/[id]/heartbeat/route'

// Destructive setup is limited to the named disposable fixture or serial CI.
if (!process.env.DATABASE_URL) throw new Error('Explicit independent DATABASE_URL required')
let target: URL
try {
  target = new URL(process.env.DATABASE_URL)
} catch {
  throw new Error('Invalid independent DATABASE_URL')
}
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.port !== '55439' ||
  !['/workspace_access_heartbeat_round56', '/convergence_ci15'].includes(target.pathname) ||
  process.env.DATABASE_URL.includes('?') ||
  process.env.DATABASE_URL.includes('#') ||
  process.env.NODE_ENV === 'production'
)
  throw new Error('Dedicated loopback connection heartbeat database required')
const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
const tenant = 'heartbeat-tenant'
const organization = 'heartbeat-org'
const project = 'heartbeat-visible-project'
const originalCapabilities = { operations: ['chat'], custom: { preserved: true } }
const changedCapabilities = { operations: ['embeddings'], custom: { reported: true }, arbitrary: ['saved'] }
const csrf = 'heartbeat-synthetic-csrf'
const roles = ['viewer', 'billing', 'developer', 'admin'] as const
type Role = (typeof roles)[number]
let cookies: Record<Role, string>
const observations: Record<string, unknown>[] = []
const tables = [
  'organizations',
  'users',
  'sessions',
  'organization_memberships',
  'project_memberships',
  'projects',
  'providers',
  'owned_connections',
  'channels',
  'provider_credentials',
  'connector_pairings',
  'connector_identities',
  'connector_leases',
  'audit_events',
  'request_records',
  'attempts',
  'usage_events',
  'usage_records',
  'outbox_events',
  'ledger_transactions',
  'ledger_postings',
  'wallet_ledger_entries',
] as const
type Facts = Record<(typeof tables)[number], Record<string, unknown>[]>
const userId = (role: Role) => `heartbeat-${role}`
const connectionId = (name: string) => `heartbeat-${name}`
const params = (name: string) => ({ params: Promise.resolve({ id: connectionId(name) }) })
const request = (role: Role, name: string, body?: unknown, withCsrf = true) =>
  new Request(`http://localhost/api/connections/${connectionId(name)}/heartbeat`, {
    method: 'POST',
    headers: {
      cookie: `${cookies[role]}; nexus_csrf=${csrf}`,
      ...(withCsrf ? { 'x-csrf-token': csrf } : {}),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const report = { status: 'reported', capabilities: changedCapabilities }

beforeEach(async () => {
  expect((await pool.query('SELECT current_database() AS name')).rows[0].name).toBe(target.pathname.slice(1))
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  expect((await runMigrations(pool)).total).toBe(28)
  await pool.query(
    `INSERT INTO organizations(id,tenant_id,name,slug) VALUES
      ($1,$2,'Heartbeat fixture','heartbeat-org'),
      ('heartbeat-foreign-org','heartbeat-foreign-tenant','Other tenant','heartbeat-foreign-org')`,
    [organization, tenant],
  )
  cookies = {} as Record<Role, string>
  for (const role of roles) {
    await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
      userId(role),
      `${role}@heartbeat.example.invalid`,
      'synthetic-unused-password-hash',
    ])
    await pool.query(
      'INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,$3,$4)',
      [organization, tenant, userId(role), role],
    )
    cookies[role] = `${SESSION_COOKIE}=${(await createSession({ userId: userId(role) })).token}`
  }
  await pool.query(
    `INSERT INTO projects(id,tenant_id,organization_id,name) VALUES
      ($1,$2,$3,'Visible project'),
      ('heartbeat-private-project',$2,$3,'Private project'),
      ('heartbeat-foreign-project','heartbeat-foreign-tenant','heartbeat-foreign-org','Other tenant project')`,
    [project, tenant, organization],
  )
  for (const role of ['viewer', 'developer'] as const)
    await pool.query('INSERT INTO project_memberships(tenant_id,project_id,user_id) VALUES($1,$2,$3)', [
      tenant,
      project,
      userId(role),
    ])
  for (const [name, scope, binding, owner, mode] of [
    ['visible', tenant, project, userId('admin'), 'external_endpoint'],
    ['private', tenant, 'heartbeat-private-project', userId('admin'), 'external_endpoint'],
    ['own-unbound', tenant, null, userId('developer'), 'customer_vpc_runner'],
    ['other-unbound', tenant, null, userId('admin'), 'direct_api'],
    ['foreign', 'heartbeat-foreign-tenant', 'heartbeat-foreign-project', null, 'external_endpoint'],
    ['revoked', tenant, project, userId('admin'), 'external_endpoint'],
    ['local', tenant, project, userId('admin'), 'local_sidecar'],
  ]) {
    await pool.query(
      `INSERT INTO owned_connections(id,tenant_id,project_id,owner_user_id,provider,mode,status,capabilities)
       VALUES($1,$2,$3,$4,$5,$6,'active',$7::jsonb)`,
      [
        connectionId(String(name)),
        scope,
        binding,
        owner,
        mode === 'local_sidecar' ? 'ollama' : 'fixture',
        mode,
        JSON.stringify(originalCapabilities),
      ],
    )
  }
  await pool.query("UPDATE owned_connections SET status='revoked',revoked_at=now() WHERE id=$1", [
    connectionId('revoked'),
  ])
}, 30000)

afterAll(async () => {
  // No URLs, session tokens, full rows or caller-controlled text are printed.
  if (process.env.NEXUS_HEARTBEAT_AUDIT_REPORT === '1')
    console.info('Heartbeat access safe observations:', JSON.stringify(observations))
  await bounded(pool.end(), 'Heartbeat fixture pool close', 5000)
})

async function bounded<T>(promise: Promise<T>, label: string, timeout = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeout)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
async function facts(): Promise<Facts> {
  const result = {} as Facts
  for (const table of tables)
    result[table] = (
      await pool.query(`SELECT * FROM ${table} ORDER BY ${table === 'connector_pairings' ? 'connection_id' : 'id'}`)
    ).rows
  return result
}
const same = (actual: unknown, expected: unknown, label: string) =>
  expect(isDeepStrictEqual(actual, expected), label).toBe(true)
const withoutAudit = (value: Facts) =>
  Object.fromEntries(tables.filter((table) => table !== 'audit_events').map((table) => [table, value[table]]))
const successfulAudits = (value: Facts) => value.audit_events.filter((row) => row.action === 'connection.heartbeat')
async function listed(role: Role): Promise<string[]> {
  const response = await listConnections(
    new Request('http://localhost/api/connections', { headers: { cookie: cookies[role] } }),
  )
  expect(response.status).toBe(200)
  return (await response.json()).connections.map((row: { id: string }) => row.id)
}
async function observe(name: string, before: Facts, response: Response) {
  const after = await facts()
  const body = await response.json()
  observations.push({
    name,
    status: response.status,
    code: ['forbidden', 'not_found', 'csrf_failed', 'connector_identity_required'].includes(body.error?.code)
      ? body.error.code
      : null,
    domainUnchanged: isDeepStrictEqual(withoutAudit(after), withoutAudit(before)),
    completeFactsUnchanged: isDeepStrictEqual(after, before),
    successfulAuditDelta: successfulAudits(after).length - successfulAudits(before).length,
    changedConnections: after.owned_connections.filter(
      (row, index) => !isDeepStrictEqual(row, before.owned_connections[index]),
    ).length,
  })
  return { after, body }
}
async function denied(role: Role, name: string, status: number, code: string) {
  const before = await facts()
  const response = await heartbeat(request(role, name, report), params(name))
  const { after, body } = await observe(`${role}_${name}`, before, response)
  expect(response.status).toBe(status)
  expect(body.error?.code).toBe(code)
  same(after, before, 'Denied heartbeat preserves complete facts and success audits')
}

it.each(['viewer', 'billing'] as const)(
  'rejects %s writes even when the connection is actually visible',
  async (role) => {
    expect((await listed(role)).includes(connectionId('visible'))).toBe(true)
    await denied(role, 'visible', 403, 'forbidden')
  },
)

it.each(['private', 'other-unbound'])('rejects a developer heartbeat for invisible %s connection', async (name) => {
  expect((await listed('developer')).includes(connectionId('visible'))).toBe(true)
  expect((await listed('developer')).includes(connectionId(name))).toBe(false)
  await denied('developer', name, 404, 'not_found')
})

async function accepted(role: Role, name: string, body: unknown, status: string, capabilities: unknown) {
  const before = await facts()
  const response = await heartbeat(request(role, name, body), params(name))
  const { after, body: result } = await observe(`${role}_${name}_accepted`, before, response)
  expect(response.status).toBe(200)
  expect(result.connection.id).toBe(connectionId(name))
  expect(result.connection.status).toBe(status)
  expect(typeof result.connection.last_heartbeat_at).toBe('string')
  const updated = after.owned_connections.find((row) => row.id === connectionId(name))!
  expect(updated.status).toBe(status)
  expect(updated.last_heartbeat_at instanceof Date).toBe(true)
  same(updated.capabilities, capabilities, 'Accepted heartbeat retains exact supplied capabilities')
  for (const table of tables.filter((table) => table !== 'owned_connections' && table !== 'audit_events'))
    same(after[table], before[table], 'Heartbeat changes no other domain table')
  same(
    after.owned_connections.filter((row) => row.id !== updated.id),
    before.owned_connections.filter((row) => row.id !== updated.id),
    'Other connections remain unchanged',
  )
  expect(successfulAudits(after).length - successfulAudits(before).length).toBe(1)
  const audit = successfulAudits(after).at(-1)!
  expect(audit.target_id).toBe(connectionId(name))
  expect(audit.actor_user_id).toBe(userId(role))
  expect(audit.tenant_id).toBe(tenant)
}

it('allows a developer project member to report custom status and capabilities', async () => {
  expect((await listed('developer')).includes(connectionId('visible'))).toBe(true)
  await accepted('developer', 'visible', report, 'reported', changedCapabilities)
})
it('allows the owner of an unbound connection and preserves omitted-body defaults', async () => {
  expect((await listed('developer')).includes(connectionId('own-unbound'))).toBe(true)
  await accepted('developer', 'own-unbound', undefined, 'healthy', originalCapabilities)
})
it('retains privileged administrator access to another owner’s unbound connection', async () => {
  expect((await listed('admin')).includes(connectionId('other-unbound'))).toBe(true)
  await accepted('admin', 'other-unbound', report, 'reported', changedCapabilities)
})
it.each(['foreign', 'revoked'])('keeps the %s connection immutable with a 404', async (name) => {
  await denied('admin', name, 404, 'not_found')
})
it('keeps the local connector identity boundary for an authorized administrator', async () => {
  expect((await listed('admin')).includes(connectionId('local'))).toBe(true)
  await denied('admin', 'local', 403, 'connector_identity_required')
})
it('preserves the existing CSRF rejection audit without heartbeat mutation', async () => {
  const before = await facts()
  const response = await heartbeat(request('developer', 'visible', report, false), params('visible'))
  expect(response.status).toBe(403)
  // CSRF telemetry is deliberately asynchronous; wait for its actual audit.
  await expect
    .poll(
      async () => (await pool.query("SELECT count(*)::int n FROM audit_events WHERE action='csrf.rejected'")).rows[0].n,
      { timeout: 3000 },
    )
    .toBe(1)
  const { after, body } = await observe('csrf_denial', before, response)
  expect(body.error?.code).toBe('csrf_failed')
  same(withoutAudit(after), withoutAudit(before), 'CSRF denial preserves all domain facts')
  same(successfulAudits(after), successfulAudits(before), 'CSRF denial appends no heartbeat success audit')
  expect(after.audit_events.length - before.audit_events.length).toBe(1)
})

it.each([true, false])(
  'delayed native body retains UPDATE membership checks (removed=%s)',
  async (removeMembership) => {
    let release!: () => void, entered!: () => void
    const bodyGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const bodyEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          entered()
          await bodyGate
          controller.enqueue(new TextEncoder().encode(JSON.stringify(report)))
          controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    const req = new Request(request('developer', 'visible'), { body: stream, duplex: 'half' } as RequestInit & {
      duplex: 'half'
    })
    const pending = heartbeat(req, params('visible'))
    void pending.catch(() => {})
    try {
      await bounded(bodyEntered, 'Native request body must follow initial lookup')
      if (removeMembership) {
        const removed = await pool.query(
          'DELETE FROM project_memberships WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3',
          [tenant, project, userId('developer')],
        )
        expect(removed.rowCount).toBe(1)
      }
      const before = await facts()
      release()
      const response = await bounded(pending, 'Heartbeat completes after body release')
      const { after, body } = await observe(
        removeMembership ? 'membership_removed_during_body' : 'membership_retained_during_body',
        before,
        response,
      )
      if (removeMembership) {
        expect(response.status).toBe(404)
        expect(body.error?.code).toBe('not_found')
        same(after, before, 'Removed membership cannot mutate a connection after initial lookup')
      } else {
        expect(response.status).toBe(200)
        expect(body.connection.id).toBe(connectionId('visible'))
        expect(body.connection.status).toBe('reported')
        const updated = after.owned_connections.find((row) => row.id === connectionId('visible'))!
        same(updated.capabilities, changedCapabilities, 'Unchanged membership permits the exact report')
        expect(updated.last_heartbeat_at instanceof Date).toBe(true)
        expect(successfulAudits(after).length - successfulAudits(before).length).toBe(1)
      }
    } finally {
      release()
      await bounded(pending, 'Delayed heartbeat cleanup')
    }
  },
)
