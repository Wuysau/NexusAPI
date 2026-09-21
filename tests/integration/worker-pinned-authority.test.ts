import { describe, expect, it, vi } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { computePinnedCharge, loadPinnedPricing, type Queryable, type RequestRecordRow } from '@/lib/billing/pipeline'
import { processOutboxEvent, type OutboxEventRow } from '../../services/worker/processor'
import type { NexusUsageEventV1 } from '../../packages/contracts/usage-event'
import { loadSaleSnapshot, type SaleSnapshotRow } from '@/lib/catalog/sale-snapshot'
import { ensureSystemLedgerAccount, postTransaction } from '@/lib/db/ledger'

// Query doubles exercise the real pricing/processor without touching another
// suite's database while isolated PostgreSQL fixtures are being prepared.
vi.mock('@/db', () => ({ pool: {}, db: {} }))

const request: RequestRecordRow = {
  id: 'request-a',
  tenant_id: 'tenant-a',
  channel_kind: 'platform',
  status: 'completed',
  provider_price_version_id: 'price-a',
  sale_price_snapshot_id: 'sale-a',
  exchange_rate_snapshot_id: null,
  reservation_amount: '12000000',
  reservation_released: false,
  charge_amount: '0',
  charge_currency: 'USD',
  upstream_cost_amount: null,
  upstream_cost_currency: null,
  resolved_provider_id: 'provider-a',
  resolved_upstream_model_id: 'model-a',
  request_model: 'model-a',
  input_tokens: 1000000,
  output_tokens: 500000,
  cached_tokens: 0,
  reasoning_tokens: 0,
}
const price = {
  id: 'price-a',
  provider_id: 'provider-a',
  upstream_model_id: 'model-a',
  currency: 'USD',
  unit: 'per_million_tokens',
  input_price: '2.5',
  output_price: '10',
  cached_input_price: '0',
  reasoning_price: '0',
  request_price: '0',
  image_price: '0',
  audio_price: '0',
  status: 'superseded',
}
const snapshot: SaleSnapshotRow & { rule_id: string; pricing_mode: string } = {
  providerCurrency: 'USD',
  id: 'sale-a',
  ruleId: 'rule-a',
  providerPriceVersionId: 'price-a',
  exchangeRateSnapshotId: null,
  pricingMode: 'markup',
  inputPrice: '3.75',
  outputPrice: '15',
  cachedInputPrice: '0',
  reasoningPrice: '0',
  fixedFee: '0',
  minimumCharge: '0',
  currency: 'USD',
  // Legacy loader fields let the red test show it follows the mutated rule.
  rule_id: 'rule-a',
  pricing_mode: 'markup',
}
function pricingDb(sale = snapshot): Queryable {
  return {
    query: async <T>(sql: string) => {
      if (sql.includes('FROM provider_price_versions')) return { rows: [price as T] }
      if (sql.includes('FROM sale_price_snapshots')) return { rows: [sale as T] }
      if (sql.includes('FROM sale_price_rules'))
        return {
          rows: [
            {
              id: 'rule-a',
              pricing_mode: 'markup',
              markup_rate: '9',
              target_margin_rate: '0',
              fixed_fee: '0',
              minimum_charge: '0',
              currency: 'USD',
            } as T,
          ],
        }
      throw new Error('Unexpected query: ' + sql)
    },
  }
}

function event(): NexusUsageEventV1 {
  return {
    schema_version: 1,
    event_id: 'event-authority-0001',
    occurred_at: '2026-09-15T00:00:00Z',
    tenant_id: 'tenant-a',
    request_id: 'request-a',
    attempt_id: 'attempt-a',
    model_id: 'model-a',
    status: 'completed',
    price_version_id: 'price-a',
    catalog_version_id: 'catalog-a',
    usage: { input_tokens: 1000000, output_tokens: 500000, estimated: false },
  }
}

describe('Worker pinned pricing authority', () => {
  it('uses frozen sale rates after the originating rule changes', async () => {
    const pricing = await loadPinnedPricing(pricingDb(), 'tenant-a', request)
    const charge = computePinnedCharge(pricing, { input: 1000000, output: 500000, cached: 0, reasoning: 0 })
    expect(charge.saleCharge).toBe(11250000n)
    expect(charge.upstreamCost).toBe(7500000n)
  })
  it('does not recover a missing durable provider pin from the event', async () => {
    await expect(
      loadPinnedPricing(pricingDb(), 'tenant-a', { ...request, provider_price_version_id: null }, 'price-a'),
    ).rejects.toMatchObject({ code: 'missing_price_version' })
  })
  it('rejects an event attempting to override the durable provider pin', async () => {
    await expect(loadPinnedPricing(pricingDb(), 'tenant-a', request, 'price-b')).rejects.toMatchObject({
      code: 'price_version_mismatch',
    })
  })
  it('refuses platform billing without a sale snapshot', async () => {
    await expect(
      loadPinnedPricing(pricingDb(), 'tenant-a', { ...request, sale_price_snapshot_id: null }),
    ).rejects.toMatchObject({ code: 'missing_sale_snapshot' })
  })
  it('rejects a sale snapshot attached to another provider version', async () => {
    await expect(
      loadPinnedPricing(pricingDb({ ...snapshot, providerPriceVersionId: 'price-b' }), 'tenant-a', request),
    ).rejects.toMatchObject({ code: 'snapshot_pin_mismatch' })
  })
  it('allows BYOK provider cost without inventing a sale price', async () => {
    const pricing = await loadPinnedPricing(pricingDb(), 'tenant-a', {
      ...request,
      channel_kind: 'byok',
      sale_price_snapshot_id: null,
    })
    expect(computePinnedCharge(pricing, { input: 1000000, output: 500000, cached: 0, reasoning: 0 }).saleCharge).toBe(
      0n,
    )
  })
  it('refuses crosscurrency snapshots without trustworthy frozen-rate provenance', async () => {
    const db = pricingDb({ ...snapshot, currency: 'EUR', exchangeRateSnapshotId: 'fx-a' } as typeof snapshot)
    const client: Queryable = {
      query: async <T>(sql: string, params?: unknown[]) =>
        sql.includes('FROM exchange_rate_snapshots')
          ? { rows: [{ base_currency: 'USD', quote_currency: 'EUR', rate: '0.9' } as T] }
          : db.query<T>(sql, params),
    }
    await expect(
      loadPinnedPricing(client, 'tenant-a', { ...request, charge_currency: 'EUR', exchange_rate_snapshot_id: 'fx-a' }),
    ).rejects.toMatchObject({ code: 'unsupported_snapshot_currency' })
  })

  it.each(['price', 'tokens', 'status', 'tenant', 'request'])(
    'rejects conflicting %s authority before any write',
    async (field) => {
      const payload = event()
      if (field === 'price') payload.price_version_id = 'price-b'
      if (field === 'tokens') payload.usage.input_tokens = 1
      if (field === 'status') payload.status = 'failed'
      if (field === 'tenant') payload.tenant_id = 'tenant-b'
      if (field === 'request') payload.request_id = 'request-b'
      const writes: string[] = []
      const client = {
        query: async (sql: string) => {
          if (!sql.trimStart().startsWith('SELECT')) {
            writes.push(sql)
            throw new Error('unexpected mutation')
          }
          if (sql.includes('FROM usage_events')) return { rows: [] }
          if (sql.includes('FROM request_records')) return { rows: [request] }
          if (sql.includes('SELECT attempt_number')) return { rows: [{ attempt_number: 1 }] }
          if (sql.includes('max(attempt_number)')) return { rows: [{ max: 1 }] }
          return { rows: [] }
        },
      } as unknown as PoolClient
      const row: OutboxEventRow = {
        id: 'outbox-a',
        tenant_id: 'tenant-a',
        aggregate_type: 'usage',
        aggregate_id: 'request-a',
        event_type: `usage.${payload.status}`,
        payload,
        idempotency_key: 'outbox-key',
        attempts: 0,
      }
      await expect(processOutboxEvent(client, row)).rejects.toHaveProperty('code')
      expect(writes).toEqual([])
    },
  )
})

/** Real PostgreSQL transaction; isolated fixture schema must already be migrated. */
async function withFixture<T>(
  run: (client: PoolClient, row: OutboxEventRow, record: RequestRecordRow) => Promise<T>,
): Promise<T> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the isolated Worker fixture')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const tenantId = `authority-${randomUUID()}`
    const organizationId = randomUUID()
    const providerId = randomUUID()
    const priceId = randomUUID()
    const saleId = randomUUID()
    const ruleId = randomUUID()
    const requestId = randomUUID()
    const attemptId = randomUUID()
    await client.query(
      `INSERT INTO organizations (id,tenant_id,name,slug,status) VALUES ($1,$2,'authority',$2,'active')`,
      [organizationId, tenantId],
    )
    await client.query(
      `INSERT INTO providers (id,code,name,official_base_url,auth_scheme,enabled) VALUES ($1,$2,'authority','https://provider.test','bearer',true)`,
      [providerId, tenantId],
    )
    await client.query(
      `INSERT INTO provider_price_versions (id,provider_id,upstream_model_id,currency,unit,input_price,cached_input_price,output_price,reasoning_price,request_price,image_price,audio_price,status,source_type)
      VALUES ($1,$2,'model-a','USD','per_million_tokens','2.5','0','10','0','0','0','0','active','manual')`,
      [priceId, providerId],
    )
    await client.query(
      `INSERT INTO sale_price_rules (id,tenant_id,organization_id,provider_id,upstream_model_id,pricing_mode,markup_rate,target_margin_rate,fixed_fee,minimum_charge,currency,enabled)
      VALUES ($1,$2,$3,$4,'model-a','markup','9','0','0','0','USD',true)`,
      [ruleId, tenantId, organizationId, providerId],
    )
    await client.query(
      `INSERT INTO sale_price_snapshots (id,rule_id,provider_price_version_id,pricing_mode,input_price,output_price,cached_input_price,reasoning_price,fixed_fee,minimum_charge,currency)
      VALUES ($1,$2,$3,'markup','3.75','15','0','0','0','0','USD')`,
      [saleId, ruleId, priceId],
    )
    await client.query(
      `INSERT INTO request_records (id,organization_id,tenant_id,request_model,resolved_provider_id,resolved_upstream_model_id,channel_kind,status,input_tokens,output_tokens,provider_price_version_id,sale_price_snapshot_id,charge_currency)
      VALUES ($1,$2,$3,'model-a',$4,'model-a','platform','completed',1000000,500000,$5,$6,'USD')`,
      [requestId, organizationId, tenantId, providerId, priceId, saleId],
    )
    await client.query(
      `INSERT INTO attempts (id,request_id,tenant_id,provider_id,attempt_number,status,started_at)
      VALUES ($1,$2,$3,$4,1,'completed',now())`,
      [attemptId, requestId, tenantId, providerId],
    )
    const payload = {
      ...event(),
      event_id: randomUUID(),
      tenant_id: tenantId,
      request_id: requestId,
      attempt_id: attemptId,
      price_version_id: priceId,
    }
    const row: OutboxEventRow = {
      id: randomUUID(),
      tenant_id: tenantId,
      aggregate_type: 'usage',
      aggregate_id: requestId,
      event_type: 'usage.completed',
      payload,
      idempotency_key: randomUUID(),
      attempts: 0,
    }
    const stored = await client.query<RequestRecordRow>('SELECT * FROM request_records WHERE id=$1', [requestId])
    return await run(client, row, stored.rows[0])
  } finally {
    await client.query('ROLLBACK')
    client.release()
    await pool.end()
  }
}

describe('Worker authority with PostgreSQL', () => {
  it('opens reconciliation for an already-posted request whose sale pin is missing', async () => {
    await withFixture(async (client, row, record) => {
      const debit = await ensureSystemLedgerAccount(row.tenant_id, 'clearing', 'USD', client)
      const credit = await ensureSystemLedgerAccount(row.tenant_id, 'revenue', 'USD', client)
      await postTransaction(
        {
          tenantId: row.tenant_id,
          type: 'usage',
          currency: 'USD',
          idempotencyKey: `usage:${record.id}`,
          postings: [
            { accountId: debit, amount: 11250000n, entryType: 'debit' },
            { accountId: credit, amount: 11250000n, entryType: 'credit' },
          ],
        },
        client,
      )
      await client.query('UPDATE request_records SET sale_price_snapshot_id=NULL WHERE id=$1', [record.id])
      const outcome = await processOutboxEvent(client, row)
      expect(outcome).toMatchObject({ disposition: 'replayed', chargeMicros: 11250000n })
      const cases = await client.query('SELECT reason FROM reconciliation_cases WHERE request_id=$1', [record.id])
      expect(cases.rows).toEqual([{ reason: 'missing_sale_snapshot' }])
      expect(
        (await client.query('SELECT count(*) FROM ledger_transactions WHERE tenant_id=$1', [row.tenant_id])).rows[0]
          .count,
      ).toBe('1')
    })
  })
  it('maps actual snapshot columns and charges frozen rates despite a different current rule', async () => {
    await withFixture(async (client, row, record) => {
      const sale = await loadSaleSnapshot(client, record.sale_price_snapshot_id!)
      expect(sale).toMatchObject({
        providerPriceVersionId: record.provider_price_version_id,
        inputPrice: '3.75000000',
        outputPrice: '15.00000000',
      })
      const pricing = await loadPinnedPricing(client, row.tenant_id, record)
      expect(computePinnedCharge(pricing, { input: 1000000, output: 500000, cached: 0, reasoning: 0 }).saleCharge).toBe(
        11250000n,
      )
    })
  })
  it.each(['price', 'tokens', 'status', 'tenant'])(
    'rejects conflicting %s before inserting usage, audit or ledger rows',
    async (field) => {
      await withFixture(async (client, row, record) => {
        const payload = row.payload as NexusUsageEventV1
        if (field === 'price') payload.price_version_id = randomUUID()
        if (field === 'tokens') payload.usage.input_tokens = 1
        if (field === 'status') {
          payload.status = 'failed'
          row.event_type = 'usage.failed'
        }
        if (field === 'tenant') payload.tenant_id = 'another-tenant'
        await expect(processOutboxEvent(client, row)).rejects.toHaveProperty('code')
        for (const table of ['usage_events', 'usage_records', 'ledger_transactions', 'audit_events']) {
          const count = await client.query(`SELECT count(*) FROM ${table} WHERE tenant_id=$1`, [row.tenant_id])
          expect(count.rows[0].count, table).toBe('0')
        }
        const unchanged = await client.query(
          'SELECT status,input_tokens,provider_price_version_id FROM request_records WHERE id=$1',
          [record.id],
        )
        expect(unchanged.rows[0]).toEqual({
          status: 'completed',
          input_tokens: 1000000,
          provider_price_version_id: record.provider_price_version_id,
        })
      })
    },
  )
  it('quarantines missing sale pins without charging and replays the event idempotently', async () => {
    await withFixture(async (client, row, record) => {
      await client.query('UPDATE request_records SET sale_price_snapshot_id=NULL WHERE id=$1', [record.id])
      const first = await processOutboxEvent(client, row)
      expect(first).toMatchObject({ disposition: 'reconciled', detail: 'missing_sale_snapshot' })
      expect((await processOutboxEvent(client, row)).disposition).toBe('replayed')
      expect(
        (await client.query('SELECT count(*) FROM reconciliation_cases WHERE request_id=$1', [record.id])).rows[0]
          .count,
      ).toBe('1')
      expect(
        (await client.query('SELECT count(*) FROM ledger_transactions WHERE tenant_id=$1', [row.tenant_id])).rows[0]
          .count,
      ).toBe('0')
      const changed = structuredClone(row)
      ;(changed.payload as NexusUsageEventV1).usage.input_tokens = 1
      await expect(processOutboxEvent(client, changed)).rejects.toMatchObject({ code: 'event_replay_mismatch' })
    })
  })
})
