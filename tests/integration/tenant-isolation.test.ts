// Integration tests for Work Item B — tenant isolation and ledger invariants.
//
// These tests connect to a real Postgres (docker compose up -d postgres;
// DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db).
// They prove the 5 required scenarios from the brief:
//
// 1. Two tenants with the same resource ID don't cross-leak.
// 2. An ordinary (tenant-scoped) repository can't cross-tenant.
// 3. A duplicate usage event posts once (idempotency).
// 4. An unbalanced ledger commit fails (balance invariant at DB level).
// 5. Ledger postings are immutable (UPDATE/DELETE rejected by trigger).
//
// The test suite resets the public schema at the start to ensure a clean
// state, applies both migrations (0000 + 0001), then runs the scenarios.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createApiKey,
  findApiKeyByHash,
  listApiKeys,
  revokeApiKey,
  insertUsageEvent,
  findUsageEventByEventId,
  insertUsageRecord,
  insertAuditEvent,
  insertOutboxEvent,
  findWalletByTenant,
} from '@/lib/db/repositories'
import {
  postWalletCredit,
  postWalletDebit,
  getWalletBalance,
  ensureWalletLedgerAccount,
  postTransaction,
} from '@/lib/db/ledger'
import { toMicros } from '@/lib/money'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/app_db'

const pool = new Pool({ connectionString: DATABASE_URL })

function readMigration(name: string): string {
  const path = join(process.cwd(), 'drizzle', name)
  return readFileSync(path, 'utf-8')
}

async function resetDatabase() {
  const client = await pool.connect()
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE')
    await client.query('CREATE SCHEMA public')
    await client.query('GRANT ALL ON SCHEMA public TO postgres')
    await client.query('GRANT ALL ON SCHEMA public TO public')
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    // Apply 0000 (base schema)
    await client.query(readMigration('0000_left_nekra.sql'))
    // Apply 0001 (new tables + tenant_id + ledger triggers)
    await client.query(readMigration('0001_greedy_shape.sql'))
  } finally {
    client.release()
  }
}

async function createTenant(slug: string): Promise<{ id: string; tenantId: string }> {
  const client = await pool.connect()
  try {
    const result = await client.query(
      `INSERT INTO organizations (id, name, slug, kind, base_currency, status)
       VALUES (gen_random_uuid(), $1, $2, 'customer', 'USD', 'active')
       RETURNING id, tenant_id`,
      [slug, slug],
    )
    return { id: result.rows[0].id, tenantId: result.rows[0].tenant_id }
  } finally {
    client.release()
  }
}

async function createWallet(orgId: string, tenantId: string): Promise<string> {
  const client = await pool.connect()
  try {
    const result = await client.query(
      `INSERT INTO wallet_accounts (organization_id, tenant_id, currency, status)
       VALUES ($1, $2, 'USD', 'active')
       RETURNING id`,
      [orgId, tenantId],
    )
    return result.rows[0].id
  } finally {
    client.release()
  }
}

beforeAll(async () => {
  await resetDatabase()
})

describe('tenant isolation', () => {
  let tenantA: { id: string; tenantId: string }
  let tenantB: { id: string; tenantId: string }

  beforeEach(async () => {
    // Clean business tables between tests. We must temporarily disable the
    // ledger_postings immutability triggers to allow test cleanup.
    const client = await pool.connect()
    try {
      await client.query('ALTER TABLE ledger_postings DISABLE TRIGGER ledger_posting_no_update')
      await client.query('ALTER TABLE ledger_postings DISABLE TRIGGER ledger_posting_no_delete')
      await client.query(
        'TRUNCATE outbox_events, audit_events, usage_records, usage_events, ledger_postings, ledger_transactions, ledger_accounts, downstream_api_keys, wallet_accounts, organizations CASCADE',
      )
      await client.query('ALTER TABLE ledger_postings ENABLE TRIGGER ledger_posting_no_update')
      await client.query('ALTER TABLE ledger_postings ENABLE TRIGGER ledger_posting_no_delete')
    } finally {
      client.release()
    }

    tenantA = await createTenant('tenant-a')
    tenantB = await createTenant('tenant-b')
  })

  // Scenario 1: Two tenants with same resource ID don't cross-leak
  it('two tenants with same-named API keys do not cross-leak', async () => {
    // Both tenants create a key with the same name but different hashes
    const keyA = await createApiKey(tenantA.tenantId, {
      name: 'shared-key-name',
      hash: 'hash-aaa-' + tenantA.tenantId,
      prefix: 'sk-nx-aaa',
      scopes: ['chat:write'],
    })
    const keyB = await createApiKey(tenantB.tenantId, {
      name: 'shared-key-name',
      hash: 'hash-bbb-' + tenantB.tenantId,
      prefix: 'sk-nx-bbb',
      scopes: ['chat:write'],
    })

    expect(keyA.tenantId).toBe(tenantA.tenantId)
    expect(keyB.tenantId).toBe(tenantB.tenantId)
    expect(keyA.id).not.toBe(keyB.id)

    // List keys for tenant A — should only see A's key
    const keysA = await listApiKeys(tenantA.tenantId)
    expect(keysA).toHaveLength(1)
    expect(keysA[0].name).toBe('shared-key-name')
    expect(keysA[0].hash).toBe('hash-aaa-' + tenantA.tenantId)

    // List keys for tenant B — should only see B's key
    const keysB = await listApiKeys(tenantB.tenantId)
    expect(keysB).toHaveLength(1)
    expect(keysB[0].hash).toBe('hash-bbb-' + tenantB.tenantId)
  })

  // Scenario 2: Ordinary repository can't cross-tenant
  it('tenant-scoped repository filters out cross-tenant access', async () => {
    const keyA = await createApiKey(tenantA.tenantId, {
      name: 'key-a',
      hash: 'hash-cross-a',
      prefix: 'sk-nx-a',
    })

    // Tenant B tries to revoke A's key — should return false (no row affected)
    const revoked = await revokeApiKey(tenantB.tenantId, keyA.id)
    expect(revoked).toBe(false)

    // Key A should still be enabled
    const keysA = await listApiKeys(tenantA.tenantId)
    expect(keysA[0].enabled).toBe(true)
    expect(keysA[0].revokedAt).toBeNull()

    // Tenant A can revoke its own key
    const revokedByA = await revokeApiKey(tenantA.tenantId, keyA.id)
    expect(revokedByA).toBe(true)
  })

  // Scenario 3: Duplicate event posts once (idempotency)
  it('duplicate usage event with same event_id posts once', async () => {
    const eventId = 'evt-' + Date.now()
    const eventInput = {
      eventId,
      eventType: 'request_completed',
      providerRequestId: 'upstream-req-123',
      payload: { tokens: 100 },
    }

    // First insert — should succeed
    const first = await insertUsageEvent(tenantA.tenantId, eventInput)
    expect(first).not.toBeNull()
    expect(first.event_id).toBe(eventId)

    // Second insert with same event_id — should be a no-op (ON CONFLICT DO NOTHING)
    const second = await insertUsageEvent(tenantA.tenantId, eventInput)
    expect(second).toBeNull()

    // Only one event exists
    const found = await findUsageEventByEventId(tenantA.tenantId, eventId)
    expect(found).not.toBeNull()
    expect(found.event_id).toBe(eventId)
  })

  // Scenario 4: Unbalanced ledger commit fails (DB-level balance invariant)
  it('unbalanced ledger transaction fails at DB level', async () => {
    const walletA = await createWallet(tenantA.id, tenantA.tenantId)
    const walletAccountId = await ensureWalletLedgerAccount(tenantA.tenantId, walletA, 'USD')

    // Create a clearing account for the counterparty
    const client = await pool.connect()
    let clearingAccountId: string
    try {
      const result = await client.query(
        `INSERT INTO ledger_accounts (id, tenant_id, type, currency, code)
         VALUES (gen_random_uuid(), $1, 'clearing', 'USD', 'clearing:USD')
         RETURNING id`,
        [tenantA.tenantId],
      )
      clearingAccountId = result.rows[0].id
    } finally {
      client.release()
    }

    // Try to post an unbalanced transaction: credit 100 to wallet, debit 50 to clearing
    // (debits != credits → constraint trigger should reject at COMMIT)
    const conn = await pool.connect()
    try {
      await conn.query('BEGIN')
      await conn.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tenantA.tenantId])

      const txResult = await conn.query(
        `INSERT INTO ledger_transactions (id, tenant_id, type, currency, idempotency_key)
         VALUES (gen_random_uuid(), $1, 'recharge', 'USD', $2)
         RETURNING id`,
        [tenantA.tenantId, 'unbalanced-test-' + Date.now()],
      )
      const txId = txResult.rows[0].id

      // Credit 100 micros to wallet
      await conn.query(
        `INSERT INTO ledger_postings (id, transaction_id, tenant_id, account_id, currency, amount, entry_type)
         VALUES (gen_random_uuid(), $1, $2, $3, 'USD', $4, 'credit')`,
        [txId, tenantA.tenantId, walletAccountId, '100'],
      )
      // Debit 50 to clearing (unbalanced!)
      await conn.query(
        `INSERT INTO ledger_postings (id, transaction_id, tenant_id, account_id, currency, amount, entry_type)
         VALUES (gen_random_uuid(), $1, $2, $3, 'USD', $4, 'debit')`,
        [txId, tenantA.tenantId, clearingAccountId, '50'],
      )

      // COMMIT should fail due to the constraint trigger
      await expect(conn.query('COMMIT')).rejects.toThrow()
    } catch (e) {
      // Expected — the COMMIT fails
    } finally {
      await conn.query('ROLLBACK').catch(() => {})
      conn.release()
    }

    // Verify no postings survived the rollback
    const balance = await getWalletBalance(tenantA.tenantId, walletA)
    expect(balance).toBe(0n)
  })

  // Scenario 5: Ledger postings are immutable (UPDATE/DELETE rejected)
  it('ledger postings reject UPDATE and DELETE', async () => {
    const walletA = await createWallet(tenantA.id, tenantA.tenantId)
    const idemKey = 'immute-test-' + Date.now()

    // Post a valid balanced transaction: credit 1000 micros to wallet
    await postWalletCredit(tenantA.tenantId, walletA, toMicros('1.0'), idemKey)

    // Verify balance is 1000000 micros (1.0 USD)
    const balance = await getWalletBalance(tenantA.tenantId, walletA)
    expect(balance).toBe(toMicros('1.0'))

    // Try to UPDATE a posting — should fail
    const client = await pool.connect()
    try {
      await expect(
        client.query(`UPDATE ledger_postings SET amount = 999999 WHERE tenant_id = $1`, [tenantA.tenantId]),
      ).rejects.toThrow(/ledger_posting_immutable/)

      // Try to DELETE a posting — should fail
      await expect(
        client.query(`DELETE FROM ledger_postings WHERE tenant_id = $1`, [tenantA.tenantId]),
      ).rejects.toThrow(/ledger_posting_immutable/)
    } finally {
      client.release()
    }

    // Balance should still be 1000000 micros (unchanged)
    const balanceAfter = await getWalletBalance(tenantA.tenantId, walletA)
    expect(balanceAfter).toBe(toMicros('1.0'))
  })

  // Bonus: verify wallet credit + debit works end-to-end
  it('wallet credit then debit produces correct balance', async () => {
    const walletA = await createWallet(tenantA.id, tenantA.tenantId)
    await postWalletCredit(tenantA.tenantId, walletA, toMicros('10.0'), 'credit-test-' + Date.now())
    expect(await getWalletBalance(tenantA.tenantId, walletA)).toBe(toMicros('10.0'))

    // Debit 3.50 USD (3500000 micros)
    await postWalletDebit(tenantA.tenantId, walletA, toMicros('3.5'), 'debit-test-' + Date.now())
    expect(await getWalletBalance(tenantA.tenantId, walletA)).toBe(toMicros('6.5'))
  })

  // Bonus: idempotent ledger transaction replay
  it('replaying same idempotency key returns original transaction', async () => {
    const walletA = await createWallet(tenantA.id, tenantA.tenantId)
    const idemKey = 'replay-test-' + Date.now()

    const first = await postWalletCredit(tenantA.tenantId, walletA, toMicros('5.0'), idemKey)
    expect(first.replayed).toBe(false)

    const second = await postWalletCredit(tenantA.tenantId, walletA, toMicros('5.0'), idemKey)
    expect(second.replayed).toBe(true)
    expect(second.id).toBe(first.id)

    // Balance should be 5.0, not 10.0
    expect(await getWalletBalance(tenantA.tenantId, walletA)).toBe(toMicros('5.0'))
  })

  // Bonus: audit events and outbox events are tenant-scoped
  it('audit and outbox events are tenant-scoped', async () => {
    const auditA = await insertAuditEvent(tenantA.tenantId, {
      action: 'key.create',
      targetType: 'api_key',
      targetId: 'key-1',
    })
    expect(auditA.tenant_id).toBe(tenantA.tenantId)

    const outboxA = await insertOutboxEvent(tenantA.tenantId, {
      aggregateType: 'request',
      aggregateId: 'req-1',
      eventType: 'request.completed',
      idempotencyKey: 'outbox-a-' + Date.now(),
    })
    expect(outboxA.tenant_id).toBe(tenantA.tenantId)

    // Tenant B's audit/outbox should not see A's events
    const client = await pool.connect()
    try {
      const auditB = await client.query(`SELECT count(*)::int AS cnt FROM audit_events WHERE tenant_id = $1`, [
        tenantB.tenantId,
      ])
      expect(auditB.rows[0].cnt).toBe(0)

      const outboxB = await client.query(`SELECT count(*)::int AS cnt FROM outbox_events WHERE tenant_id = $1`, [
        tenantB.tenantId,
      ])
      expect(outboxB.rows[0].cnt).toBe(0)
    } finally {
      client.release()
    }
  })
})
