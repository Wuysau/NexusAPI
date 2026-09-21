import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
import { authorizeBudget } from '../../services/budget/authorize'
import { postWalletCredit, getWalletBalance } from '@/lib/db/ledger'
import type { BudgetRequestV1 } from '../../packages/contracts/budget'

if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
let base: BudgetRequestV1
let wallet: string
beforeAll(async () => {
  const c = await pool.connect()
  try {
    await c.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await runMigrations(pool)
    await c.query("INSERT INTO organizations(id,tenant_id,name,slug,status) VALUES('o','t','budget','budget','active')")
    await c.query(
      "INSERT INTO downstream_api_keys(id,organization_id,tenant_id,name,hash,prefix) VALUES('k','o','t','budget','synthetic-budget-hash','test')",
    )
    await c.query(
      "INSERT INTO providers(id,code,name,official_base_url,auth_scheme) VALUES('p','test','test','https://provider.invalid','bearer')",
    )
    await c.query(`INSERT INTO provider_price_versions(id,provider_id,upstream_model_id,currency,unit,input_price,output_price,status,source_type)
      VALUES('pp','p','m','USD','per_million_tokens','1','1','active','manual')`)
    await c.query(`INSERT INTO sale_price_rules(id,tenant_id,organization_id,provider_id,upstream_model_id,pricing_mode,markup_rate,currency)
      VALUES('rule','t','o','p','m','markup','0','USD')`)
    await c.query(`INSERT INTO sale_price_snapshots(id,rule_id,provider_price_version_id,pricing_mode,input_price,output_price,cached_input_price,reasoning_price,fixed_fee,minimum_charge,currency)
      VALUES('sp','rule','pp','markup','1','1','1','1','0','0','USD')`)
    await c.query(
      "INSERT INTO projects(id,tenant_id,organization_id,name) VALUES ('pa','t','o','Original'),('pb','t','o','Moved')",
    )
    wallet = 'wallet'
    await c.query(
      "INSERT INTO wallet_accounts(id,organization_id,tenant_id,currency,status) VALUES($1,'o','t','USD','active')",
      [wallet],
    )
    await c.query('BEGIN')
    await postWalletCredit('t', wallet, 10_000_000n, 'fund-budget', 'recharge', undefined, undefined, c)
    await c.query('COMMIT')
  } finally {
    c.release()
  }
  base = {
    version: 1,
    tenant_id: 't',
    organization_id: 'o',
    key_id: 'k',
    request_id: 'r',
    model_id: 'm',
    provider: 'test',
    currency: 'USD',
    price_version_id: 'pp',
    sale_price_snapshot_id: 'sp',
    exchange_rate_snapshot_id: null,
    estimated_input_tokens: 1_000_000,
    estimated_output_tokens: 0,
    ttl_seconds: 900,
  }
})
afterAll(async () => {
  await pool.end()
})

const attribution = {
  project_id: 'pa',
  project_name: 'Original',
  api_key_id: 'k',
  key_kind: 'shared',
  principal_id: null,
  attribution_status: 'attributed',
  requested_model: 'alias-original',
  streaming: true,
  catalog_version_id: 'catalog-frozen',
  policy_version_id: null,
}
describe('managed request-time project capture', () => {
  it('captures identity with the hold and never reinterprets a later key move', async () => {
    const req = { ...base, request_id: randomUUID(), attribution_context: attribution }
    const first = await authorizeBudget(pool, req)
    const fact = (
      await pool.query('SELECT * FROM request_project_facts WHERE tenant_id=$1 AND request_id=$2', [
        't',
        req.request_id,
      ])
    ).rows[0]
    expect(fact).toMatchObject({
      project_id: 'pa',
      project_name: 'Original',
      api_key_id: 'k',
      principal_id: null,
      execution_mode: 'managed',
      requested_model: 'alias-original',
      streaming: true,
      catalog_version_id: 'catalog-frozen',
    })
    expect(
      (await pool.query('SELECT request_model,status FROM request_records WHERE id=$1', [req.request_id])).rows[0],
    ).toEqual({ request_model: 'alias-original', status: 'reserved' })
    await pool.query(
      "UPDATE downstream_api_keys SET project_id='pb' WHERE id='k'; UPDATE projects SET name='Renamed' WHERE id='pa'",
    )
    expect(await authorizeBudget(pool, req)).toEqual({ ...first, replayed: true })
    expect(
      await authorizeBudget(pool, {
        ...req,
        attribution_context: Object.fromEntries(Object.entries(attribution).reverse()),
      }),
    ).toEqual({ ...first, replayed: true })
    expect(
      (await pool.query('SELECT * FROM request_project_facts WHERE request_id=$1', [req.request_id])).rows[0],
    ).toEqual(fact)
    await expect(
      authorizeBudget(pool, { ...req, attribution_context: { ...attribution, project_id: 'pb' } }),
    ).rejects.toMatchObject({ code: 'authorization_conflict' })
  })
  it('rejects invalid identity and rolls back the hold when capture fails', async () => {
    const before = (await pool.query('SELECT count(*)::int n FROM ledger_postings')).rows
    const balanceClient = await pool.connect()
    let balance: bigint
    try {
      balance = await getWalletBalance('t', wallet, balanceClient)
    } finally {
      balanceClient.release()
    }
    for (const change of [
      { principal_id: 'creator' },
      { api_key_id: 'other' },
      { attribution_status: 'unknown', project_id: null },
      { project_id: 'missing' },
    ]) {
      const request_id = randomUUID()
      await expect(
        authorizeBudget(pool, { ...base, request_id, attribution_context: { ...attribution, ...change } }),
      ).rejects.toBeDefined()
      expect((await pool.query('SELECT id FROM request_records WHERE id=$1', [request_id])).rowCount).toBe(0)
    }
    expect((await pool.query('SELECT count(*)::int n FROM ledger_postings')).rows).toEqual(before)
    const c = await pool.connect()
    try {
      expect(await getWalletBalance('t', wallet, c)).toBe(balance)
    } finally {
      c.release()
    }
  })
  it('captures under the actual Budget database role without granting mutable history access', async () => {
    await pool.query(readFileSync('infra/db-workload-roles.sql', 'utf8'))
    const budget = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c role=nexus_budget' })
    try {
      const req = { ...base, request_id: randomUUID(), attribution_context: attribution }
      expect((await authorizeBudget(budget, req)).amount_micros).toBe('1000000')
      await expect(budget.query('DELETE FROM request_project_facts')).rejects.toMatchObject({ code: '42501' })
      await expect(
        budget.query("UPDATE request_records SET status='completed' WHERE id=$1", [req.request_id]),
      ).rejects.toMatchObject({ code: '42501' })
    } finally {
      await budget.end()
    }
  })
})
