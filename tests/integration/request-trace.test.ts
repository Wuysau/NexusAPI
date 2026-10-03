import { Pool } from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/logs/[id]/trace/route'
import { pool as applicationPool } from '@/db'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { readRequestTrace } from '@/lib/billing/request-trace'
import { validateRequestTrace, type RequestTrace } from '../../packages/contracts/request-trace'

// This suite may reset only the new dedicated loopback fixture or the named CI
// convergence database; check the actual connection before touching schemas.
if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const url = new URL(process.env.DATABASE_URL)
if (
  !['postgres:', 'postgresql:'].includes(url.protocol) ||
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.port !== '55439' ||
  !['/convergence_trace_test', '/convergence_ci15'].includes(url.pathname) ||
  url.search ||
  url.hash
)
  throw new Error('Named disposable trace/CI database on loopback:55439 required')
const pool = new Pool({ connectionString: url.href })
const migrationModule = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationModule)
const cookies: Record<string, string> = {}
const canary = 'TRACE-CONTENT-SECRET-CANARY-NEVER-PUBLIC'
const canonical = (requestId: string, input: string | number | null = 4, schema = 2, overrides = {}) => ({
  schema_version: schema,
  tenant_id: 'trace-tenant',
  request_id: requestId,
  usage: {
    input_tokens: input,
    output_tokens: 2,
    cached_input_tokens: null,
    reasoning_tokens: null,
    total_tokens: input === null ? null : (BigInt(input) + 2n).toString(),
    estimated: false,
  },
  ...overrides,
})
async function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row)
  await pool.query(
    `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_, index) => `$${index + 1}`).join(',')})`,
    Object.values(row),
  )
}
async function recorded(
  id: string,
  project = 'project-a',
  organization = 'org-a',
  tenant = 'trace-tenant',
  frozen = true,
  frozenName = 'Original project name',
) {
  const scopedKey = frozen && tenant === 'trace-tenant' ? 'key-history' : null
  await insert('request_records', {
    id,
    tenant_id: tenant,
    organization_id: organization,
    request_model: 'requested-alias',
    channel_kind: 'byok',
    execution_mode: 'byok',
    downstream_key_id: scopedKey,
    status: 'completed',
    trace_id: `trace-${id}`,
    input_tokens: 123,
    output_tokens: 456,
    error_message: canary,
    started_at: '2026-10-04T00:00:00Z',
    completed_at: '2026-10-04T00:00:04Z',
  })
  if (frozen)
    await insert('request_project_facts', {
      request_id: id,
      tenant_id: tenant,
      organization_id: organization,
      project_id: project || null,
      project_name: frozenName,
      api_key_id: scopedKey,
      connection_id: tenant === 'trace-tenant' ? 'connection' : null,
      credential_id: tenant === 'trace-tenant' ? 'credential' : null,
      principal_id: canary,
      evidence_source: canary,
      evidence_digest: canary,
      execution_mode: 'byok',
      attribution_status: project ? 'attributed' : 'unattributed',
      requested_model: 'frozen-alias',
      policy_version_id: 'frozen-policy',
      catalog_version_id: 'frozen-catalog',
      price_version_id: 'frozen-price',
    })
}
async function attempt(requestId: string, number: number, overrides: Record<string, unknown> = {}) {
  await insert('attempts', {
    id: `${requestId}-${number}`,
    tenant_id: 'trace-tenant',
    request_id: requestId,
    attempt_number: number,
    status: 'completed',
    provider_id: 'provider',
    provider_credential_id: 'credential',
    channel_id: `channel-${number}`,
    connection_id: 'connection',
    resolved_model: `resolved-model-${number}`,
    execution_mode: 'byok',
    catalog_version_id: 'frozen-catalog',
    policy_version_id: 'frozen-policy',
    price_version_id: `price-${number}`,
    upstream_request_id: `provider-request-${number}`,
    error_message: canary,
    started_at: '2026-10-04T00:00:00Z',
    completed_at: '2026-10-04T00:00:01Z',
    ...overrides,
  })
}
async function event(
  id: string,
  requestId: string,
  attemptId: string | null,
  metering: Record<string, unknown> = canonical(requestId),
  overrides: Record<string, unknown> = {},
) {
  await insert('usage_events', {
    id,
    tenant_id: 'trace-tenant',
    request_id: requestId,
    attempt_id: attemptId,
    event_id: id,
    event_type: 'usage',
    payload: JSON.stringify({
      event: { ...metering, prompt: canary, response: canary, metadata: { secret: canary } },
      body: canary,
    }),
    created_at: '2026-10-04T00:00:02Z',
    ...overrides,
  })
}
async function get(id: string, role = 'owner') {
  const response = await GET(
    new Request(`http://localhost/api/logs/${encodeURIComponent(id)}/trace`, {
      headers: { cookie: cookies[role] ?? '', 'x-request-id': 'trace-route-check' },
    }),
    { params: Promise.resolve({ id }) },
  )
  expect(response.headers.get('cache-control')).toBe('no-store')
  return response
}
async function trace(id = 'visible', role = 'owner') {
  const response = await get(id, role)
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(validateRequestTrace(body)).toBe(true)
  return body as RequestTrace
}

beforeAll(async () => {
  expect((await pool.query('SELECT current_database() AS name')).rows[0]?.name).toBe(url.pathname.slice(1))
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES ('org-a','trace-tenant','A','trace-a'),('org-b','second-tenant','B','trace-b'),('foreign-org','foreign-tenant','Foreign','trace-foreign');
    INSERT INTO users(id,email,name,password_hash) VALUES ('owner','trace-owner@example.invalid','Owner','fixture'),('admin','trace-admin@example.invalid','Admin','fixture'),('billing','trace-billing@example.invalid','Billing','fixture'),('developer','trace-developer@example.invalid','Developer','fixture'),('viewer','trace-viewer@example.invalid','Viewer','fixture'),('no-membership','trace-none@example.invalid','None','fixture');
    INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES ('org-a','trace-tenant','owner','owner'),('org-b','second-tenant','owner','viewer'),('org-a','trace-tenant','admin','admin'),('org-a','trace-tenant','billing','billing'),('org-a','trace-tenant','developer','developer'),('org-a','trace-tenant','viewer','viewer');
    UPDATE organization_memberships SET created_at='2020-01-01' WHERE organization_id='org-a'; UPDATE organization_memberships SET created_at='2021-01-01' WHERE organization_id='org-b';
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES ('project-a','trace-tenant','org-a','A'),('project-hidden','trace-tenant','org-a','Hidden'),('project-b','second-tenant','org-b','B'),('deleted-project','trace-tenant','org-a','Deleted'),('foreign-project','foreign-tenant','foreign-org','Foreign');
    INSERT INTO project_memberships(project_id,tenant_id,user_id) VALUES ('project-a','trace-tenant','viewer'),('project-a','trace-tenant','developer'),('project-b','second-tenant','owner');
    INSERT INTO providers(id,code,name,official_base_url,auth_scheme) VALUES ('provider','trace-provider','Provider','https://example.invalid','bearer');
    INSERT INTO provider_credentials(id,provider_id,organization_id,tenant_id,name,encrypted_secret) VALUES ('credential','provider','org-a','trace-tenant','Credential','synthetic-trace-envelope');
    INSERT INTO channels(id,tenant_id,provider_id,provider_credential_id,name) VALUES ('channel-1','trace-tenant','provider','credential','First'),('channel-2','trace-tenant','provider','credential','Second'),('channel-3','trace-tenant','provider','credential','Third');
    INSERT INTO owned_connections(id,tenant_id,project_id,provider,mode,credential_ref) VALUES ('connection','trace-tenant','project-a','trace-provider','byok','synthetic-secret-ref');
    INSERT INTO downstream_api_keys(id,tenant_id,organization_id,project_id,name,hash,prefix) VALUES ('key-history','trace-tenant','org-a','project-a','Original key','trace-synthetic-hash','trace')`)
  for (const role of ['owner', 'admin', 'billing', 'developer', 'viewer', 'no-membership'])
    cookies[role] = `${SESSION_COOKIE}=${(await createSession({ userId: role })).token}`
  await recorded('visible')
  await attempt('visible', 1, { status: 'failed', error_code: 'provider_down', input_tokens: 987654 })
  await attempt('visible', 2)
  await attempt('visible', 3)
  await event('event-1', 'visible', 'visible-1', {
    ...canonical('visible', 0, 1),
    usage: { input_tokens: 0, output_tokens: 5 },
  })
  await event('event-2', 'visible', 'visible-2')
  await event('event-3', 'visible', 'visible-3', canonical('visible', 999))
  await insert('usage_records', {
    id: 'record-3',
    tenant_id: 'trace-tenant',
    request_id: 'visible',
    usage_event_id: 'event-3',
    authoritative_metering: JSON.stringify({ ...canonical('visible', '9007199254740993'), secret: canary }),
    frozen_pricing: JSON.stringify({ secret: canary }),
    charge_amount: '7',
    charge_currency: 'USD',
    upstream_cost_amount: '0',
    upstream_cost_currency: 'CNY',
  })
  await pool.query("UPDATE request_records SET charge_amount=11 WHERE id='visible'")
  await recorded('hidden', 'project-hidden')
  await recorded('org-b-request', 'project-b', 'org-b', 'second-tenant')
  await recorded('foreign', 'foreign-project', 'foreign-org', 'foreign-tenant')
  await recorded('deleted-history', 'deleted-project')
  await pool.query("DELETE FROM projects WHERE id='deleted-project'")
  await recorded('legacy-unanchored', '', 'org-a', 'trace-tenant', false)
  const legacy = {
    execution_mode: null,
    connection_id: null,
    resolved_model: null,
    price_version_id: null,
    catalog_version_id: null,
    policy_version_id: null,
  }
  await attempt('legacy-unanchored', 1, { ...legacy, input_tokens: 42, output_tokens: 5 })
  await recorded('unattributed', '')
  await recorded('missing-frozen', '', 'org-a', 'trace-tenant', false)
  await attempt('missing-frozen', 1, legacy)
  await event('missing-frozen-event', 'missing-frozen', 'missing-frozen-1')
  await insert('usage_records', {
    id: 'missing-frozen-record',
    tenant_id: 'trace-tenant',
    request_id: 'missing-frozen',
    usage_event_id: 'missing-frozen-event',
    authoritative_metering: JSON.stringify(canonical('missing-frozen', 99999)),
    charge_amount: 99,
  })
}, 30000)
afterAll(async () => {
  vi.restoreAllMocks()
  await pool.end()
})

it('uses native session routes and honors all organization roles plus explicit project membership', async () => {
  for (const role of ['owner', 'admin', 'billing', 'developer', 'viewer'])
    expect((await trace('visible', role)).request.project.id).toBe('project-a')
  for (const role of ['developer', 'viewer']) expect((await get('hidden', role)).status).toBe(404)
  for (const role of ['owner', 'admin', 'billing']) expect((await trace('hidden', role)).request.id).toBe('hidden')
  expect((await get('visible', 'anonymous')).status).toBe(401)
  expect((await get('visible', 'no-membership')).status).toBe(401)
})
it('returns the same no-store 404 for hidden, missing, foreign and invalid IDs', async () => {
  const bodies = []
  for (const id of ['hidden', 'missing', 'foreign', "request'OR'1'='1", 'x'.repeat(129)]) {
    const response = await get(id, 'viewer')
    expect(response.status).toBe(404)
    bodies.push(await response.json())
  }
  for (const body of bodies) expect(body).toEqual({ error: { code: 'tenant_isolation', message: 'Not found' } })
})
it('keeps a second-tenant membership outside the historical tenant scope', async () => {
  // The current production schema enforces one organization per tenant. Do not
  // drop that unique index just to fabricate a broader authorization fixture.
  expect((await get('org-b-request')).status).toBe(404)
  expect((await get('org-b-request', 'admin')).status).toBe(404)
})
it('shows every recorded attempt in order with distinct canonical zero/unknown usage and immutable pins', async () => {
  const value = await trace()
  expect(value.attempts.map((a) => a.id)).toEqual(['visible-1', 'visible-2', 'visible-3'])
  expect(value.attemptCount).toBe('3')
  expect(value.truncated).toBe(false)
  expect(value.attempts[0]).toMatchObject({
    status: 'failed',
    errorCode: 'provider_down',
    providerRequestId: 'provider-request-1',
    resolvedModel: 'resolved-model-1',
    pins: { policyVersionId: 'frozen-policy', catalogVersionId: 'frozen-catalog', priceVersionId: 'price-1' },
    usage: {
      source: 'event',
      schemaVersion: 1,
      inputTokens: '0',
      outputTokens: '5',
      cachedInputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
    },
    settlement: null,
  })
  expect(value.attempts[1].usage.inputTokens).toBe('4')
  expect(value.attempts[1].settlement).toBeNull()
  expect(value.attempts[2].usage).toMatchObject({
    source: 'worker',
    inputTokens: '9007199254740993',
    outputTokens: '2',
    totalTokens: '9007199254740995',
  })
  expect(value.attempts[2].settlement).toMatchObject({
    usageRecordId: 'record-3',
    chargeMicros: '7',
    upstreamCostMicros: '0',
    upstreamCostCurrency: 'CNY',
  })
  expect(value.request.usage).toEqual(value.attempts[2].usage)
  expect(value.request.settlement?.chargeMicros).toBe('11')
  expect(value.request.pins).toEqual({
    policyVersionId: 'frozen-policy',
    catalogVersionId: 'frozen-catalog',
    priceVersionId: 'frozen-price',
  })
  expect(value.request.taskId).toBeNull()
  expect(value.request.sessionId).toBeNull()
  expect(value.request.timing).toMatchObject({ durationMs: 4000, ttftMs: null, streamDurationMs: null })
})
it('does not infer usage or a zero charge from unanchored legacy defaults or nonzero counters', async () => {
  const value = await trace('legacy-unanchored')
  expect(value.request.usage.inputTokens).toBeNull()
  expect(value.request.usage.outputTokens).toBeNull()
  expect(value.request.settlement).toBeNull()
  expect(value.attempts[0].usage.inputTokens).toBeNull()
  expect(value.attempts[0].settlement).toBeNull()
  expect((await get('legacy-unanchored', 'viewer')).status).toBe(404)
  expect((await get('unattributed', 'viewer')).status).toBe(404)
})
it('rejects both v2 observed and Worker anchors when the frozen request fact is absent', async () => {
  const value = await trace('missing-frozen')
  expect(value.request.usage.source).toBeNull()
  expect(value.attempts[0].usage.inputTokens).toBeNull()
  expect(value.request.settlement).toBeNull()
  expect(value.attempts[0].settlement).toBeNull()
})
it('preserves frozen history after rename/archive, key reassignment/revocation and connection move', async () => {
  await pool.query(
    "UPDATE projects SET name='Current changed name',status='archived',archived_at=now() WHERE id='project-a'; UPDATE downstream_api_keys SET project_id='project-hidden',name='Current key',enabled=false WHERE id='key-history'; UPDATE owned_connections SET project_id='project-hidden',status='revoked' WHERE id='connection'",
  )
  const value = await trace('visible', 'viewer')
  expect(value.request.project).toMatchObject({ id: 'project-a', name: 'Original project name' })
  expect(value.request.apiKeyId).toBe('key-history')
  expect(value.request.requestedModel).toBe('frozen-alias')
  expect(value.attempts[0].connectionId).toBe('connection')
  expect((await trace('deleted-history')).request.project.id).toBe('deleted-project')
  expect((await get('deleted-history', 'viewer')).status).toBe(404)
})
it('rechecks project/organization membership and active tenant organization on every detail read', async () => {
  await pool.query("DELETE FROM project_memberships WHERE user_id='viewer' AND project_id='project-a'")
  try {
    expect((await get('visible', 'viewer')).status).toBe(404)
  } finally {
    await pool.query(
      "INSERT INTO project_memberships(project_id,tenant_id,user_id) VALUES ('project-a','trace-tenant','viewer')",
    )
  }
  await pool.query("UPDATE organizations SET status='suspended' WHERE id='org-a'")
  try {
    expect((await get('visible', 'viewer')).status).toBe(401)
  } finally {
    await pool.query("UPDATE organizations SET status='active' WHERE id='org-a'")
  }
})
it('isolates foreign injected attempts/usage and mismatched event envelopes and schemas', async () => {
  await expect(
    attempt('visible', 99, { id: 'foreign-injected-attempt', tenant_id: 'foreign-tenant', resolved_model: canary }),
  ).rejects.toThrow('attempt request tenant scope mismatch')
  await event('foreign-injected-event', 'visible', 'visible-2', canonical('visible', 8888), {
    tenant_id: 'foreign-tenant',
    created_at: '2026-10-05',
  })
  for (const [id, envelope] of [
    ['wrong-tenant', canonical('visible', 8888, 2, { tenant_id: 'foreign-tenant' })],
    ['wrong-request', canonical('foreign', 8888)],
    ['wrong-schema', canonical('visible', 8888, 99)],
  ] as const)
    await event(id, 'visible', 'visible-2', envelope, { created_at: '2026-10-05' })
  await event('wrong-attempt', 'visible', 'legacy-unanchored-1', canonical('visible', 8888), {
    created_at: '2026-10-05',
  })
  await insert('usage_records', {
    id: 'foreign-injected-record',
    tenant_id: 'foreign-tenant',
    request_id: 'visible',
    usage_event_id: 'foreign-injected-event',
    charge_amount: 999,
  })
  const value = await trace()
  expect(value.attemptCount).toBe('3')
  expect(value.attempts[1].usage.inputTokens).toBe('4')
  expect(value.attempts[1].settlement).toBeNull()
  expect(JSON.stringify(value)).not.toContain(canary)
})
it('never exposes payload, error messages, secret refs, arbitrary metadata or credential fields', async () => {
  await pool.query('UPDATE request_records SET error_code=$1 WHERE id=$2', [canary, 'visible'])
  const value = await trace()
  const serialized = JSON.stringify(value)
  expect(value.request.errorCode).toBeNull()
  for (const forbidden of [
    canary,
    'encrypted_secret',
    'credentialRef',
    'credential_id',
    'error_message',
    'frozen_pricing',
    'payload',
    'metadata',
    'prompt',
    'response',
  ])
    expect(serialized).not.toContain(forbidden)
})
it('reports truncation and exact count, including persisted in-flight attempts', async () => {
  await recorded('bounded')
  await pool.query(
    "INSERT INTO attempts(id,tenant_id,request_id,attempt_number,status) SELECT 'bounded-'||lpad(i::text,3,'0'),'trace-tenant','bounded',i,'sent' FROM generate_series(1,130) i",
  )
  const value = await trace('bounded')
  expect(value.attempts).toHaveLength(128)
  expect(value.attemptCount).toBe('130')
  expect(value.truncated).toBe(true)
  expect(value.attempts[127].number).toBe(128)
  expect(value.attempts[0].timing.completedAt).toBeNull()
  expect(value.attempts[0].timing.durationMs).toBeNull()
})
it('preserves actual Gateway-compatible long/Unicode/whitespace provider request IDs', async () => {
  for (const providerId of ['x'.repeat(300), 'provider\nrequest\tidentifier', '🙂'.repeat(512)]) {
    await pool.query('UPDATE attempts SET upstream_request_id=$1 WHERE id=$2', [providerId, 'visible-1'])
    expect((await trace()).attempts[0].providerRequestId).toBe(providerId)
  }
})
it('accepts existing frozen project display names and model IDs with bounded Unicode or whitespace', async () => {
  await recorded('unicode-history', 'project-a', 'org-a', 'trace-tenant', true, 'Alpha\nBeta\t🙂')
  expect((await trace('unicode-history')).request.project.name).toBe('Alpha\nBeta\t🙂')
  await insert('request_records', {
    id: 'unicode-model',
    tenant_id: 'trace-tenant',
    organization_id: 'org-a',
    request_model: '🙂'.repeat(256),
    channel_kind: 'byok',
  })
  expect((await trace('unicode-model')).request.requestedModel).toBe('🙂'.repeat(256))
})
it('uses a coherent read-only snapshot with fixed query count and performs no accounting/audit writes', async () => {
  const counts = async () =>
    (await pool.query('SELECT (SELECT count(*) FROM audit_events) audit,(SELECT count(*) FROM ledger_postings) ledger'))
      .rows[0]
  const beforeCounts = await counts()
  const client = await pool.connect()
  let queries = 0
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('on')
    expect((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation).toBe('repeatable read')
    const database = {
      async query<T>(sql: string, values?: unknown[]) {
        queries++
        return { rows: (await client.query(sql, values)).rows as T[] }
      },
    }
    const access = {
      tenantId: 'trace-tenant',
      organizations: [{ organizationId: 'org-a', allProjects: true, projectIds: [] }],
      financialOrganizationId: null,
    }
    const original = await readRequestTrace(database, access, 'visible')
    await pool.query("UPDATE request_records SET status='unknown' WHERE id='visible'")
    const same = await readRequestTrace(database, access, 'visible')
    expect(same).toEqual(original)
    expect(queries).toBe(4)
    await client.query('COMMIT')
  } finally {
    client.release()
    await pool.query("UPDATE request_records SET status='completed' WHERE id='visible'")
  }
  expect(await counts()).toEqual(beforeCounts)
  const snapshot = async () =>
    (
      await pool.query(
        'SELECT (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM request_records r) requests,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM attempts a) attempts,(SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM usage_records u) usage,(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM usage_events e) events,(SELECT jsonb_agg(to_jsonb(f) ORDER BY request_id) FROM request_project_facts f) facts,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM ledger_postings p) ledger,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_events a) audit,(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM outbox_events o) outbox',
      )
    ).rows[0]
  const facts = await snapshot()
  await trace()
  await get('missing')
  expect(await snapshot()).toEqual(facts)
})
it('opens the actual route transaction as read-only and gives a fixed no-store storage error', async () => {
  const original = applicationPool.connect.bind(applicationPool)
  const connect = vi.spyOn(applicationPool, 'connect')
  connect.mockImplementation(((...args: unknown[]) => {
    // Pool.query authentication uses the callback overload; instrument only
    // the direct connection acquired by the route for its read transaction.
    if (args.length) return Reflect.apply(original, applicationPool, args)
    return original().then((client) => {
      const query = client.query.bind(client)
      let sawRead = false
      client.query = (async (sql: string, values?: unknown[]) => {
        if (sql.startsWith('SELECT m.organization_id')) {
          expect((await query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('on')
          expect((await query('SHOW transaction_isolation')).rows[0].transaction_isolation).toBe('repeatable read')
          sawRead = true
        }
        if (sql === 'COMMIT') expect(sawRead).toBe(true)
        return query(sql, values)
      }) as typeof client.query
      const release = client.release.bind(client)
      client.release = () => {
        client.query = query as typeof client.query
        release()
      }
      return client
    })
  }) as typeof applicationPool.connect)
  await trace()
  connect.mockRestore()
  const failing = vi
    .spyOn(applicationPool, 'connect')
    .mockImplementation(((...args: unknown[]) =>
      args.length
        ? Reflect.apply(original, applicationPool, args)
        : Promise.reject(new Error('synthetic storage failure'))) as typeof applicationPool.connect)
  try {
    const response = await get('visible')
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: { code: 'internal_error', message: '服务暂时不可用，请稍后重试' } })
  } finally {
    failing.mockRestore()
  }
})
