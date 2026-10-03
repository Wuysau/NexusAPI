import { afterAll, beforeAll, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { processOutboxEvent, type OutboxEventRow } from '../../services/worker/processor'
import { auditRequestCharge } from '@/lib/billing/recompute'
import type { NexusUsageEventV2 } from '../../packages/contracts/usage-event-v2'
import { postWalletCredit, getWalletBalance } from '@/lib/db/ledger'
import { pollOutboxOnce } from '../../services/worker/consumer'
import type { WorkerConfig } from '../../services/worker/config'
import type { BillingUsageEvent } from '@/lib/billing/metering'
import { queryUsageAnalytics } from '@/lib/billing/analytics'
import { parseUsageAnalyticsQuery } from '../../packages/contracts/usage-analytics'

if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES ('org','tenant','Org','worker19');
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES ('project-a','tenant','org','A'),('project-b','tenant','org','B');
    INSERT INTO downstream_api_keys(id,tenant_id,organization_id,project_id,name,hash,prefix) VALUES ('key','tenant','org','project-a','Key','hash','test');
    INSERT INTO providers(id,code,name,official_base_url,auth_scheme) VALUES ('provider','worker19','Provider','https://example.invalid','bearer');
    INSERT INTO provider_price_versions(id,provider_id,upstream_model_id,currency,unit,input_price,output_price,cached_input_price,reasoning_price,status,source_type)
      VALUES ('price','provider','model','USD','per_million_tokens',2,10,1,4,'active','manual');
    INSERT INTO provider_credentials(id,provider_id,tenant_id,organization_id,name,encrypted_secret,is_platform_managed) VALUES ('credential','provider','tenant','org','Credential','fixture',false);
    INSERT INTO channels(id,tenant_id,provider_id,provider_credential_id,name) VALUES ('channel','tenant','provider','credential','Channel');
    INSERT INTO owned_connections(id,tenant_id,provider,mode) VALUES ('connection','tenant','worker19','byok');
    INSERT INTO provider_credentials(id,provider_id,name,encrypted_secret,is_platform_managed) VALUES ('managed-credential','provider','Managed','fixture',true);
    INSERT INTO channels(id,provider_id,provider_credential_id,name) VALUES ('managed-channel','provider','managed-credential','Managed');
    INSERT INTO sale_price_rules(id,provider_id,upstream_model_id,pricing_mode,markup_rate,currency) VALUES ('sale-rule','provider','model','markup',0,'USD');
    INSERT INTO sale_price_snapshots(id,rule_id,provider_price_version_id,pricing_mode,input_price,output_price,cached_input_price,reasoning_price,fixed_fee,minimum_charge,currency)
      VALUES ('sale','sale-rule','price','markup',2,10,1,4,0,0,'USD');
    INSERT INTO wallet_accounts(id,organization_id,tenant_id,currency,status) VALUES ('wallet','org','tenant','USD','active')`)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await postWalletCredit('tenant', 'wallet', 1000000n, 'worker19-funding', 'recharge', undefined, undefined, client)
    await client.query('COMMIT')
  } finally {
    client.release()
  }
})
afterAll(async () => {
  await pool.end()
})

async function fixture(
  usage: NexusUsageEventV2['usage'] = {
    input_tokens: 100,
    output_tokens: 20,
    cached_input_tokens: 50,
    reasoning_tokens: 10,
    total_tokens: 120,
    estimated: false,
  },
  mode: 'byok' | 'managed' = 'byok',
  currencyPin?: { currency: string; fx: string },
  priceId: string | null = 'price',
) {
  const id = randomUUID(),
    attempt = randomUUID()
  await pool.query(
    `INSERT INTO request_records(id,tenant_id,organization_id,downstream_key_id,project_id,project_name,execution_mode,attribution_status,request_model,channel_kind,status,
    provider_price_version_id,resolved_provider_id,resolved_upstream_model_id,input_tokens,output_tokens,cached_tokens,reasoning_tokens,charge_currency)
    VALUES($1,'tenant','org','key','project-a','A',$6,'attributed','alias',$7,'completed',$8,'provider','model',$2,$3,$4,$5,'USD')`,
    [
      id,
      usage.input_tokens ?? 0,
      usage.output_tokens ?? 0,
      usage.cached_input_tokens ?? 0,
      usage.reasoning_tokens ?? 0,
      mode,
      mode === 'managed' ? 'platform' : 'byok',
      priceId,
    ],
  )
  if (mode === 'managed' && priceId)
    await pool.query('UPDATE request_records SET sale_price_snapshot_id=$1 WHERE id=$2', [
      priceId === 'price' ? 'sale' : `sale-${priceId}`,
      id,
    ])
  if (currencyPin)
    await pool.query('UPDATE request_records SET charge_currency=$1,exchange_rate_snapshot_id=$2 WHERE id=$3', [
      currencyPin.currency,
      currencyPin.fx,
      id,
    ])
  await pool.query(
    `INSERT INTO request_project_facts(request_id,tenant_id,organization_id,project_id,project_name,api_key_id,key_kind,principal_id,execution_mode,attribution_status,requested_model,streaming,catalog_version_id)
    VALUES($1,'tenant','org','project-a','A','key','shared',NULL,$2,'attributed','alias',false,'catalog')`,
    [id, mode],
  )
  await pool.query(
    `INSERT INTO attempts(id,request_id,tenant_id,provider_id,provider_credential_id,channel_id,connection_id,attempt_number,status,resolved_model,execution_mode,price_version_id,catalog_version_id,input_tokens,output_tokens,cached_tokens,reasoning_tokens)
    VALUES($1,$2,'tenant','provider',$7,$8,'connection',1,'completed','model',$9,$10,'catalog',$3,$4,$5,$6)`,
    [
      attempt,
      id,
      usage.input_tokens ?? 0,
      usage.output_tokens ?? 0,
      usage.cached_input_tokens ?? 0,
      usage.reasoning_tokens ?? 0,
      mode === 'managed' ? 'managed-credential' : 'credential',
      mode === 'managed' ? 'managed-channel' : 'channel',
      mode,
      priceId,
    ],
  )
  const event: NexusUsageEventV2 = {
    schema_version: 2,
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    tenant_id: 'tenant',
    organization_id: 'org',
    request_id: id,
    attempt_id: attempt,
    model_id: 'model',
    provider_id: 'provider',
    requested_model: 'alias',
    resolved_model: 'model',
    streaming: false,
    status: 'completed',
    price_version_id: priceId,
    catalog_version_id: 'catalog',
    policy_version_id: null,
    usage,
    attribution: {
      project_id: 'project-a',
      project_name: 'A',
      api_key_id: 'key',
      key_kind: 'shared',
      principal_id: null,
      connection_id: 'connection',
      credential_id: mode === 'managed' ? 'managed-credential' : 'credential',
      channel_id: mode === 'managed' ? 'managed-channel' : 'channel',
      execution_mode: mode,
      attribution_status: 'attributed',
    },
  }
  return event
}
async function deliver(event: BillingUsageEvent, rollback = false) {
  const row: OutboxEventRow = {
    id: randomUUID(),
    tenant_id: 'tenant',
    aggregate_type: 'usage',
    aggregate_id: event.request_id,
    event_type: `usage.${event.schema_version === 2 ? 'v2.' : ''}${event.status}`,
    payload: event,
    idempotency_key: event.event_id,
    attempts: 0,
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await processOutboxEvent(client, row)
    await client.query(rollback ? 'ROLLBACK' : 'COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
it('settles v2 disjoint buckets once and preserves historical project on replay', async () => {
  const event = await fixture()
  await pool.query("UPDATE downstream_api_keys SET project_id='project-b' WHERE id='key'")
  expect(await deliver(event)).toMatchObject({ disposition: 'settled', chargeMicros: 0n })
  const records = await pool.query('SELECT * FROM usage_records WHERE request_id=$1', [event.request_id])
  expect(records.rows).toHaveLength(1)
  expect(records.rows[0].upstream_cost_amount).toBe('290')
  expect(records.rows[0].authoritative_metering.attribution.project_id).toBe('project-a')
  expect(records.rows[0].authoritative_metering.usage.input_tokens).toBe(100)
  expect(records.rows[0].calculator_version).toBe('nexus-billing-inclusive-v3')
  const before = await pool.query('SELECT count(*) FROM ledger_transactions')
  expect(await deliver(event)).toMatchObject({ disposition: 'replayed' })
  expect((await pool.query('SELECT count(*) FROM ledger_transactions')).rows).toEqual(before.rows)
  const audit = await auditRequestCharge(event.request_id, 'tenant', pool)
  expect(audit).toMatchObject({
    computable: true,
    recomputedUpstreamCost: 290n,
    calculatorVersion: 'nexus-billing-inclusive-v3',
  })
})
it('keeps unknown token null distinct from observed zero', async () => {
  const missing = await fixture({
    input_tokens: 100,
    output_tokens: 20,
    cached_input_tokens: null,
    reasoning_tokens: 0,
    total_tokens: 120,
    estimated: false,
  })
  expect(await deliver(missing)).toMatchObject({ disposition: 'reconciled', detail: 'missing_usage' })
  expect(
    (await pool.query('SELECT count(*) FROM usage_records WHERE request_id=$1', [missing.request_id])).rows[0].count,
  ).toBe('0')
  const stored = await pool.query('SELECT payload FROM usage_events WHERE request_id=$1', [missing.request_id])
  expect(stored.rows[0].payload.event.usage.cached_input_tokens).toBeNull()
  const zero = await fixture({
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: null,
    estimated: false,
  })
  expect(await deliver(zero)).toMatchObject({ disposition: 'settled' })
})
it('rejects altered attribution or null-to-zero on replay without new money', async () => {
  const event = await fixture({
    input_tokens: 100,
    output_tokens: 20,
    cached_input_tokens: null,
    reasoning_tokens: 0,
    total_tokens: 120,
    estimated: false,
  })
  await deliver(event)
  const changed = structuredClone(event)
  changed.usage.cached_input_tokens = 0
  await expect(deliver(changed)).rejects.toMatchObject({ code: 'event_replay_mismatch' })
  const spoof = structuredClone(event)
  spoof.attribution.project_id = 'project-b'
  await expect(deliver(spoof)).rejects.toMatchObject({ code: 'event_replay_mismatch' })
})
it('rejects frozen identity and routing mismatch before any ledger mutation', async () => {
  for (const dimension of ['project_id', 'connection_id', 'credential_id', 'channel_id'] as const) {
    const event = await fixture()
    event.attribution[dimension] = 'wrong'
    await expect(deliver(event)).rejects.toMatchObject({ code: 'request_fact_mismatch' })
    expect(
      (await pool.query('SELECT count(*) FROM ledger_transactions WHERE reference_id=$1', [event.request_id])).rows[0]
        .count,
    ).toBe('0')
  }
})
it('retries a rolled-back v2 settlement with exactly one durable posting', async () => {
  const event = await fixture()
  await deliver(event, true)
  expect(
    (await pool.query('SELECT count(*) FROM usage_events WHERE request_id=$1', [event.request_id])).rows[0].count,
  ).toBe('0')
  await deliver(event)
  expect(
    (await pool.query('SELECT count(*) FROM usage_records WHERE request_id=$1', [event.request_id])).rows[0].count,
  ).toBe('1')
})
it('recomputes from frozen pricing after catalog price edits', async () => {
  const event = await fixture()
  await deliver(event)
  await expect(
    pool.query("UPDATE provider_price_versions SET input_price=99,output_price=99 WHERE id='price'"),
  ).rejects.toThrow('immutable frozen provider price')
  await pool.query("UPDATE provider_price_versions SET status='superseded' WHERE id='price'")
  expect(await auditRequestCharge(event.request_id, 'tenant', pool)).toMatchObject({
    computable: true,
    recomputedUpstreamCost: 290n,
  })
  await pool.query("UPDATE provider_price_versions SET status='active' WHERE id='price'")
})
it('managed v2 rollback and replay debit the exact amount once', async () => {
  const event = await fixture(undefined, 'managed')
  const client = await pool.connect()
  let before: bigint
  try {
    before = await getWalletBalance('tenant', 'wallet', client)
  } finally {
    client.release()
  }
  await deliver(event, true)
  expect(await deliver(event)).toMatchObject({ disposition: 'settled', chargeMicros: 290n })
  await deliver(event)
  const check = await pool.connect()
  try {
    expect(await getWalletBalance('tenant', 'wallet', check)).toBe(before - 290n)
  } finally {
    check.release()
  }
  expect(
    (
      await pool.query("SELECT count(*) FROM ledger_transactions WHERE tenant_id='tenant' AND idempotency_key=$1", [
        `usage:${event.request_id}`,
      ])
    ).rows[0].count,
  ).toBe('1')
})
it('reconciles missing captured identity rather than charging a legacy zero projection', async () => {
  const event = await fixture()
  event.request_id = randomUUID()
  event.attempt_id = randomUUID()
  await pool.query(
    `INSERT INTO request_records(id,tenant_id,organization_id,request_model,channel_kind,status,provider_price_version_id,resolved_provider_id,resolved_upstream_model_id,charge_currency) VALUES($1,'tenant','org','alias','byok','completed','price','provider','model','USD')`,
    [event.request_id],
  )
  expect(await deliver(event)).toMatchObject({ disposition: 'reconciled', detail: 'missing_attribution' })
})
it('preserves an older attempt without charging it or trusting changed identity', async () => {
  const event = await fixture()
  await pool.query(
    `INSERT INTO attempts(id,request_id,tenant_id,provider_id,provider_credential_id,channel_id,connection_id,attempt_number,status,resolved_model,execution_mode,price_version_id,catalog_version_id)
    VALUES($1,$2,'tenant','provider','credential','channel','connection',2,'completed','model','byok','price','catalog')`,
    [randomUUID(), event.request_id],
  )
  const forged = structuredClone(event)
  forged.attribution.project_id = 'project-b'
  await expect(deliver(forged)).rejects.toMatchObject({ code: 'request_fact_mismatch' })
  expect(await deliver(event)).toMatchObject({ disposition: 'superseded' })
  expect(
    (await pool.query('SELECT count(*) FROM ledger_transactions WHERE reference_id=$1', [event.request_id])).rows[0]
      .count,
  ).toBe('0')
})
it('uses the real consumer savepoint for v2 crash, retry and dead-letter', async () => {
  const event = await fixture(undefined, 'managed'),
    id = randomUUID()
  await pool.query(
    `INSERT INTO outbox_events(id,tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key) VALUES($1,'tenant','usage',$2,'usage.v2.completed',$3::jsonb,$4)`,
    [id, event.request_id, JSON.stringify(event), event.event_id],
  )
  const config: WorkerConfig = {
    databaseUrl: process.env.DATABASE_URL!,
    workerId: 'worker19',
    pollIntervalMs: 50,
    batchSize: 20,
    maxAttempts: 3,
    backoffBaseMs: 1,
    backoffMaxMs: 10,
    reconcileIntervalMs: 60000,
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    expect(await pollOutboxOnce(client, config)).toMatchObject({ published: 1 })
    await client.query('ROLLBACK')
    expect((await client.query('SELECT status FROM outbox_events WHERE id=$1', [id])).rows[0].status).toBe('pending')
    await client.query('BEGIN')
    expect(await pollOutboxOnce(client, config)).toMatchObject({ published: 1 })
    await client.query('COMMIT')
    expect(
      (await client.query('SELECT count(*) FROM usage_records WHERE request_id=$1', [event.request_id])).rows[0].count,
    ).toBe('1')
    const forged = await fixture()
    forged.attribution.connection_id = 'wrong'
    await client.query(
      `INSERT INTO outbox_events(id,tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key) VALUES($1,'tenant','usage',$2,'usage.v2.completed',$3::jsonb,$4)`,
      [randomUUID(), forged.request_id, JSON.stringify(forged), forged.event_id],
    )
    await client.query('BEGIN')
    expect(await pollOutboxOnce(client, config)).toMatchObject({ deadLettered: 1, published: 0 })
    await client.query('COMMIT')
  } finally {
    client.release()
  }
})
it('rejects v1 downgrade of an already captured v2 attempt', async () => {
  const v2 = await fixture(undefined, 'managed')
  if (v2.price_version_id === null) throw new Error('managed fixture requires price')
  const v1: BillingUsageEvent = {
    schema_version: 1,
    event_id: randomUUID(),
    occurred_at: v2.occurred_at,
    tenant_id: v2.tenant_id,
    request_id: v2.request_id,
    attempt_id: v2.attempt_id,
    model_id: v2.model_id,
    status: 'completed',
    price_version_id: v2.price_version_id,
    catalog_version_id: v2.catalog_version_id,
    usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50, reasoning_tokens: 10, estimated: false },
  }
  await expect(deliver(v1)).rejects.toMatchObject({ code: 'event_version_mismatch' })
  v1.attempt_id = randomUUID()
  await expect(deliver(v1)).rejects.toMatchObject({ code: 'event_version_mismatch' })
})
it('consumes a genuine N-1 event with historical calculator and unknown project', async () => {
  const id = randomUUID(),
    attempt = randomUUID()
  await pool.query(
    `INSERT INTO request_records(id,tenant_id,organization_id,downstream_key_id,request_model,channel_kind,status,provider_price_version_id,resolved_provider_id,resolved_upstream_model_id,input_tokens,output_tokens,cached_tokens,reasoning_tokens,charge_currency)
    VALUES($1,'tenant','org','key','model','byok','completed','price','provider','model',100,20,50,10,'USD')`,
    [id],
  )
  await pool.query(
    "INSERT INTO attempts(id,tenant_id,request_id,attempt_number,status) VALUES($1,'tenant',$2,1,'completed')",
    [attempt, id],
  )
  const event: BillingUsageEvent = {
    schema_version: 1,
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    tenant_id: 'tenant',
    request_id: id,
    attempt_id: attempt,
    model_id: 'model',
    status: 'completed',
    price_version_id: 'price',
    catalog_version_id: 'catalog',
    usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50, reasoning_tokens: 10, estimated: false },
  }
  expect(await deliver(event)).toMatchObject({ disposition: 'settled' })
  expect(
    (await pool.query('SELECT upstream_cost_amount FROM usage_records WHERE request_id=$1', [id])).rows[0]
      .upstream_cost_amount,
  ).toBe('490')
  const payload = (await pool.query('SELECT payload FROM usage_events WHERE request_id=$1', [id])).rows[0].payload
  expect(payload.processing).toMatchObject({
    calculator_version: 'nexus-billing-pipeline-v2',
    attribution: { project_id: null, attribution_status: 'unknown' },
  })
})
it('does not convert subscription quota observations into money postings', async () => {
  const client = await pool.connect()
  try {
    const before = (await client.query('SELECT count(*) FROM ledger_transactions')).rows
    expect(
      await processOutboxEvent(client, {
        id: randomUUID(),
        tenant_id: 'tenant',
        aggregate_type: 'subscription_quota',
        aggregate_id: 'connection',
        event_type: 'quota.observed',
        payload: { used: 100, limit: 1000 },
        idempotency_key: randomUUID(),
        attempts: 0,
      }),
    ).toMatchObject({ disposition: 'ignored' })
    expect((await client.query('SELECT count(*) FROM ledger_transactions')).rows).toEqual(before)
  } finally {
    client.release()
  }
})

it('does not recompute an unconsumed v2 terminal from compatibility token columns', async () => {
  const event = await fixture()
  expect(await auditRequestCharge(event.request_id, 'tenant', pool)).toMatchObject({
    computable: false,
    reason: 'missing_authoritative_metering',
    recomputedChargeAmount: null,
  })
})

it('reconciles invalid frozen FX instead of retrying or assuming parity', async () => {
  const fx = randomUUID()
  await pool.query(
    "INSERT INTO exchange_rate_snapshots(id,base_currency,quote_currency,rate,source) VALUES($1,'USD','CNY',-1,'fixture')",
    [fx],
  )
  const event = await fixture(undefined, 'byok', { currency: 'CNY', fx })
  expect(await deliver(event)).toMatchObject({ disposition: 'reconciled', detail: 'missing_exchange_rate' })
})

it('settles managed and BYOK v2 under the actual least-privilege Worker role', async () => {
  await pool.query(readFileSync('infra/db-workload-roles.sql', 'utf8'))
  for (const mode of ['managed', 'byok'] as const) {
    const event = await fixture(undefined, mode),
      client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE nexus_worker')
      expect(
        await processOutboxEvent(client, {
          id: randomUUID(),
          tenant_id: 'tenant',
          aggregate_type: 'usage',
          aggregate_id: event.request_id,
          event_type: 'usage.v2.completed',
          payload: event,
          idempotency_key: event.event_id,
          attempts: 0,
        }),
      ).toMatchObject({ disposition: 'settled' })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
})

it('Anthropic missing reasoning settles from frozen output rate, retains null and survives rollback/retry', async () => {
  await pool.query(`INSERT INTO provider_price_versions(id,provider_id,upstream_model_id,currency,unit,input_price,output_price,cached_input_price,cache_write_price,reasoning_price,status,source_type)
    VALUES ('anthropic-flat','provider','model','USD','per_million_tokens',2,10,1,2,0,'active','manual');
    INSERT INTO sale_price_snapshots(id,rule_id,provider_price_version_id,pricing_mode,input_price,output_price,cached_input_price,reasoning_price,fixed_fee,minimum_charge,currency)
    VALUES ('sale-anthropic-flat','sale-rule','anthropic-flat','markup',2,10,1,0,0,0,'USD')`)
  const observed: NexusUsageEventV2['usage'] = {
    input_tokens: 100,
    output_tokens: 20,
    cached_input_tokens: 0,
    reasoning_tokens: null,
    total_tokens: null,
    estimated: false,
    semantics: 'anthropic-inclusive-v1',
    cache_creation_input_tokens: 0,
  }
  const event = await fixture(observed, 'managed', undefined, 'anthropic-flat')
  expect(await deliver(event, true)).toMatchObject({ disposition: 'settled', chargeMicros: 400n })
  expect(await deliver(event)).toMatchObject({ disposition: 'settled', chargeMicros: 400n })
  const before = (await pool.query('SELECT count(*) FROM ledger_transactions')).rows
  expect(await deliver(event)).toMatchObject({ disposition: 'replayed' })
  expect((await pool.query('SELECT count(*) FROM ledger_transactions')).rows).toEqual(before)
  const record = (
    await pool.query('SELECT authoritative_metering,upstream_cost_amount FROM usage_records WHERE request_id=$1', [
      event.request_id,
    ])
  ).rows[0]
  expect(record.authoritative_metering.usage.reasoning_tokens).toBeNull()
  expect(record.upstream_cost_amount).toBe('400')
  expect(await auditRequestCharge(event.request_id, 'tenant', pool)).toMatchObject({
    computable: true,
    recomputedUpstreamCost: 400n,
    matchesStored: true,
  })
  const analytics = await queryUsageAnalytics(
    pool,
    {
      tenantId: 'tenant',
      organizations: [{ organizationId: 'org', allProjects: true, projectIds: [] }],
      financialOrganizationId: 'org',
    },
    parseUsageAnalyticsQuery(new URLSearchParams({ q: event.request_id })),
  )
  expect(analytics.totals.tokens.reasoning).toEqual({ knownSum: '0', unknownRequests: '1', total: null })
  expect(analytics.totals.money[0].charge.total).toBe('400')
})

it.each([0, 7])(
  'Anthropic observed reasoning %s preserves its breakdown without charging output twice',
  async (reasoning) => {
    const event = await fixture(
      {
        input_tokens: 100,
        output_tokens: 20,
        cached_input_tokens: 0,
        reasoning_tokens: reasoning,
        total_tokens: null,
        estimated: false,
        semantics: 'anthropic-inclusive-v1',
        cache_creation_input_tokens: 0,
      },
      'managed',
      undefined,
      'anthropic-flat',
    )
    expect(await deliver(event)).toMatchObject({ disposition: 'settled', chargeMicros: 400n })
    const row = (
      await pool.query('SELECT authoritative_metering FROM usage_records WHERE request_id=$1', [event.request_id])
    ).rows[0]
    expect(row.authoritative_metering.usage.reasoning_tokens).toBe(reasoning)
  },
)
it('Anthropic cache reads and creations are disjoint from fresh input', async () => {
  const event = await fixture(
    {
      input_tokens: 115,
      output_tokens: 20,
      cached_input_tokens: 10,
      reasoning_tokens: null,
      total_tokens: null,
      estimated: false,
      semantics: 'anthropic-inclusive-v1',
      cache_creation_input_tokens: 5,
    },
    'managed',
    undefined,
    'anthropic-flat',
  )
  expect(await deliver(event)).toMatchObject({ disposition: 'settled', chargeMicros: 420n })
})
it.each(['input_tokens', 'output_tokens'] as const)('Anthropic missing billable %s still reconciles', async (field) => {
  const usage: NexusUsageEventV2['usage'] = {
    input_tokens: 100,
    output_tokens: 20,
    cached_input_tokens: 0,
    reasoning_tokens: null,
    total_tokens: null,
    estimated: false,
    semantics: 'anthropic-inclusive-v1',
    cache_creation_input_tokens: 0,
  }
  usage[field] = null
  const event = await fixture(usage, 'managed', undefined, 'anthropic-flat')
  expect(await deliver(event)).toMatchObject({ disposition: 'reconciled', detail: 'missing_usage' })
})
it('Anthropic independently priced reasoning still requires the observation', async () => {
  const event = await fixture({
    input_tokens: 100,
    output_tokens: 20,
    cached_input_tokens: 0,
    reasoning_tokens: null,
    total_tokens: null,
    estimated: false,
    semantics: 'anthropic-inclusive-v1',
    cache_creation_input_tokens: 0,
  })
  expect(await deliver(event)).toMatchObject({ disposition: 'reconciled', detail: 'missing_usage' })
})

for (const partial of [false, true])
  it(`anchors unpriced BYOK without money or fabricated usage (partial=${partial})`, async () => {
    const event = await fixture(
      {
        input_tokens: 100,
        output_tokens: 20,
        cached_input_tokens: partial ? null : 50,
        reasoning_tokens: partial ? null : 10,
        total_tokens: 120,
        estimated: false,
      },
      'byok',
      undefined,
      null,
    )
    const ledgerBefore = (await pool.query('SELECT count(*) FROM ledger_transactions')).rows
    expect(await deliver(event)).toMatchObject({
      disposition: 'reconciled',
      detail: partial ? 'missing_usage' : 'missing_price_version',
    })
    const stored = (await pool.query('SELECT payload FROM usage_events WHERE request_id=$1', [event.request_id])).rows
    expect(stored).toHaveLength(1)
    expect(stored[0].payload.event).toEqual(event)
    expect(
      (await pool.query('SELECT count(*) FROM usage_records WHERE request_id=$1', [event.request_id])).rows[0].count,
    ).toBe('0')
    expect(
      (await pool.query('SELECT project_id FROM request_project_facts WHERE request_id=$1', [event.request_id])).rows[0]
        .project_id,
    ).toBe('project-a')
    expect(await deliver(event)).toMatchObject({ disposition: 'replayed' })
    expect((await pool.query('SELECT count(*) FROM ledger_transactions')).rows).toEqual(ledgerBefore)
  })

it('keeps managed price mandatory and unpriced BYOK pins immutable in PostgreSQL', async () => {
  await expect(fixture(undefined, 'managed', undefined, null)).rejects.toThrow(
    'attempt capture requires complete identity and pins',
  )
  const event = await fixture(undefined, 'byok', undefined, null)
  await expect(
    pool.query("UPDATE attempts SET price_version_id='price' WHERE id=$1", [event.attempt_id]),
  ).rejects.toThrow('captured attempt identity and pins are immutable')
})

it.each([
  { name: 'managed', mode: 'managed' as const, priceId: 'price', reason: null },
  { name: 'byok', mode: 'byok' as const, priceId: 'price', reason: null },
  { name: 'unpriced_byok', mode: 'byok' as const, priceId: null, reason: 'missing_price_version' },
  { name: 'unknown_byok', mode: 'byok' as const, priceId: 'price', reason: 'unknown_completion' },
])(
  'keeps repeated provider metadata separate for distinct $name operations',
  async ({ name, mode, priceId, reason }) => {
    const events = [
      await fixture(undefined, mode, undefined, priceId),
      await fixture(undefined, mode, undefined, priceId),
    ]
    const requestIds = events.map((event) => event.request_id)
    const providerRequestId = `req_r39_diagnostic_${name}`
    expect(new Set(requestIds).size).toBe(2)
    expect(new Set(events.map((event) => event.attempt_id)).size).toBe(2)
    expect(new Set(events.map((event) => event.event_id)).size).toBe(2)
    // Independent frozen operation facts isolate the Worker anchor from Gateway attempt persistence.
    for (const event of events) {
      event.provider_request_id = providerRequestId
      if (reason === 'unknown_completion') {
        event.status = 'unknown'
        event.usage.estimated = true
        await pool.query("UPDATE request_records SET status='unknown' WHERE tenant_id='tenant' AND id=$1", [
          event.request_id,
        ])
        await pool.query("UPDATE attempts SET status='unknown' WHERE tenant_id='tenant' AND id=$1", [event.attempt_id])
      }
    }
    const walletBalance = async () => {
      const client = await pool.connect()
      try {
        return await getWalletBalance('tenant', 'wallet', client)
      } finally {
        client.release()
      }
    }
    const facts = async () => ({
      anchors: (
        await pool.query(
          "SELECT * FROM usage_events WHERE tenant_id='tenant' AND request_id=ANY($1::text[]) ORDER BY request_id,id",
          [requestIds],
        )
      ).rows,
      records: (
        await pool.query(
          "SELECT * FROM usage_records WHERE tenant_id='tenant' AND request_id=ANY($1::text[]) ORDER BY request_id,id",
          [requestIds],
        )
      ).rows,
      ledger: (
        await pool.query(
          "SELECT * FROM ledger_transactions WHERE tenant_id='tenant' AND reference_id=ANY($1::text[]) ORDER BY reference_id,id",
          [requestIds],
        )
      ).rows,
      cases: (
        await pool.query(
          "SELECT * FROM reconciliation_cases WHERE tenant_id='tenant' AND request_id=ANY($1::text[]) ORDER BY request_id,id",
          [requestIds],
        )
      ).rows,
    })
    const walletBefore = await walletBalance()
    const charge = mode === 'managed' ? 290n : 0n
    for (const event of events)
      expect(await deliver(event)).toMatchObject({
        requestId: event.request_id,
        disposition: reason ? 'reconciled' : 'settled',
        channelKind: mode === 'managed' ? 'platform' : 'byok',
        chargeMicros: charge,
        ...(reason ? { detail: reason } : {}),
      })
    const stored = await facts()
    expect(stored.anchors).toHaveLength(2)
    expect(new Set(stored.anchors.map((anchor) => anchor.id)).size).toBe(2)
    expect(stored.records).toHaveLength(reason ? 0 : 2)
    expect(stored.ledger).toHaveLength(reason ? 0 : 2)
    expect(stored.cases).toHaveLength(reason ? 2 : 0)
    for (const event of events) {
      const anchor = stored.anchors.find((row) => row.request_id === event.request_id)
      expect(anchor).toMatchObject({
        attempt_id: event.attempt_id,
        event_id: event.event_id,
        provider_request_id: providerRequestId,
        event_type: `usage.v2.${event.status}`,
        payload: { event },
      })
      expect(anchor.payload.event).toEqual(event)
      if (reason) {
        expect(stored.cases.filter((row) => row.request_id === event.request_id)).toEqual([
          expect.objectContaining({ usage_event_id: anchor.id, reason, status: 'open' }),
        ])
      } else {
        expect(stored.records.filter((row) => row.request_id === event.request_id)).toEqual([
          expect.objectContaining({
            usage_event_id: anchor.id,
            input_tokens: 50,
            output_tokens: 10,
            cached_tokens: 50,
            reasoning_tokens: 10,
            upstream_cost_amount: '290',
            charge_amount: charge.toString(),
            authoritative_metering: event,
            calculator_version: 'nexus-billing-inclusive-v3',
          }),
        ])
        expect(stored.ledger.filter((row) => row.reference_id === event.request_id)).toEqual([
          expect.objectContaining({ idempotency_key: `usage:${event.request_id}` }),
        ])
      }
      expect(await deliver(event)).toMatchObject({ requestId: event.request_id, disposition: 'replayed' })
    }
    const changedMetadata = structuredClone(events[0])
    changedMetadata.provider_request_id = `${providerRequestId}_changed`
    await expect(deliver(changedMetadata)).rejects.toMatchObject({ code: 'event_replay_mismatch' })
    const changedUsage = structuredClone(events[1])
    changedUsage.usage.input_tokens = 101
    changedUsage.usage.total_tokens = 121
    await expect(deliver(changedUsage)).rejects.toMatchObject({ code: 'event_replay_mismatch' })
    expect(await facts()).toEqual(stored)
    expect(await walletBalance()).toBe(walletBefore - 2n * charge)
  },
)
