import { Pool } from 'pg'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { GET as billing } from '@/app/api/billing/route'
import { GET as logs } from '@/app/api/logs/route'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { ANALYTICS_GROUP_BY, validateUsageAnalyticsResponse } from '../../packages/contracts/usage-analytics'
import { postTransaction, ensureWalletLedgerAccount, ensureSystemLedgerAccount } from '@/lib/db/ledger'
if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
const cookies: Record<string, string> = {}
beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES ('org','tenant','Org','route-org'),('foreign','foreign','Foreign','route-foreign');
    INSERT INTO users(id,email,name,password_hash) VALUES ('owner','route-owner@example.invalid','Owner','fixture'),('admin','route-admin@example.invalid','Admin','fixture'),('viewer','route-viewer@example.invalid','Viewer','fixture');
    INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES ('org','tenant','owner','owner'),('org','tenant','admin','admin'),('org','tenant','viewer','viewer');
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES ('private','tenant','org','Private'),('foreign','foreign','foreign','Foreign');
    INSERT INTO request_records(id,tenant_id,organization_id,request_model,channel_kind,status,input_tokens,output_tokens,started_at) VALUES ('visible','tenant','org','fixture-model','byok','completed',10,2,'2020-01-01'),('foreign','foreign','foreign','hidden-model','byok','completed',20,4,'2020-01-01');
    INSERT INTO request_project_facts(request_id,tenant_id,organization_id,project_id,project_name,execution_mode,attribution_status) VALUES ('visible','tenant','org','private','Original','unknown','attributed');
    INSERT INTO wallet_accounts(id,tenant_id,organization_id,currency) VALUES ('wallet','tenant','org','USD');
    INSERT INTO orders(id,organization_id,tenant_id,wallet_id,amount,currency) VALUES ('private-order','org','tenant','wallet',5000000,'USD')`)
  for (const role of ['owner', 'admin', 'viewer'])
    cookies[role] = `${SESSION_COOKIE}=${(await createSession({ userId: role })).token}`
  const client = await pool.connect()
  try {
    await client.query("BEGIN; UPDATE wallet_accounts SET currency='CNY' WHERE id='wallet'")
    const walletAccount = await ensureWalletLedgerAccount('tenant', 'wallet', 'CNY', client)
    const clearing = await ensureSystemLedgerAccount('tenant', 'clearing', 'CNY', client)
    await postTransaction(
      {
        tenantId: 'tenant',
        type: 'recharge',
        currency: 'CNY',
        idempotencyKey: 'route-credit',
        postings: [
          { accountId: walletAccount, amount: 3_000_000n, entryType: 'credit' },
          { accountId: clearing, amount: 3_000_000n, entryType: 'debit' },
        ],
      },
      client,
    )
    await client.query('COMMIT')
  } finally {
    client.release()
  }
})
afterAll(async () => {
  await pool.end()
})
async function get(route: typeof billing, role: string, query = '') {
  return route(new Request(`http://localhost/api/report${query}`, { headers: { cookie: cookies[role] } }))
}

it('Billing reads canonical wallet balance and ledger in the actual currency', async () => {
  const body = await (await get(billing, 'owner')).json()
  expect(body.wallet.currency).toBe('CNY')
  expect(body.currency).toBe('CNY')
  expect(body.balance).toBe('3.000000')
  expect(body.usagePagination).toMatchObject({ totalGroups: '1', offset: 0, nextOffset: null })
  expect(body.ledger).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ amount: '3.000000', balanceAfter: '3.000000', currency: 'CNY' }),
    ]),
  )
  expect(body.orders).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'private-order' })]))
  const scoped = await (await get(billing, 'owner', '?projectId=private')).json()
  expect(scoped.analytics.totals.requests).toBe('1')
  expect(scoped.wallet).toBeNull()
  expect(scoped.balance).toBeNull()
  expect(scoped.currency).toBeNull()
  expect(scoped.ledger).toEqual([])
  expect(scoped.orders).toEqual([])
})
for (const [name, route] of [
  ['Billing', billing],
  ['Logs', logs],
] as const) {
  it(`${name} exposes exact analytics for owner and admin within their organization`, async () => {
    for (const role of ['owner', 'admin']) {
      const response = await get(route, role, '?groupBy=project')
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.analytics).toMatchObject({ groupBy: 'project', totals: { requests: '1' } })
      expect(body.analytics.groups).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'private' })]))
      expect(JSON.stringify(body)).not.toContain('hidden-model')
    }
  })
  it(`${name} hides request history from viewers without Project membership`, async () => {
    const response = await get(route, 'viewer')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.analytics?.totals.requests).toBe('0')
    expect(JSON.stringify(body)).not.toContain('fixture-model')
    if (name === 'Billing') {
      expect(body.wallet).toBeNull()
      expect(body.orders ?? []).toEqual([])
      expect(body.ledger ?? []).toEqual([])
    }
  })
  it(`${name} rejects forbidden and nonexistent Project/organization filters uniformly`, async () => {
    const bodies = []
    for (const query of [
      '?projectId=private',
      '?projectId=foreign',
      '?projectId=missing',
      '?organizationId=foreign',
      '?organizationId=missing',
    ]) {
      const response = await get(route, 'viewer', query)
      expect(response.status).toBe(404)
      bodies.push(await response.json())
    }
    for (const body of bodies) expect(body).toEqual(bodies[0])
  })
  it(`${name} rejects malformed canonical query parameters`, async () => {
    for (const query of ['?from=not-a-date', '?groupBy=illegal', '?offset=1.5'])
      expect((await get(route, 'owner', query)).status).toBe(400)
  })
}

it('Billing refuses to label inconsistent wallet ledger currency as its wallet currency', async () => {
  await pool.query("UPDATE ledger_accounts SET currency='USD' WHERE wallet_id='wallet'")
  try {
    const response = await get(billing, 'owner')
    expect(response.status).toBe(500)
    expect(await response.json()).not.toHaveProperty('balance')
  } finally {
    await pool.query("UPDATE ledger_accounts SET currency='CNY' WHERE wallet_id='wallet'")
  }
})

it.each(ANALYTICS_GROUP_BY)(
  'Billing renders canonical %s groups with project/date filters and unknown usage',
  async (groupBy) => {
    const response = await get(
      billing,
      'owner',
      `?projectId=private&groupBy=${groupBy}&from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z`,
    )
    expect(response.status).toBe(200)
    const { analytics } = await response.json()
    expect(validateUsageAnalyticsResponse(analytics)).toEqual({ ok: true, errors: [] })
    expect(analytics.totals.requests).toBe('1')
    expect(analytics.totals.tokens.reasoning.total).toBeNull()
    expect(analytics.groupBy).toBe(groupBy)
  },
)
it('Billing excludes the exact upper date boundary and returns canonical empty aggregates', async () => {
  const response = await get(billing, 'owner', '?from=2019-12-31T00:00:00Z&to=2020-01-01T00:00:00Z')
  expect(response.status).toBe(200)
  const { analytics } = await response.json()
  expect(analytics.totals.requests).toBe('0')
  expect(analytics.groups).toEqual([])
  expect(validateUsageAnalyticsResponse(analytics).ok).toBe(true)
})
it('Project A viewer cannot select Project B or broaden through another grouping', async () => {
  await pool.query(
    "INSERT INTO projects(id,tenant_id,organization_id,name) VALUES ('allowed','tenant','org','Allowed'); INSERT INTO project_memberships(project_id,tenant_id,user_id) VALUES ('allowed','tenant','viewer')",
  )
  for (const group of ANALYTICS_GROUP_BY) {
    expect((await get(billing, 'viewer', `?projectId=private&groupBy=${group}`)).status).toBe(404)
    expect((await get(billing, 'viewer', `?projectId=allowed&groupBy=${group}`)).status).toBe(200)
  }
})

it('Billing keeps each currency in the real API aggregate', async () => {
  for (const currency of ['USD', 'CNY']) {
    const id = `currency-${currency}`
    await pool.query(
      `INSERT INTO request_records(id,tenant_id,organization_id,request_model,channel_kind,status,charge_amount,charge_currency,started_at)
      VALUES($1,'tenant','org','currency-model','byok','completed',9007199254740993,$2,'2020-01-01')`,
      [id, currency],
    )
    await pool.query(
      "INSERT INTO request_project_facts(request_id,tenant_id,organization_id,project_id,project_name,execution_mode,attribution_status) VALUES($1,'tenant','org','private','Original','byok','attributed')",
      [id],
    )
    await pool.query(
      "INSERT INTO usage_events(id,tenant_id,request_id,event_id,event_type,payload) VALUES($1,'tenant',$1,$1,'usage','{}')",
      [id],
    )
    await pool.query(
      "INSERT INTO usage_records(id,tenant_id,request_id,usage_event_id,upstream_cost_amount,upstream_cost_currency) VALUES($1,'tenant',$1,$1,3,$2)",
      [id, currency],
    )
  }
  const response = await get(billing, 'owner', '?projectId=private&model=currency-model')
  expect(response.status).toBe(200)
  const { analytics } = await response.json()
  expect(
    analytics.totals.money.map((m: { currency: string; charge: { total: string } }) => [m.currency, m.charge.total]),
  ).toEqual([
    ['CNY', '9007199254740993'],
    ['USD', '9007199254740993'],
  ])
  expect(validateUsageAnalyticsResponse(analytics).ok).toBe(true)
})
