// Wallet ledger. Append-only, transactional, with a balance invariant.
//
// Invariant: for every wallet, the sum of all entry amounts equals the latest
// balanceAfter. We enforce this by computing each new balanceAfter inside the
// same transaction that inserts the entry, using the previous balanceAfter as
// the base, under a per-wallet advisory lock so concurrent posts serialize.
//
// Idempotency: (wallet_id, idempotency_key) is unique. Replaying the same key
// is a no-op that returns the original entry, so duplicate payment callbacks
// or retried settlement never double-debit or double-credit.

import { db, pool } from '@/db'
import { walletAccounts, walletLedgerEntries } from '@/db/schema'
import { eq, desc, and } from 'drizzle-orm'
import type { Micros } from '@/lib/money'
import type { PoolClient, QueryResult, QueryResultRow } from 'pg'

export type LedgerEntryType = (typeof walletLedgerEntries.type.enumValues)[number]

export interface PostEntryInput {
  walletId: string
  type: LedgerEntryType
  amount: Micros // signed: +credit, -debit
  referenceType?: string
  referenceId?: string
  idempotencyKey?: string
  createdBy?: string
}

export interface PostedEntry {
  id: string
  walletId: string
  type: LedgerEntryType
  amount: Micros
  balanceAfter: Micros
  idempotencyKey: string | null
  createdAt: Date
  replayed: boolean // true if an existing entry with this idempotency key was returned
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

async function postOnClient(client: PoolClient, input: PostEntryInput): Promise<PostedEntry> {
  // Serialize concurrent posts to the same wallet.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.walletId])

  // Idempotency replay — do not re-apply.
  if (input.idempotencyKey) {
    const existing: QueryResult<Row> = await client.query(
      'SELECT id, type, amount, balance_after, idempotency_key, created_at FROM wallet_ledger_entries WHERE wallet_id=$1 AND idempotency_key=$2 LIMIT 1',
      [input.walletId, input.idempotencyKey],
    )
    if (existing.rows.length) {
      const r = existing.rows[0]
      return {
        id: r.id as string,
        walletId: input.walletId,
        type: r.type as LedgerEntryType,
        amount: BigInt(r.amount as string),
        balanceAfter: BigInt(r.balance_after as string),
        idempotencyKey: r.idempotency_key as string,
        createdAt: r.created_at as Date,
        replayed: true,
      }
    }
  }

  const last: QueryResult<Row> = await client.query(
    `SELECT balance_after FROM wallet_ledger_entries WHERE wallet_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [input.walletId],
  )
  const currentBalance: Micros = last.rows.length ? BigInt(last.rows[0].balance_after as string) : 0n
  const newBalance: Micros = currentBalance + input.amount

  // Debits must not push the wallet negative.
  if (input.amount < 0n && newBalance < 0n) {
    throw new LedgerError('insufficient_balance', `wallet ${input.walletId} would go negative (${newBalance})`)
  }

  const inserted: QueryResult<Row> = await client.query(
    `INSERT INTO wallet_ledger_entries (id, wallet_id, type, amount, balance_after, reference_type, reference_id, idempotency_key, created_by)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, type, amount, balance_after, idempotency_key, created_at`,
    [
      input.walletId,
      input.type,
      input.amount.toString(),
      newBalance.toString(),
      input.referenceType ?? null,
      input.referenceId ?? null,
      input.idempotencyKey ?? null,
      input.createdBy ?? null,
    ],
  )
  const r = inserted.rows[0]
  return {
    id: r.id as string,
    walletId: input.walletId,
    type: r.type as LedgerEntryType,
    amount: BigInt(r.amount as string),
    balanceAfter: BigInt(r.balance_after as string),
    idempotencyKey: r.idempotency_key as string | null,
    createdAt: r.created_at as Date,
    replayed: false,
  }
}

/**
 * Post a ledger entry. If `client` is provided, the caller owns the
 * surrounding transaction (BEGIN/COMMIT). Otherwise a fresh transaction is
 * opened here.
 */
export async function postEntry(input: PostEntryInput, client?: PoolClient): Promise<PostedEntry> {
  if (client) return postOnClient(client, input)
  const conn = await pool.connect() // raw pg client from the pool
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

/** Current balance = latest balanceAfter (or 0). Read-only. */
export async function getBalance(walletId: string): Promise<Micros> {
  const rows = await db
    .select({ balanceAfter: walletLedgerEntries.balanceAfter })
    .from(walletLedgerEntries)
    .where(eq(walletLedgerEntries.walletId, walletId))
    .orderBy(desc(walletLedgerEntries.createdAt), desc(walletLedgerEntries.id))
    .limit(1)
  return rows.length ? rows[0].balanceAfter : 0n
}

export async function getWalletForOrg(
  organizationId: string,
  currency = 'USD',
): Promise<{ id: string; status: string } | null> {
  const rows = await db
    .select({ id: walletAccounts.id, status: walletAccounts.status })
    .from(walletAccounts)
    .where(and(eq(walletAccounts.organizationId, organizationId), eq(walletAccounts.currency, currency)))
    .limit(1)
  return rows[0] ?? null
}
