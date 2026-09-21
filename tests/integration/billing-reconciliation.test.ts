// Integration tests for Work Item F — usage relay, billing pipeline and
// reconciliation.
//
// Requires a real Postgres (DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db).
// Resets the public schema and applies migrations 0000, 0001, 0002 and the
// worker's additive 0003, so it is independent of test ordering.
//
// Coverage (the brief's seven scenarios plus the E2 alignment and failure paths):
//   1. duplicate outbox event           → one debit, second delivery replays
//   2. out-of-order / stale attempts    → the final attempt owns the charge
//   3. worker crash mid-batch           → rollback, then exactly one debit
//   4. unknown terminal state           → reconciliation, hold kept, no retry
//   5. BYOK vs managed                  → separate accounts, no revenue mixing
//   6. historical recompute             → pinned versions reproduce the charge
//   7. reservation timeout              → released + flagged, never re-released
//   8. settle-route already posted      → worker replays, does not double-post
//   9. completed with no usage          → reconciliation, hold kept
//  10. transient failure + dead letter  → backoff then dead-letter
//
// Requires DATABASE_URL in the environment (the gate sets it).

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool } from 'pg'
import {
  ensureSystemLedgerAccount,
  ensureWalletLedgerAccount,
  postTransaction,
  postWalletCredit,
  getWalletBalance,
} from '@/lib/db/ledger'
import { getPostedDebitTotal, releaseReservation, reservationReleaseKey, usageKey } from '@/lib/billing/pipeline'
import { auditRequestCharge, recomputeRequestCharge } from '@/lib/billing/recompute'
import { auditSettledCharges, resolveReconciliationCase, runReconciliation } from '@/lib/billing/reconcile'
import { pollOutboxOnce } from '../../services/worker/consumer'
import type { WorkerConfig } from '../../services/worker/config'
import type { NexusUsageEventV1, UsageEventStatus } from '@/../packages/contracts/usage-event'
import type { PoolClient } from 'pg'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/app_db'
const pool = new Pool({ connectionString: DATABASE_URL })

// Exact charge math for the fixture below:
//   upstream = 2.50/1M × 1,000,000 + 10.00/1M × 500,000 = 7.50 USD
//   sale     = upstream × (1 + 0.5) = 11.25 USD
const INPUT_PRICE = '2.50'
const OUTPUT_PRICE = '10.00'
const MARKUP_RATE = '0.5'
const INPUT_TOKENS = 1_000_000
const OUTPUT_TOKENS = 500_000
const UPSTREAM_COST = 7_500_000n
const SALE_CHARGE = 11_250_000n
const FUNDING = 100_000_000n
const HOLD = 12_000_000n

const TENANT_A = 'tenant-a'
const TENANT_B = 'tenant-b'
const TENANT_C = 'tenant-c'
const MODEL = 'gpt-4o'

const config: WorkerConfig = {
  databaseUrl: DATABASE_URL,
  workerId: 'test-worker',
  pollIntervalMs: 50,
  batchSize: 100,
  maxAttempts: 3,
  backoffBaseMs: 100,
  backoffMaxMs: 1_000,
  reconcileIntervalMs: 60_000,
}

let orgA: string
let orgB: string
let orgC: string
let walletA: string
let providerId: string
let priceVersionId: string
let saleSnapshotId: string

function readMigration(name: string): string {
  return readFileSync(join(process.cwd(), 'drizzle', name), 'utf-8')
}

async function resetDatabase(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE')
    await client.query('CREATE SCHEMA public')
    await client.query('GRANT ALL ON SCHEMA public TO postgres')
    await client.query('GRANT ALL ON SCHEMA public TO public')
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    await client.query(readMigration('0000_left_nekra.sql'))
    await client.query(readMigration('0001_greedy_shape.sql'))
    await client.query(readMigration('0002_auth_secret_plane.sql'))
    await client.query(readMigration('0003_worker_outbox_retry.sql'))
  } finally {
    client.release()
  }
}

// ── fixture helpers ────────────────────────────────────────────────────

async function seedTenants(): Promise<void> {
  orgA = `org-${randomUUID()}`
  orgB = `org-${randomUUID()}`
  orgC = `org-${randomUUID()}`
  await pool.query(
    `INSERT INTO organizations (id, tenant_id, name, slug, status)
     VALUES ($1,$4,'A','a-'||$4,'active'), ($2,$5,'B','b-'||$5,'active'), ($3,$6,'C','c-'||$6,'active')`,
    [orgA, orgB, orgC, TENANT_A, TENANT_B, TENANT_C],
  )

  const provider = await pool.query<{ id: string }>(
    `INSERT INTO providers (id, code, name, official_base_url, auth_scheme, enabled)
     VALUES (gen_random_uuid(), 'openai', 'OpenAI', 'https://api.openai.com/v1', 'bearer', true)
     RETURNING id`,
  )
  providerId = provider.rows[0].id

  const price = await pool.query<{ id: string }>(
    `INSERT INTO provider_price_versions
       (id, provider_id, upstream_model_id, currency, unit, input_price, cached_input_price,
        output_price, reasoning_price, request_price, image_price, audio_price, status, source_type)
     VALUES (gen_random_uuid(), $1, $2, 'USD', 'per_million_tokens', $3, '0', $4, '0', '0', '0', '0', 'active', 'manual')
     RETURNING id`,
    [providerId, MODEL, INPUT_PRICE, OUTPUT_PRICE],
  )
  priceVersionId = price.rows[0].id

  await pool.query(
    `INSERT INTO sale_price_rules
       (id, tenant_id, organization_id, provider_id, upstream_model_id, pricing_mode,
        markup_rate, target_margin_rate, fixed_fee, minimum_charge, currency, enabled)
     VALUES (gen_random_uuid(), NULL, NULL, $1, $2, 'markup', $3, '0', '0', '0', 'USD', true)`,
    [providerId, MODEL, MARKUP_RATE],
  )

  const snapshot = await pool.query<{ id: string }>(
    `INSERT INTO sale_price_snapshots
       (id, rule_id, provider_price_version_id, pricing_mode, input_price, output_price,
        cached_input_price, reasoning_price, fixed_fee, minimum_charge, currency)
     SELECT gen_random_uuid(), id, $1, 'markup', '3.75', '15', '0', '0', '0', '0', 'USD'
       FROM sale_price_rules WHERE provider_id=$2 RETURNING id`,
    [priceVersionId, providerId],
  )
  saleSnapshotId = snapshot.rows[0].id

  const wallet = await pool.query<{ id: string }>(
    `INSERT INTO wallet_accounts (id, organization_id, tenant_id, currency, status)
     VALUES (gen_random_uuid(), $1, $2, 'USD', 'active') RETURNING id`,
    [orgA, TENANT_A],
  )
  walletA = wallet.rows[0].id
  await postWalletCredit(TENANT_A, walletA, FUNDING, `recharge:${randomUUID()}`)
}

async function createRequest(input: {
  tenantId: string
  orgId: string
  channelKind?: 'platform' | 'byok'
  status?: string
  inputTokens?: number
  outputTokens?: number
  reservationAmount?: bigint
  reservationExpiresAt?: Date | null
  providerPriceVersionId?: string | null
}): Promise<string> {
  const id = `req_${randomUUID()}`
  await pool.query(
    `INSERT INTO request_records
       (id, organization_id, tenant_id, request_model, resolved_provider_id, resolved_upstream_model_id,
        channel_kind, status, input_tokens, output_tokens, provider_price_version_id,
        reservation_amount, reservation_expires_at, charge_amount, charge_currency, idempotency_key,
        started_at, completed_at, sale_price_snapshot_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,'USD',$14, now(), $15, $16)`,
    [
      id,
      input.orgId,
      input.tenantId,
      MODEL,
      providerId,
      MODEL,
      input.channelKind ?? 'platform',
      input.status ?? 'completed',
      input.inputTokens ?? INPUT_TOKENS,
      input.outputTokens ?? OUTPUT_TOKENS,
      input.providerPriceVersionId === undefined ? priceVersionId : input.providerPriceVersionId,
      (input.reservationAmount ?? 0n).toString(),
      input.reservationExpiresAt ?? null,
      `req-idem:${id}`,
      input.status === 'completed' ? new Date() : null,
      (input.channelKind ?? 'platform') === 'platform' ? saleSnapshotId : null,
    ],
  )
  return id
}

async function createAttempt(input: {
  requestId: string
  tenantId: string
  number: number
  status: 'pending' | 'sent' | 'streaming' | 'completed' | 'failed' | 'retried'
}): Promise<string> {
  const id = `att_${randomUUID()}`
  await pool.query(
    `INSERT INTO attempts (id, request_id, tenant_id, provider_id, attempt_number, status, started_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())`,
    [id, input.requestId, input.tenantId, providerId, input.number, input.status],
  )
  return id
}

function makeEvent(input: {
  tenantId: string
  requestId: string
  attemptId: string
  status: UsageEventStatus
  eventId?: string
  inputTokens?: number
  outputTokens?: number
  estimated?: boolean
}): NexusUsageEventV1 {
  return {
    schema_version: 1,
    event_id: input.eventId ?? `evt_${randomBytes(16).toString('hex')}`,
    occurred_at: new Date().toISOString(),
    tenant_id: input.tenantId,
    request_id: input.requestId,
    attempt_id: input.attemptId,
    provider_request_id: `up_${randomUUID()}`,
    model_id: MODEL,
    status: input.status,
    price_version_id: priceVersionId,
    catalog_version_id: 'cat-1',
    usage: {
      input_tokens: input.inputTokens ?? INPUT_TOKENS,
      cached_input_tokens: 0,
      output_tokens: input.outputTokens ?? OUTPUT_TOKENS,
      reasoning_tokens: 0,
      estimated: input.estimated ?? false,
    },
  }
}

async function enqueue(
  event: NexusUsageEventV1,
  options: { idempotencyKey?: string; createdAt?: Date; rawPayload?: unknown } = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, status, created_at)
     VALUES ($1,'usage',$2,$3,$4::jsonb,$5,'pending', COALESCE($6, now()))
     RETURNING id`,
    [
      event.tenant_id,
      event.request_id,
      `usage.${event.status}`,
      JSON.stringify(options.rawPayload ?? event),
      options.idempotencyKey ?? `evt:${event.event_id}`,
      options.createdAt ?? null,
    ],
  )
  return result.rows[0].id
}

async function postHold(tenantId: string, walletId: string, requestId: string, amount: bigint): Promise<void> {
  const walletAccountId = await ensureWalletLedgerAccount(tenantId, walletId, 'USD')
  const reservationAccountId = await ensureSystemLedgerAccount(tenantId, 'reservation', 'USD')
  await postTransaction({
    tenantId,
    type: 'reservation',
    currency: 'USD',
    idempotencyKey: `reservation:${requestId}`,
    postings: [
      { accountId: walletAccountId, amount, entryType: 'debit' },
      { accountId: reservationAccountId, amount, entryType: 'credit' },
    ],
    referenceType: 'request',
    referenceId: requestId,
  })
}

async function runPoll(): Promise<Awaited<ReturnType<typeof pollOutboxOnce>>> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const summary = await pollOutboxOnce(client, config)
    await client.query('COMMIT')
    return summary
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const result = await pool.query<{ n: string }>(sql, params)
  return Number(result.rows[0].n)
}

async function txCount(tenantId: string, idempotencyKey: string): Promise<number> {
  return count(`SELECT count(*) AS n FROM ledger_transactions WHERE tenant_id=$1 AND idempotency_key=$2`, [
    tenantId,
    idempotencyKey,
  ])
}

async function usageRecordCount(requestId: string): Promise<number> {
  return count(`SELECT count(*) AS n FROM usage_records WHERE request_id=$1`, [requestId])
}

async function caseRows(requestId: string) {
  const result = await pool.query<{
    id: string
    reason: string
    status: string
    expected_amount: string | null
    actual_amount: string | null
  }>(
    `SELECT id, reason, status, expected_amount, actual_amount FROM reconciliation_cases WHERE request_id=$1 ORDER BY created_at`,
    [requestId],
  )
  return result.rows
}

async function walletPostings(tenantId: string, walletId: string, joinAccountType?: string) {
  const result = await pool.query<{ entry_type: string; amount: string; type: string; code: string }>(
    `SELECT lp.entry_type, lp.amount, la.type, la.code
       FROM ledger_postings lp JOIN ledger_accounts la ON la.id = lp.account_id
      WHERE lp.tenant_id=$1 AND la.wallet_id=$2 ${joinAccountType ? 'AND la.type=$3' : ''}`,
    joinAccountType ? [tenantId, walletId, joinAccountType] : [tenantId, walletId],
  )
  return result.rows
}

async function accountPostings(tenantId: string, code: string) {
  const result = await pool.query<{ entry_type: string; amount: string }>(
    `SELECT lp.entry_type, lp.amount
       FROM ledger_postings lp JOIN ledger_accounts la ON la.id = lp.account_id
      WHERE lp.tenant_id=$1 AND la.code=$2`,
    [tenantId, code],
  )
  return result.rows
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeAll(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await pool.query(
    `TRUNCATE reconciliation_cases, usage_records, usage_events, outbox_events,
              ledger_postings, ledger_transactions, ledger_accounts,
              attempts, request_records, wallet_ledger_entries, wallet_accounts,
              sale_price_snapshots, sale_price_rules, provider_price_versions, exchange_rate_snapshots,
              audit_events, audit_logs, organizations, providers CASCADE`,
  )
  await seedTenants()
})

// ── 1. Duplicate event → single debit ──────────────────────────────────

describe('duplicate outbox event', () => {
  it('debits exactly once and replays the second delivery', async () => {
    const requestId = await createRequest({ tenantId: TENANT_A, orgId: orgA, reservationAmount: HOLD })
    await postHold(TENANT_A, walletA, requestId, HOLD)
    const attemptId = await createAttempt({ requestId, tenantId: TENANT_A, number: 1, status: 'completed' })

    // Two outbox rows carrying the SAME event_id (at-least-once redelivery).
    const event = makeEvent({ tenantId: TENANT_A, requestId, attemptId, status: 'completed' })
    await enqueue(event, { idempotencyKey: `delivery-a:${randomUUID()}` })
    await enqueue(event, { idempotencyKey: `delivery-b:${randomUUID()}` })

    const summary = await runPoll()
    expect(summary.published).toBe(2)
    expect(summary.outcomes.replayed).toBe(1)

    expect(await txCount(TENANT_A, usageKey(requestId))).toBe(1)
    expect(await getPostedDebitTotal(pool, TENANT_A, usageKey(requestId))).toBe(SALE_CHARGE)
    expect(await usageRecordCount(requestId)).toBe(1)
    expect(await getWalletBalance(TENANT_A, walletA)).toBe(FUNDING - SALE_CHARGE)
    // The hold was released exactly once.
    expect(await txCount(TENANT_A, reservationReleaseKey(requestId))).toBe(1)
  })
})

// ── 2. Out-of-order / stale attempts ───────────────────────────────────

describe('out-of-order events', () => {
  it('lets the final attempt own the charge and ignores a stale earlier attempt', async () => {
    const requestId = await createRequest({ tenantId: TENANT_A, orgId: orgA, reservationAmount: HOLD })
    await postHold(TENANT_A, walletA, requestId, HOLD)
    const failedAttempt = await createAttempt({ requestId, tenantId: TENANT_A, number: 1, status: 'failed' })
    const completedAttempt = await createAttempt({ requestId, tenantId: TENANT_A, number: 2, status: 'completed' })

    // Deliver the successful attempt FIRST, then the superseded failure.
    await enqueue(makeEvent({ tenantId: TENANT_A, requestId, attemptId: completedAttempt, status: 'completed' }), {
      createdAt: new Date(Date.now() - 10_000),
    })
    await enqueue(makeEvent({ tenantId: TENANT_A, requestId, attemptId: failedAttempt, status: 'failed' }), {
      createdAt: new Date(),
    })

    const summary = await runPoll()
    expect(summary.outcomes.settled).toBe(1)
    expect(summary.outcomes.superseded).toBe(1)

    expect(await txCount(TENANT_A, usageKey(requestId))).toBe(1)
    expect(await txCount(TENANT_A, reservationReleaseKey(requestId))).toBe(1)
    expect(await getWalletBalance(TENANT_A, walletA)).toBe(FUNDING - SALE_CHARGE)
    expect((await caseRows(requestId)).map((c) => c.reason)).toContain('superseded_attempt')
  })

  it('never releases the hold for a contradictory late failure on a charged request', async () => {
    const requestId = await createRequest({ tenantId: TENANT_A, orgId: orgA, reservationAmount: HOLD })
    await postHold(TENANT_A, walletA, requestId, HOLD)
    const attemptId = await createAttempt({ requestId, tenantId: TENANT_A, number: 1, status: 'completed' })

    await enqueue(makeEvent({ tenantId: TENANT_A, requestId, attemptId, status: 'completed' }))
    await runPoll()
    expect(await txCount(TENANT_A, reservationReleaseKey(requestId))).toBe(1)

    // A late `failed` event for the same (already charged) request.
    await enqueue(makeEvent({ tenantId: TENANT_A, requestId, attemptId, status: 'failed' }))
    const second = await runPoll()
    expect(second.deadLettered).toBe(1)
    expect(await usageRecordCount(requestId)).toBe(1)

    expect(await txCount(TENANT_A, usageKey(requestId))).toBe(1)
    expect(await txCount(TENANT_A, reservationReleaseKey(requestId))).toBe(1)
    expect(await getWalletBalance(TENANT_A, walletA)).toBe(FUNDING - SALE_CHARGE)
  })
})

// ── 3. Worker crash recovery ───────────────────────────────────────────

describe('worker crash recovery', () => {
  it('leaves no partial effect when the batch transaction rolls back, then bills once', async () => {
    const requestId = await createRequest({ tenantId: TENANT_A, orgId: orgA, reservationAmount: HOLD })
    await postHold(TENANT_A, walletA, requestId, HOLD)
    const attemptId = await createAttempt({ requestId, tenantId: TENANT_A, number: 1, status: 'completed' })
    await enqueue(makeEvent({ tenantId: TENANT_A, requestId, attemptId, status: 'completed' }))

    // Simulate a crash: claim + process, then never commit.
    const crashed = await pool.connect()
    try {
      await crashed.query('BEGIN')
      const summary = await pollOutboxOnce(crashed, config)
      expect(summary.published).toBe(1)
      await crashed.query('ROLLBACK')
    } finally {
      crashed.release()
    }

    // Nothing survived: the event is claimable again and no money moved.
    const outbox = await pool.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM outbox_events WHERE aggregate_id=$1`,
      [requestId],
    )
    expect(outbox.rows[0]).toEqual({ status: 'pending', attempts: 0 })
    expect(await txCount(TENANT_A, usageKey(requestId))).toBe(0)
    expect(await count(`SELECT count(*) AS n FROM usage_events WHERE request_id=$1`, [requestId])).toBe(0)
    expect(await getWalletBalance(TENANT_A, walletA)).toBe(FUNDING - HOLD)

    // Recovery: the same event now commits exactly once.
    const summary = await runPoll()
    expect(summary.published).toBe(1)
    expect(await txCount(TENANT_A, usageKey(requestId))).toBe(1)
    expect(await getWalletBalance(TENANT_A, walletA)).toBe(FUNDING - SALE_CHARGE)
  })
})

// ── 4. Unknown terminal state → reconciliation, never auto-retry ────────

describe('unknown terminal state', () => {
  it('opens a case, keeps the hold, never retries or charges, and closes by hand', async () => {
    const requestId = await createRequest({
      tenantId: TENANT_A,
      orgId: orgA,
      status: 'unknown',
      inputTokens: 10,
      outputTokens: 5,
      reservationAmount: HOLD,
    })
    await postHold(TENANT_A, walletA, requestId, HOLD)
    const attemptId = await createAttempt({ requestId, tenantId: TENANT_A, number: 1, status: 'completed' })
    await enqueue(
      makeEvent({ tenantId: TENANT_A, requestId, attemptId, status: 'unknown', inputTokens: 10, outputTokens: 5 }),
    )

    const summary = await runPoll()
    expect(summary.outcomes.reconciled).toBe(1)

    expect(await txCount(TENANT_A, usageKey(requestId))).toBe(0)
    expect(await txCount(TENANT_A, reservationReleaseKey(requestId))).toBe(0)
    expect(await getWalletBalance(TENANT_A, walletA)).toBe(FUNDING - HOLD)

    const cases = await caseRows(requestId)
    expect(cases).toHaveLength(1)
    expect(cases[0].reason).toBe('unknown_completion')
    expect(cases[0].status).toBe('open')

    // Re-running the consumer and the reconciliation job does not charge, does
    // not retry onto another channel, and does not duplicate the case.
    const second = await runPoll()
    expect(second.claimed).toBe(0)
    const recon = await inTx((client) => runReconciliation(client))
    expect(recon.unknownFlagged).toBe(0)
    expect((await caseRows(requestId)).length).toBe(1)
    expect(await txCount(TENANT_A, usageKey(requestId))).toBe(0)

    // Manual closure is the only path that moves the money.
    const caseId = cases[0].id
    const resolved = await inTx((client) =>
      resolveReconciliationCase(client, {
        tenantId: TENANT_A,
        caseId,
        status: 'resolved',
        resolution: 'operator confirmed upstream failure; release the hold',
        resolvedBy: 'admin@example.test',
        releaseHold: true,
      }),
    )
    expect(resolved.reservationReleased).toBe(true)
    expect(await txCount(TENANT_A, reservationReleaseKey(requestId))).toBe(1)
    expect(await getWalletBalance(TENANT_A, walletA)).toBe(FUNDING)
    const after = await pool.query<{ status: string }>(`SELECT status FROM reconciliation_cases WHERE id=$1`, [caseId])
    expect(after.rows[0].status).toBe('resolved')
  })
})

// ── 5. BYOK vs managed account separation ──────────────────────────────

describe('BYOK vs managed settlement', () => {
  it('debits the managed wallet and revenue, but only books BYOK cost to memo accounts', async () => {
    const managedRequest = await createRequest({ tenantId: TENANT_A, orgId: orgA, reservationAmount: HOLD })
    await postHold(TENANT_A, walletA, managedRequest, HOLD)
    const managedAttempt = await createAttempt({
      requestId: managedRequest,
      tenantId: TENANT_A,
      number: 1,
      status: 'completed',
    })
    await enqueue(
      makeEvent({ tenantId: TENANT_A, requestId: managedRequest, attemptId: managedAttempt, status: 'completed' }),
    )

    const byokRequest = await createRequest({ tenantId: TENANT_B, orgId: orgB, channelKind: 'byok' })
    const byokAttempt = await createAttempt({
      requestId: byokRequest,
      tenantId: TENANT_B,
      number: 1,
      status: 'completed',
    })
    await enqueue(
      makeEvent({ tenantId: TENANT_B, requestId: byokRequest, attemptId: byokAttempt, status: 'completed' }),
    )

    const summary = await runPoll()
    expect(summary.outcomes.settled).toBe(2)

    // Managed: real wallet debit + revenue credit.
    const managedWallet = await walletPostings(TENANT_A, walletA)
    expect(managedWallet.filter((p) => p.type === 'revenue')).toHaveLength(0)
    expect(await getPostedDebitTotal(pool, TENANT_A, usageKey(managedRequest))).toBe(SALE_CHARGE)
    expect(await getWalletBalance(TENANT_A, walletA)).toBe(FUNDING - SALE_CHARGE)

    // BYOK: provider cost on memo accounts; no wallet, no revenue.
    const byokEstimate = await accountPostings(TENANT_B, 'byok_cost_estimate:USD')
    const byokClearing = await accountPostings(TENANT_B, 'byok_cost_clearing:USD')
    expect(byokEstimate).toEqual([{ entry_type: 'debit', amount: `-${UPSTREAM_COST}` }])
    expect(byokClearing).toEqual([{ entry_type: 'credit', amount: `${UPSTREAM_COST}` }])
    expect(
      await count(`SELECT count(*) AS n FROM ledger_accounts WHERE tenant_id=$1 AND type='wallet'`, [TENANT_B]),
    ).toBe(0)
    expect(
      await count(`SELECT count(*) AS n FROM ledger_accounts WHERE tenant_id=$1 AND type='revenue'`, [TENANT_B]),
    ).toBe(0)

    const byokRecord = await pool.query<{
      charge_amount: string
      upstream_cost_amount: string
      estimated_amount: boolean
    }>(`SELECT charge_amount, upstream_cost_amount, estimated_amount FROM usage_records WHERE request_id=$1`, [
      byokRequest,
    ])
    expect(BigInt(byokRecord.rows[0].charge_amount)).toBe(0n)
    expect(BigInt(byokRecord.rows[0].upstream_cost_amount)).toBe(UPSTREAM_COST)

    const managedRecord = await pool.query<{ charge_amount: string; upstream_cost_amount: string }>(
      `SELECT charge_amount, upstream_cost_amount FROM usage_records WHERE request_id=$1`,
      [managedRequest],
    )
    expect(BigInt(managedRecord.rows[0].charge_amount)).toBe(SALE_CHARGE)
    expect(BigInt(managedRecord.rows[0].upstream_cost_amount)).toBe(UPSTREAM_COST)
  })
})

// ── 6. Historical recompute ────────────────────────────────────────────

describe('historical recompute', () => {
  it('re-derives the charge from pinned versions, even after the catalog moves', async () => {
    const requestId = await createRequest({ tenantId: TENANT_A, orgId: orgA, reservationAmount: HOLD })
    await postHold(TENANT_A, walletA, requestId, HOLD)
    const attemptId = await createAttempt({ requestId, tenantId: TENANT_A, number: 1, status: 'completed' })
    await enqueue(makeEvent({ tenantId: TENANT_A, requestId, attemptId, status: 'completed' }))
    await runPoll()

    const before = await auditRequestCharge(requestId, TENANT_A, pool)
    expect(before?.computable).toBe(true)
    expect(before?.matchesStored).toBe(true)
    expect(before?.matchesLedger).toBe(true)
    expect(before?.recomputedChargeAmount).toBe(SALE_CHARGE)
    expect(before?.storedChargeAmount).toBe(SALE_CHARGE)

    // The catalog moves on: the pinned version is superseded and a new active
    // price is published.
    await pool.query(`UPDATE provider_price_versions SET status='superseded' WHERE id=$1`, [priceVersionId])
    await pool.query(
      `INSERT INTO provider_price_versions
         (id, provider_id, upstream_model_id, currency, unit, input_price, cached_input_price,
          output_price, reasoning_price, request_price, image_price, audio_price, status, source_type)
       VALUES (gen_random_uuid(), $1, $2, 'USD', 'per_million_tokens', '99.00', '0', '99.00', '0', '0', '0', '0', 'active', 'manual')`,
      [providerId, MODEL],
    )

    await pool.query(`UPDATE sale_price_rules SET markup_rate='9' WHERE provider_id=$1`, [providerId])
    const after = await auditRequestCharge(requestId, TENANT_A, pool)
    expect(after?.recomputedChargeAmount).toBe(SALE_CHARGE)
    expect(after?.matchesStored).toBe(true)
  })

  it('opens an amount_mismatch case when the stored projection drifts', async () => {
    const requestId = await createRequest({ tenantId: TENANT_A, orgId: orgA, reservationAmount: HOLD })
    await postHold(TENANT_A, walletA, requestId, HOLD)
    const attemptId = await createAttempt({ requestId, tenantId: TENANT_A, number: 1, status: 'completed' })
    await enqueue(makeEvent({ tenantId: TENANT_A, requestId, attemptId, status: 'completed' }))
    await runPoll()

    const tampered = 9_999_999n
    await pool.query(`UPDATE request_records SET charge_amount=$2 WHERE id=$1`, [requestId, tampered.toString()])

    const audit = await recomputeRequestCharge(
      pool,
      TENANT_A,
      (await pool.query(`SELECT * FROM request_records WHERE id=$1`, [requestId])).rows[0],
    )
    expect(audit.matchesStored).toBe(false)
    expect(audit.recomputedChargeAmount).toBe(SALE_CHARGE)

    const mismatches = await inTx((client) => auditSettledCharges(client, 10))
    expect(mismatches).toBe(1)
    const cases = await caseRows(requestId)
    expect(cases.map((c) => c.reason)).toContain('amount_mismatch')
    const mismatch = cases.find((c) => c.reason === 'amount_mismatch')!
    expect(BigInt(mismatch.expected_amount!)).toBe(SALE_CHARGE)
    expect(BigInt(mismatch.actual_amount!)).toBe(tampered)

    // Repeated runs do not multiply the case.
    await inTx((client) => auditSettledCharges(client, 10))
    expect((await caseRows(requestId)).filter((c) => c.reason === 'amount_mismatch')).toHaveLength(1)
  })
})

// ── 7. Reservation timeout release ─────────────────────────────────────

describe('reservation timeout', () => {
  it('releases a stranded hold once and flags the request', async () => {
    const requestId = await createRequest({
      tenantId: TENANT_A,
      orgId: orgA,
      status: 'sent',
      reservationAmount: HOLD,
      reservationExpiresAt: new Date(Date.now() - 5 * 60_000),
    })
    await postHold(TENANT_A, walletA, requestId, HOLD)

    const first = await inTx((client) => runReconciliation(client))
    expect(first.reservationsReleased).toBe(1)
    expect(await txCount(TENANT_A, reservationReleaseKey(requestId))).toBe(1)
    expect(await getWalletBalance(TENANT_A, walletA)).toBe(FUNDING)

    const request = await pool.query<{ reservation_released: boolean }>(
      `SELECT reservation_released FROM request_records WHERE id=$1`,
      [requestId],
    )
    expect(request.rows[0].reservation_released).toBe(true)
    expect((await caseRows(requestId)).map((c) => c.reason)).toContain('reservation_timeout')
    // No usage charge was invented for an unresolved request.
    expect(await txCount(TENANT_A, usageKey(requestId))).toBe(0)

    // Idempotent: nothing to release on the next pass.
    const second = await inTx((client) => runReconciliation(client))
    expect(second.reservationsReleased).toBe(0)
    expect(await txCount(TENANT_A, reservationReleaseKey(requestId))).toBe(1)
  })
})

// ── 8. E2 alignment: the settle route already moved the money ───────────

describe('settle-route alignment', () => {
  it('replays the existing ledger entry instead of double-posting', async () => {
    const requestId = await createRequest({ tenantId: TENANT_A, orgId: orgA, reservationAmount: HOLD })
    await postHold(TENANT_A, walletA, requestId, HOLD)
    const attemptId = await createAttempt({ requestId, tenantId: TENANT_A, number: 1, status: 'completed' })
    await enqueue(makeEvent({ tenantId: TENANT_A, requestId, attemptId, status: 'completed' }))

    // Mimic the control-plane settle route: same idempotency keys it uses.
    await inTx(async (client) => {
      await releaseReservation(client, { tenantId: TENANT_A, requestId, currency: 'USD', amount: HOLD })
      const walletAccountId = await ensureWalletLedgerAccount(TENANT_A, walletA, 'USD', client)
      const revenueAccountId = await ensureSystemLedgerAccount(TENANT_A, 'revenue', 'USD', client)
      await postTransaction(
        {
          tenantId: TENANT_A,
          type: 'usage',
          currency: 'USD',
          idempotencyKey: usageKey(requestId),
          postings: [
            { accountId: walletAccountId, amount: SALE_CHARGE, entryType: 'debit' },
            { accountId: revenueAccountId, amount: SALE_CHARGE, entryType: 'credit' },
          ],
          referenceType: 'request',
          referenceId: requestId,
        },
        client,
      )
    })

    const summary = await runPoll()
    expect(summary.outcomes.replayed).toBe(1)
    expect(await txCount(TENANT_A, usageKey(requestId))).toBe(1)
    expect(await txCount(TENANT_A, reservationReleaseKey(requestId))).toBe(1)
    expect(await getWalletBalance(TENANT_A, walletA)).toBe(FUNDING - SALE_CHARGE)
    expect(await usageRecordCount(requestId)).toBe(1)
    expect(await caseRows(requestId)).toHaveLength(0)

    const request = await pool.query<{ charge_amount: string }>(
      `SELECT charge_amount FROM request_records WHERE id=$1`,
      [requestId],
    )
    expect(BigInt(request.rows[0].charge_amount)).toBe(SALE_CHARGE)
  })
})

// ── 9. Completed with no usage ─────────────────────────────────────────

describe('completed without usage', () => {
  it('refuses to write the request off as zero cost', async () => {
    const requestId = await createRequest({
      tenantId: TENANT_A,
      orgId: orgA,
      reservationAmount: HOLD,
      inputTokens: 0,
      outputTokens: 0,
    })
    await postHold(TENANT_A, walletA, requestId, HOLD)
    const attemptId = await createAttempt({ requestId, tenantId: TENANT_A, number: 1, status: 'completed' })
    await enqueue(
      makeEvent({ tenantId: TENANT_A, requestId, attemptId, status: 'completed', inputTokens: 0, outputTokens: 0 }),
    )

    const summary = await runPoll()
    expect(summary.outcomes.reconciled).toBe(1)
    expect(await txCount(TENANT_A, usageKey(requestId))).toBe(0)
    expect(await txCount(TENANT_A, reservationReleaseKey(requestId))).toBe(0)
    expect(await getWalletBalance(TENANT_A, walletA)).toBe(FUNDING - HOLD)
    expect((await caseRows(requestId)).map((c) => c.reason)).toContain('missing_usage')
  })
})

// ── 10. Retry backoff and dead-letter ──────────────────────────────────

describe('retry and dead-letter', () => {
  it('defers a transient failure, then succeeds on retry', async () => {
    // Tenant C has no wallet, so managed settlement fails transiently.
    const requestId = await createRequest({ tenantId: TENANT_C, orgId: orgC })
    const attemptId = await createAttempt({ requestId, tenantId: TENANT_C, number: 1, status: 'completed' })
    await enqueue(makeEvent({ tenantId: TENANT_C, requestId, attemptId, status: 'completed' }))

    // The retry delay is computed with the database clock (`now() + backoff`),
    // so the baseline must come from the same clock: comparing it against the
    // host process `Date.now()` fails on ordinary host/container clock skew.
    const clock = await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    const beforePoll = clock.rows[0].now.getTime()
    const first = await runPoll()
    expect(first.retried).toBe(1)
    expect(first.deadLettered).toBe(0)
    const deferred = await pool.query<{ status: string; attempts: number; next_attempt_at: Date }>(
      `SELECT status, attempts, next_attempt_at FROM outbox_events WHERE aggregate_id=$1`,
      [requestId],
    )
    expect(deferred.rows[0].status).toBe('pending')
    expect(deferred.rows[0].attempts).toBe(1)
    // Verify the scheduled delay from the attempt, not from a later query whose
    // scheduling can itself exceed the 100ms test backoff on a loaded CI runner.
    expect(deferred.rows[0].next_attempt_at.getTime()).toBeGreaterThanOrEqual(beforePoll + config.backoffBaseMs)

    // The operator provisions the wallet; the deferred event then settles.
    const wallet = await pool.query<{ id: string }>(
      `INSERT INTO wallet_accounts (id, organization_id, tenant_id, currency, status)
       VALUES (gen_random_uuid(), $1, $2, 'USD', 'active') RETURNING id`,
      [orgC, TENANT_C],
    )
    await sleep(150)
    const second = await runPoll()
    expect(second.published).toBe(1)
    expect(await txCount(TENANT_C, usageKey(requestId))).toBe(1)
    // No hold existed, so the charge simply debits the freshly provisioned wallet.
    expect(await getWalletBalance(TENANT_C, wallet.rows[0].id)).toBe(-SALE_CHARGE)
  })

  it('dead-letters a permanently invalid event on the first attempt', async () => {
    const requestId = `req_${randomUUID()}`
    const malformed = { schema_version: 1, event_id: `evt_${randomBytes(16).toString('hex')}` }
    await pool.query(
      `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, status)
       VALUES ($1,'usage',$2,'usage.completed',$3::jsonb,$4,'pending')`,
      [TENANT_A, requestId, JSON.stringify(malformed), `bad:${randomUUID()}`],
    )

    const summary = await runPoll()
    expect(summary.deadLettered).toBe(1)
    const row = await pool.query<{ status: string; attempts: number; last_error: string }>(
      `SELECT status, attempts, last_error FROM outbox_events WHERE aggregate_id=$1`,
      [requestId],
    )
    expect(row.rows[0].status).toBe('failed')
    expect(row.rows[0].attempts).toBe(1)
    expect(row.rows[0].last_error).toContain('tenant_id is required')

    // Dead-lettered events are not re-claimed.
    const again = await runPoll()
    expect(again.claimed).toBe(0)
  })
})
