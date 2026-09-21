// Double-entry ledger over ledger_accounts / ledger_transactions / ledger_postings.
//
// ADR-0002: PostgreSQL append-only ledger postings are the SOLE balance truth.
// INVARIANT #2: the ledger is the balance truth; wallet_account / cached
// balances are derived/rebuildable.
// INVARIANT #3: postings are immutable; corrections use compensating
// transactions, never edits. The DB enforces this via BEFORE UPDATE/DELETE
// triggers (see migration 0001).
//
// Balance invariant: for each (transaction_id, currency), sum(amount) = 0.
// The DB enforces this via a DEFERRABLE constraint trigger checked at COMMIT.
// This module posts balanced debit+credit pairs within a single transaction
// so the constraint passes.
//
// Idempotency: (tenant_id, idempotency_key) on ledger_transactions is unique.
// Replaying the same key is a no-op that returns the original transaction.
//
// The legacy src/lib/billing/ledger.ts (wallet_ledger_entries, single-entry)
// is kept for backward compatibility during the migration; new billing code
// uses this module.

import { pool } from '@/db'
import type { Micros } from '@/lib/money'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'

export type LedgerTransactionType =
  | 'recharge'
  | 'usage'
  | 'refund'
  | 'adjustment'
  | 'promotional_credit'
  | 'reservation'
  | 'reservation_release'
  | 'correction'

export type LedgerAccountType =
  'wallet' | 'revenue' | 'refund' | 'adjustment' | 'promotional' | 'reservation' | 'tax' | 'fee' | 'clearing'

export interface PostPosting {
  accountId: string
  amount: Micros // unsigned; sign determined by entryType
  entryType: 'debit' | 'credit'
}

export interface PostTransactionInput {
  tenantId: string
  type: LedgerTransactionType
  currency: string
  idempotencyKey: string
  postings: PostPosting[] // must balance: sum(debits) = sum(credits) per currency
  referenceType?: string
  referenceId?: string
  description?: string
  createdBy?: string
}

export interface PostedTransaction {
  id: string
  tenantId: string
  type: LedgerTransactionType
  currency: string
  idempotencyKey: string
  referenceType: string | null
  referenceId: string | null
  postedAt: Date
  replayed: boolean // true if an existing transaction with this idempotency key was returned
  postingIds: string[]
}

export class LedgerError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'LedgerError'
  }
}

type Row = Record<string, unknown>

/**
 * Post a balanced double-entry transaction. All postings must balance per
 * currency (sum of debits = sum of credits). The DB constraint trigger
 * enforces this at COMMIT time; we also pre-check here for a clearer error.
 *
 * If `client` is provided, the caller owns the surrounding transaction.
 * Otherwise a fresh transaction is opened here.
 */
export async function postTransaction(input: PostTransactionInput, client?: PoolClient): Promise<PostedTransaction> {
  if (client) return postOnClient(client, input)
  const conn = await pool.connect()
  try {
    await conn.query('BEGIN')
    const result = await postOnClient(conn, input)
    await conn.query('COMMIT')
    return result
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    conn.release()
  }
}

async function postOnClient(client: PoolClient | Pool, input: PostTransactionInput): Promise<PostedTransaction> {
  // Pre-check balance: for each currency, sum(debits) must equal sum(credits).
  // The DB constraint trigger is the authority, but this gives a clear error
  // before the round-trip.
  const debitTotal = input.postings.filter((p) => p.entryType === 'debit').reduce((sum, p) => sum + p.amount, 0n)
  const creditTotal = input.postings.filter((p) => p.entryType === 'credit').reduce((sum, p) => sum + p.amount, 0n)
  if (debitTotal !== creditTotal) {
    throw new LedgerError('unbalanced', `postings do not balance: debits=${debitTotal} credits=${creditTotal}`)
  }
  if (input.postings.length < 2) {
    throw new LedgerError('single_sided', 'a transaction must have at least 2 postings (debit + credit)')
  }

  // Serialize concurrent posts to the same tenant.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.tenantId])

  // Idempotency replay — do not re-apply.
  const existing: QueryResult<Row> = await client.query(
    `SELECT id, tenant_id, type, currency, idempotency_key, reference_type, reference_id, posted_at
     FROM ledger_transactions
     WHERE tenant_id = $1 AND idempotency_key = $2
     LIMIT 1`,
    [input.tenantId, input.idempotencyKey],
  )
  if (existing.rows.length) {
    const r = existing.rows[0]
    const postingIds: QueryResult<Row> = await client.query(
      `SELECT id FROM ledger_postings WHERE transaction_id = $1 ORDER BY created_at, id`,
      [r.id],
    )
    return {
      id: r.id as string,
      tenantId: r.tenant_id as string,
      type: r.type as LedgerTransactionType,
      currency: r.currency as string,
      idempotencyKey: r.idempotency_key as string,
      referenceType: (r.reference_type as string) ?? null,
      referenceId: (r.reference_id as string) ?? null,
      postedAt: r.posted_at as Date,
      replayed: true,
      postingIds: postingIds.rows.map((p) => p.id as string),
    }
  }

  // Insert the transaction header.
  const txResult: QueryResult<Row> = await client.query(
    `INSERT INTO ledger_transactions (id, tenant_id, type, currency, idempotency_key, reference_type, reference_id, description, created_by)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, tenant_id, type, currency, idempotency_key, reference_type, reference_id, posted_at`,
    [
      input.tenantId,
      input.type,
      input.currency,
      input.idempotencyKey,
      input.referenceType ?? null,
      input.referenceId ?? null,
      input.description ?? null,
      input.createdBy ?? null,
    ],
  )
  const txRow = txResult.rows[0]
  const transactionId = txRow.id as string

  // Insert postings. amount is signed: +credit / -debit (so sum = 0).
  const postingIds: string[] = []
  for (const p of input.postings) {
    const signedAmount = p.entryType === 'credit' ? p.amount : -p.amount
    const inserted: QueryResult<Row> = await client.query(
      `INSERT INTO ledger_postings (id, transaction_id, tenant_id, account_id, currency, amount, entry_type)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [transactionId, input.tenantId, p.accountId, input.currency, signedAmount.toString(), p.entryType],
    )
    postingIds.push(inserted.rows[0].id as string)
  }

  return {
    id: transactionId,
    tenantId: txRow.tenant_id as string,
    type: txRow.type as LedgerTransactionType,
    currency: txRow.currency as string,
    idempotencyKey: txRow.idempotency_key as string,
    referenceType: (txRow.reference_type as string) ?? null,
    referenceId: (txRow.reference_id as string) ?? null,
    postedAt: txRow.posted_at as Date,
    replayed: false,
    postingIds,
  }
}

/**
 * Compute the current balance of a ledger account from its postings.
 * This is the authoritative balance (sum of signed amounts).
 * balance = sum(credits) - sum(debits) = sum(amount) where amount is signed.
 */
export async function getAccountBalance(tenantId: string, accountId: string, client?: PoolClient): Promise<Micros> {
  const query = client ?? pool
  const result: QueryResult<Row> = await query.query(
    `SELECT COALESCE(sum(amount), 0) AS balance
     FROM ledger_postings
     WHERE tenant_id = $1 AND account_id = $2`,
    [tenantId, accountId],
  )
  return BigInt(result.rows[0].balance as string)
}

/**
 * Compute the wallet balance for a tenant from the ledger.
 * The wallet_account is linked to a ledger_account of type 'wallet'.
 * This is the rebuildable aggregate balance (INVARIANT #2).
 */
export async function getWalletBalance(tenantId: string, walletId: string, client?: PoolClient): Promise<Micros> {
  const query = client ?? pool
  const result: QueryResult<Row> = await query.query(
    `SELECT COALESCE(sum(lp.amount), 0) AS balance
     FROM ledger_postings lp
     JOIN ledger_accounts la ON lp.account_id = la.id
     WHERE lp.tenant_id = $1 AND la.wallet_id = $2`,
    [tenantId, walletId],
  )
  return BigInt(result.rows[0].balance as string)
}

/**
 * Find or create the wallet ledger account for a tenant's wallet.
 */
export async function ensureWalletLedgerAccount(
  tenantId: string,
  walletId: string,
  currency = 'USD',
  client?: PoolClient | Pool,
): Promise<string> {
  const query = client ?? pool
  const existing: QueryResult<Row> = await query.query(
    `SELECT id FROM ledger_accounts WHERE tenant_id = $1 AND wallet_id = $2 LIMIT 1`,
    [tenantId, walletId],
  )
  if (existing.rows.length) return existing.rows[0].id as string

  const code = `wallet:${walletId}`
  const result: QueryResult<Row> = await query.query(
    `INSERT INTO ledger_accounts (id, tenant_id, wallet_id, type, currency, code)
     VALUES (gen_random_uuid(), $1, $2, 'wallet', $3, $4)
     ON CONFLICT (tenant_id, code) DO UPDATE SET wallet_id = EXCLUDED.wallet_id
     RETURNING id`,
    [tenantId, walletId, currency, code],
  )
  return result.rows[0].id as string
}

/**
 * Find or create a system (non-wallet) ledger account for a tenant.
 * Used for revenue, clearing, tax, fee accounts.
 */
export async function ensureSystemLedgerAccount(
  tenantId: string,
  type: LedgerAccountType,
  currency = 'USD',
  client?: PoolClient | Pool,
): Promise<string> {
  const query = client ?? pool
  const code = `${type}:${currency}`
  const existing: QueryResult<Row> = await query.query(
    `SELECT id FROM ledger_accounts WHERE tenant_id = $1 AND code = $2 LIMIT 1`,
    [tenantId, code],
  )
  if (existing.rows.length) return existing.rows[0].id as string

  const result: QueryResult<Row> = await query.query(
    `INSERT INTO ledger_accounts (id, tenant_id, type, currency, code)
     VALUES (gen_random_uuid(), $1, $2, $3, $4)
     ON CONFLICT (tenant_id, code) DO NOTHING
     RETURNING id`,
    [tenantId, type, currency, code],
  )
  return result.rows[0].id as string
}

/**
 * Post a simple credit (recharge) to a wallet: credit wallet, debit clearing.
 * This is the canonical recharge pattern — the clearing account is the
 * counterparty for all wallet credits (funds enter the system from payments).
 */
export async function postWalletCredit(
  tenantId: string,
  walletId: string,
  amount: Micros,
  idempotencyKey: string,
  type: LedgerTransactionType = 'recharge',
  referenceType?: string,
  referenceId?: string,
  client?: PoolClient,
): Promise<PostedTransaction> {
  if (client) {
    const walletAccountId = await ensureWalletLedgerAccount(tenantId, walletId, 'USD', client)
    const clearingAccountId = await ensureSystemLedgerAccount(tenantId, 'clearing', 'USD', client)
    return postOnClient(client, {
      tenantId,
      type,
      currency: 'USD',
      idempotencyKey,
      postings: [
        { accountId: walletAccountId, amount, entryType: 'credit' },
        { accountId: clearingAccountId, amount, entryType: 'debit' },
      ],
      referenceType,
      referenceId,
    })
  }
  // No client provided — open our own transaction so all queries share one
  // connection (the balance constraint trigger is DEFERRABLE INITIALLY
  // DEFERRED, which only works within a single transaction).
  const conn = await pool.connect()
  try {
    await conn.query('BEGIN')
    const walletAccountId = await ensureWalletLedgerAccount(tenantId, walletId, 'USD', conn)
    const clearingAccountId = await ensureSystemLedgerAccount(tenantId, 'clearing', 'USD', conn)
    const result = await postOnClient(conn, {
      tenantId,
      type,
      currency: 'USD',
      idempotencyKey,
      postings: [
        { accountId: walletAccountId, amount, entryType: 'credit' },
        { accountId: clearingAccountId, amount, entryType: 'debit' },
      ],
      referenceType,
      referenceId,
    })
    await conn.query('COMMIT')
    return result
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    conn.release()
  }
}

/**
 * Post a simple debit (usage charge) to a wallet: debit wallet, credit revenue.
 * This is the canonical usage charge pattern.
 */
export async function postWalletDebit(
  tenantId: string,
  walletId: string,
  amount: Micros,
  idempotencyKey: string,
  type: LedgerTransactionType = 'usage',
  referenceType?: string,
  referenceId?: string,
  client?: PoolClient,
): Promise<PostedTransaction> {
  if (client) {
    const walletAccountId = await ensureWalletLedgerAccount(tenantId, walletId, 'USD', client)
    const revenueAccountId = await ensureSystemLedgerAccount(tenantId, 'revenue', 'USD', client)
    return postOnClient(client, {
      tenantId,
      type,
      currency: 'USD',
      idempotencyKey,
      postings: [
        { accountId: walletAccountId, amount, entryType: 'debit' },
        { accountId: revenueAccountId, amount, entryType: 'credit' },
      ],
      referenceType,
      referenceId,
    })
  }
  const conn = await pool.connect()
  try {
    await conn.query('BEGIN')
    const walletAccountId = await ensureWalletLedgerAccount(tenantId, walletId, 'USD', conn)
    const revenueAccountId = await ensureSystemLedgerAccount(tenantId, 'revenue', 'USD', conn)
    const result = await postOnClient(conn, {
      tenantId,
      type,
      currency: 'USD',
      idempotencyKey,
      postings: [
        { accountId: walletAccountId, amount, entryType: 'debit' },
        { accountId: revenueAccountId, amount, entryType: 'credit' },
      ],
      referenceType,
      referenceId,
    })
    await conn.query('COMMIT')
    return result
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    conn.release()
  }
}
