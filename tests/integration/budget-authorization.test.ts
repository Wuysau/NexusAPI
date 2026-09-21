import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { authorizeBudget } from '../../services/budget/authorize'
import {
  postWalletCredit,
  getWalletBalance,
  ensureSystemLedgerAccount,
  ensureWalletLedgerAccount,
  postTransaction,
} from '@/lib/db/ledger'
import type { BudgetRequestV1 } from '../../packages/contracts/budget'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
let base: BudgetRequestV1
let wallet: string
beforeAll(async () => {
  const c = await pool.connect()
  try {
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    for (const file of [
      '0000_left_nekra.sql',
      '0001_greedy_shape.sql',
      '0002_auth_secret_plane.sql',
      '0003_worker_outbox_retry.sql',
    ]) {
      await c.query(readFileSync(`drizzle/${file}`, 'utf8'))
    }
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
const reserve = (change: Partial<BudgetRequestV1> = {}) =>
  authorizeBudget(pool, { ...base, request_id: randomUUID(), ...change })

describe('independent PostgreSQL budget authorization', () => {
  it('persists a frozen request and balanced hold atomically; replay preserves expiry and amount', async () => {
    const req = { ...base, request_id: randomUUID() }
    const first = await authorizeBudget(pool, req)
    expect(first.amount_micros).toBe('1000000')
    const second = await authorizeBudget(pool, req)
    expect(second).toEqual({ ...first, replayed: true })
    const r = (await pool.query('SELECT * FROM request_records WHERE tenant_id=$1 AND id=$2', ['t', req.request_id]))
      .rows[0]
    expect(r.status).toBe('reserved')
    expect(r.sale_price_snapshot_id).toBe('sp')
    expect(r.reservation_amount).toBe('1000000')
    expect(
      (
        await pool.query('SELECT sum(amount)::text AS sum FROM ledger_postings WHERE transaction_id=$1', [
          first.reservation_id,
        ])
      ).rows[0].sum,
    ).toBe('0')
    await expect(authorizeBudget(pool, { ...req, estimated_input_tokens: 2_000_000 })).rejects.toMatchObject({
      code: 'authorization_conflict',
    })
  })
  it('rejects cross-tenant, cross-org, mismatched and absent snapshot pins', async () => {
    for (const change of [
      { tenant_id: 'other' },
      { organization_id: 'other' },
      { sale_price_snapshot_id: 'missing' },
      { price_version_id: 'missing' },
      { model_id: 'other' },
      { exchange_rate_snapshot_id: 'missing' },
    ]) {
      await expect(reserve(change)).rejects.toBeDefined()
    }
  })
  it('uses frozen rates even when the live rule changes', async () => {
    await pool.query("UPDATE sale_price_rules SET markup_rate='99' WHERE id='rule'")
    expect((await reserve()).amount_micros).toBe('1000000')
  })
  it('serializes competing holds before checking available balance', async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => reserve()))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(8)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(4)
    const c = await pool.connect()
    try {
      expect(await getWalletBalance('t', wallet, c)).toBe(0n)
    } finally {
      c.release()
    }
  })
  it('does not reinterpret an N-1 ledger-only reservation as a new authorization', async () => {
    const requestId = 'legacy-ledger-only'
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await postWalletCredit('t', wallet, 5_000_000n, 'fund-legacy', 'recharge', undefined, undefined, c)
      const wa = await ensureWalletLedgerAccount('t', wallet, 'USD', c)
      const ra = await ensureSystemLedgerAccount('t', 'reservation', 'USD', c)
      await postTransaction(
        {
          tenantId: 't',
          type: 'reservation',
          currency: 'USD',
          idempotencyKey: `reservation:${requestId}`,
          referenceType: 'request',
          referenceId: requestId,
          postings: [
            { accountId: wa, amount: 3_000_000n, entryType: 'debit' },
            { accountId: ra, amount: 3_000_000n, entryType: 'credit' },
          ],
        },
        c,
      )
      await c.query('COMMIT')
    } finally {
      c.release()
    }
    const before = (await pool.query('SELECT count(*)::int AS count FROM ledger_postings')).rows
    await expect(authorizeBudget(pool, { ...base, request_id: requestId })).rejects.toMatchObject({
      code: 'legacy_authorization_missing',
    })
    expect((await pool.query('SELECT id FROM request_records WHERE id=$1', [requestId])).rowCount).toBe(0)
    expect((await pool.query('SELECT count(*)::int AS count FROM ledger_postings')).rows).toEqual(before)
  })
  it('persists client idempotency and refuses duplicate dispatch or expired/terminal grants', async () => {
    const req = { ...base, request_id: 'durable-client-key', idempotency_key: 'application-operation-1' }
    await authorizeBudget(pool, req)
    const before = (await pool.query('SELECT count(*)::int count FROM ledger_postings')).rows
    await expect(authorizeBudget(pool, { ...req, request_id: 'another-gateway' })).rejects.toMatchObject({
      code: 'authorization_conflict',
    })
    expect(
      (await pool.query('SELECT idempotency_key FROM request_records WHERE id=$1', [req.request_id])).rows[0]
        .idempotency_key,
    ).toBe(req.idempotency_key)
    await pool.query("UPDATE request_records SET reservation_expires_at=now()-interval '1 second' WHERE id=$1", [
      req.request_id,
    ])
    await expect(authorizeBudget(pool, req)).rejects.toMatchObject({ code: 'authorization_expired' })
    await pool.query(
      "UPDATE request_records SET reservation_expires_at=now()+interval '10 minutes',status='completed' WHERE id=$1",
      [req.request_id],
    )
    await expect(authorizeBudget(pool, req)).rejects.toMatchObject({ code: 'authorization_expired' })
    expect((await pool.query('SELECT count(*)::int count FROM ledger_postings')).rows).toEqual(before)
  })
})
