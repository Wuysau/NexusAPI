import { Pool } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  computeChargeFromSnapshot,
  insertSaleSnapshot,
  loadSaleSnapshot,
  loadExchangeRateSnapshot,
} from '@/lib/catalog/sale-snapshot'
import { authorizeBudget } from '../../services/budget/authorize'
import { postWalletCredit } from '@/lib/db/ledger'
import { readFileSync } from 'node:fs'
if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES ('o','t','Org','pricing-o');
    INSERT INTO request_records(id,tenant_id,organization_id,request_model,channel_kind) VALUES ('r','t','o','model','byok');
    INSERT INTO usage_records(id,tenant_id,request_id) VALUES ('legacy','t','r')`)
})
afterAll(async () => {
  await pool.end()
})
it('adds nullable legacy-compatible pricing and metering provenance columns', async () => {
  const result = await pool.query(
    'SELECT authoritative_metering,frozen_pricing,calculator_version FROM usage_records WHERE id=$1',
    ['legacy'],
  )
  expect(result.rows[0]).toEqual({ authoritative_metering: null, frozen_pricing: null, calculator_version: null })
  await pool.query('SELECT provider_currency,rate_currency,provenance_version FROM sale_price_snapshots LIMIT 0')
})
it('allows initial canonical capture then freezes metering, pricing and request scope', async () => {
  await pool.query(
    `UPDATE usage_records SET authoritative_metering=$1,frozen_pricing=$2,calculator_version='v2' WHERE id='legacy'`,
    [{ tenant_id: 't', request_id: 'r', usage: { input_tokens: null } }, { price: 'frozen' }],
  )
  for (const update of [
    "authoritative_metering='{}'",
    "frozen_pricing='{}'",
    "calculator_version='v1'",
    "tenant_id='other'",
    'request_id=NULL',
  ])
    await expect(pool.query(`UPDATE usage_records SET ${update} WHERE id='legacy'`)).rejects.toThrow(/immutable|scope/)
  await pool.query("UPDATE usage_records SET charge_amount=1 WHERE id='legacy'")
  await expect(pool.query("DELETE FROM usage_records WHERE id='legacy'")).rejects.toThrow(/immutable/)
})
it('rejects a canonical payload bound to a different request or tenant', async () => {
  for (const event of [{ tenant_id: 'other', request_id: 'r' }, { tenant_id: 't', request_id: 'other' }, {}])
    await expect(
      pool.query('INSERT INTO usage_records(tenant_id,request_id,authoritative_metering) VALUES($1,$2,$3)', [
        't',
        'r',
        event,
      ]),
    ).rejects.toThrow(/scope/)
})

it('publishes provider-currency rates, freezes FX and survives mutable rule changes', async () => {
  await pool.query(`INSERT INTO providers(id,code,name,official_base_url,auth_scheme) VALUES ('p','p','Provider','https://example.invalid','bearer');
    INSERT INTO provider_price_versions(id,provider_id,upstream_model_id,input_price,output_price,currency,source_type) VALUES ('p1','p','model',1,2,'USD','fixture');
    INSERT INTO sale_price_rules(id,provider_id,upstream_model_id,pricing_mode,currency) VALUES ('s1','p','model','markup','CNY');
    INSERT INTO exchange_rate_snapshots(id,base_currency,quote_currency,rate,source) VALUES ('fx','USD','CNY',7.2,'fixture'),('reverse','CNY','USD',0.14,'fixture')`)
  const client = await pool.connect()
  try {
    const input = {
      ruleId: 's1',
      providerPriceVersionId: 'p1',
      providerCurrency: 'USD',
      components: [
        { kind: 'input' as const, unit: 'per_million_tokens', amount: '1', conditions: {} },
        { kind: 'output' as const, unit: 'per_million_tokens', amount: '2', conditions: {} },
      ],
      rule: {
        pricingMode: 'markup' as const,
        markupRate: '1',
        targetMarginRate: '0',
        fixedFee: '0',
        minimumCharge: '0',
        currency: 'CNY',
      },
      exchangeRate: { base: 'USD', quote: 'CNY', rate: '7.2' },
      exchangeRateSnapshotId: 'fx',
    }
    await expect(insertSaleSnapshot(client, { ...input, exchangeRateSnapshotId: 'reverse' })).rejects.toThrow(
      /exchange/,
    )
    const snapshot = await insertSaleSnapshot(client, input)
    expect(snapshot.rateCurrency).toBe('USD')
    const frozen = await loadSaleSnapshot(client, snapshot.id)
    await pool.query("UPDATE sale_price_rules SET markup_rate=9,currency='EUR' WHERE id='s1'")
    await expect(
      pool.query("UPDATE sale_price_snapshots SET currency='EUR' WHERE id=$1", [snapshot.id]),
    ).rejects.toThrow(/immutable/)
    await expect(pool.query("UPDATE exchange_rate_snapshots SET rate=99 WHERE id='fx'")).rejects.toThrow(/immutable/)
    await expect(pool.query("UPDATE provider_price_versions SET input_price=99 WHERE id='p1'")).rejects.toThrow(
      /immutable/,
    )
    await pool.query("UPDATE provider_price_versions SET status='superseded' WHERE id='p1'")
    expect(
      computeChargeFromSnapshot(
        frozen!,
        { input: 1_000_000, output: 0, cached: 0, reasoning: 0 },
        await loadExchangeRateSnapshot(client, 'fx'),
        'CNY',
      ).saleCharge,
    ).toBe(14_400_000n)
    await pool.query(`UPDATE provider_price_versions SET status='active' WHERE id='p1';
      INSERT INTO downstream_api_keys(id,organization_id,tenant_id,name,hash,prefix) VALUES('k','o','t','fixture','fixture-hash','fixture');
      INSERT INTO wallet_accounts(id,organization_id,tenant_id,currency,status) VALUES('w','o','t','CNY','active');
      INSERT INTO sale_price_snapshots(id,rule_id,provider_price_version_id,exchange_rate_snapshot_id,pricing_mode,input_price,output_price,currency)
      VALUES('legacy-cross','s1','p1','fx','markup',2,4,'CNY')`)
    await client.query('BEGIN')
    await postWalletCredit('t', 'w', 50_000_000n, 'fund-pricing', 'recharge', undefined, undefined, client)
    await client.query('COMMIT')
    const request = {
      version: 1,
      tenant_id: 't',
      organization_id: 'o',
      key_id: 'k',
      request_id: 'budget-cross',
      model_id: 'model',
      provider: 'p',
      currency: 'CNY',
      price_version_id: 'p1',
      sale_price_snapshot_id: snapshot.id,
      exchange_rate_snapshot_id: 'fx',
      estimated_input_tokens: 1_000_000,
      estimated_output_tokens: 0,
      ttl_seconds: 900,
    }
    expect((await authorizeBudget(pool, request)).amount_micros).toBe('14400000')
    await expect(
      authorizeBudget(pool, { ...request, request_id: 'budget-legacy', sale_price_snapshot_id: 'legacy-cross' }),
    ).rejects.toMatchObject({ code: 'invalid_sale_provenance', status: 409 })
    expect(
      (await pool.query("SELECT count(*)::int AS count FROM request_records WHERE id='budget-legacy'")).rows[0].count,
    ).toBe(0)
  } finally {
    client.release()
  }
})

it('freezes BYOK provider prices at attempt capture without a sale snapshot', async () => {
  await pool.query(`INSERT INTO provider_price_versions(id,provider_id,upstream_model_id,input_price,output_price,currency,source_type) VALUES ('byok-price','p','model',1,2,'USD','fixture');
    INSERT INTO provider_credentials(id,provider_id,tenant_id,organization_id,name,encrypted_secret) VALUES ('c','p','t','o','Cred','fixture');
    INSERT INTO channels(id,tenant_id,provider_id,provider_credential_id,name) VALUES ('ch','t','p','c','Channel');
    INSERT INTO owned_connections(id,tenant_id,provider,mode) VALUES ('conn','t','p','byok');
    INSERT INTO request_project_facts(request_id,tenant_id,organization_id,execution_mode,attribution_status,catalog_version_id) VALUES ('r','t','o','byok','unattributed','catalog');
    INSERT INTO attempts(id,request_id,tenant_id,provider_id,provider_credential_id,channel_id,attempt_number,connection_id,resolved_model,execution_mode,price_version_id,catalog_version_id)
    VALUES('a','r','t','p','c','ch',1,'conn','model','byok','byok-price','catalog')`)
  await expect(pool.query("UPDATE provider_price_versions SET currency='EUR' WHERE id='byok-price'")).rejects.toThrow(
    /immutable/,
  )
  await expect(
    pool.query(
      "UPDATE provider_price_versions SET raw_source_data='{}'::jsonb || '{\"components\":[]}'::jsonb WHERE id='byok-price'",
    ),
  ).rejects.toThrow(/immutable/)
  await pool.query("UPDATE provider_price_versions SET status='superseded' WHERE id='byok-price'")
})

it('freezes legacy same-currency sale and FX sources once request identity is captured', async () => {
  await pool.query(`INSERT INTO exchange_rate_snapshots(id,base_currency,quote_currency,rate,source) VALUES ('samefx','USD','USD',1,'fixture');
    INSERT INTO sale_price_snapshots(id,rule_id,provider_price_version_id,exchange_rate_snapshot_id,pricing_mode,input_price,output_price,currency) VALUES ('legacy-same','s1','p1','samefx','markup',2,4,'USD');
    INSERT INTO request_records(id,tenant_id,organization_id,request_model,channel_kind,provider_price_version_id,sale_price_snapshot_id,exchange_rate_snapshot_id) VALUES ('captured-sale','t','o','model','platform','p1','legacy-same','samefx');
    INSERT INTO request_project_facts(request_id,tenant_id,organization_id,execution_mode,attribution_status) VALUES ('captured-sale','t','o','managed','unattributed')`)
  await expect(pool.query("UPDATE sale_price_snapshots SET input_price=9 WHERE id='legacy-same'")).rejects.toThrow(
    /immutable/,
  )
  await expect(pool.query("UPDATE exchange_rate_snapshots SET rate=9 WHERE id='samefx'")).rejects.toThrow(/immutable/)
})

it('lets only Budget lock authorized sources before reading rates, without UPDATE privileges', async () => {
  await pool.query(readFileSync('infra/db-workload-roles.sql', 'utf8'))
  const client = await pool.connect()
  const writer = await pool.connect()
  try {
    await client.query('BEGIN; SET LOCAL ROLE nexus_budget')
    await client.query("SELECT lock_budget_pricing_sources('t','o','k','p1','legacy-same','samefx','p','model','USD')")
    await writer.query("SET lock_timeout='100ms'")
    await expect(writer.query("UPDATE provider_price_versions SET status='approved' WHERE id='p1'")).rejects.toThrow(
      /lock timeout/,
    )
    await client.query('ROLLBACK; BEGIN; SET LOCAL ROLE nexus_gateway')
    await expect(
      client.query("SELECT lock_budget_pricing_sources('t','o','k','p1','legacy-same','samefx','p','model','USD')"),
    ).rejects.toThrow(/permission/)
    await client.query('ROLLBACK; BEGIN; SET LOCAL ROLE nexus_budget')
    await expect(
      client.query("SELECT lock_budget_pricing_sources('other','o','k','p1','legacy-same','samefx','p','model','USD')"),
    ).rejects.toThrow(/scope/)
  } finally {
    await client.query('ROLLBACK')
    await writer.query('RESET lock_timeout')
    client.release()
    writer.release()
  }
})

it('freezes captured managed request pins and permits first BYOK terminal pins only', async () => {
  for (const set of [
    'sale_price_snapshot_id=NULL',
    'exchange_rate_snapshot_id=NULL',
    'provider_price_version_id=NULL',
    "charge_currency='EUR'",
  ])
    await expect(pool.query(`UPDATE request_records SET ${set} WHERE id='captured-sale'`)).rejects.toThrow(
      /immutable.*pricing/,
    )
  await pool.query(
    "UPDATE request_records SET status='completed',resolved_provider_id='p',resolved_upstream_model_id='model',charge_amount=1 WHERE id='captured-sale'",
  )
  await pool.query("UPDATE request_records SET status='failed',input_tokens=2,charge_amount=2 WHERE id='captured-sale'")
  await expect(
    pool.query("UPDATE request_records SET resolved_upstream_model_id='other' WHERE id='captured-sale'"),
  ).rejects.toThrow(/immutable.*pricing/)
  await pool.query(
    "UPDATE request_records SET status='unknown',provider_price_version_id='byok-price',resolved_provider_id='p',resolved_upstream_model_id='model',charge_currency='USD' WHERE id='r'",
  )
  for (const set of [
    "provider_price_version_id='p1'",
    "sale_price_snapshot_id='legacy-same'",
    "exchange_rate_snapshot_id='samefx'",
    "charge_currency='EUR'",
    'resolved_provider_id=NULL',
    "resolved_upstream_model_id='other'",
  ])
    await expect(pool.query(`UPDATE request_records SET ${set} WHERE id='r'`)).rejects.toThrow(/immutable.*pricing/)
  await pool.query(
    "UPDATE request_records SET status='completed',input_tokens=3,charge_amount=0,reservation_released=true WHERE id='r'",
  )
  await expect(pool.query("UPDATE request_records SET status='created' WHERE id='r'")).rejects.toThrow(
    /immutable.*pricing/,
  )
  await pool.query("UPDATE request_records SET status='reconciled',input_tokens=4 WHERE id='r'")
  await pool.query(`INSERT INTO request_records(id,tenant_id,organization_id,request_model,channel_kind,status) VALUES ('old-writer','t','o','model','byok','completed');
    UPDATE request_records SET provider_price_version_id='p1',charge_currency='CNY' WHERE id='old-writer'`)
})
