import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runWorkerTick } from '../../services/worker/tick'
import { loadWorkerConfig } from '../../services/worker/config'
import { authorizeBudget } from '../../services/budget/authorize'
import { postWalletCredit } from '@/lib/db/ledger'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const rolePool = (role: string) => new Pool({ connectionString: process.env.DATABASE_URL, options: `-c role=${role}` })
beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  for (const name of [
    '0000_left_nekra.sql',
    '0001_greedy_shape.sql',
    '0002_auth_secret_plane.sql',
    '0003_worker_outbox_retry.sql',
  ]) {
    await pool.query(readFileSync(`drizzle/${name}`, 'utf8'))
  }
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES('o','t','roles','roles');
    INSERT INTO downstream_api_keys(id,organization_id,tenant_id,name,hash,prefix) VALUES('k','o','t','roles','synthetic','test');
    INSERT INTO providers(id,code,name,official_base_url) VALUES('p','test','roles','http://fixture.invalid');
    INSERT INTO provider_price_versions(id,provider_id,upstream_model_id,input_price,output_price,source_type,status) VALUES('pp','p','m',1,1,'manual','active');
    INSERT INTO sale_price_rules(id,tenant_id,organization_id,provider_id,upstream_model_id,pricing_mode) VALUES('rule','t','o','p','m','markup');
    INSERT INTO sale_price_snapshots(id,rule_id,provider_price_version_id,pricing_mode,input_price,output_price) VALUES('sp','rule','pp','markup',1,1);
    INSERT INTO wallet_accounts(id,tenant_id,organization_id) VALUES('wallet','t','o');`)
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await postWalletCredit('t', 'wallet', 10_000_000n, 'fund-roles', 'recharge', undefined, undefined, c)
    await c.query('COMMIT')
  } finally {
    c.release()
  }
  await pool.query(`GRANT UPDATE ON provider_credentials TO PUBLIC;
    GRANT UPDATE(encrypted_secret) ON provider_credentials TO PUBLIC;
    CREATE FUNCTION public.workload_definer_probe() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'; GRANT EXECUTE ON FUNCTION public.workload_definer_probe() TO PUBLIC;`)
  const sql = readFileSync('infra/db-workload-roles.sql', 'utf8')
  // Applying twice is part of the operator rerun contract.
  await pool.query(sql)
  await pool.query('GRANT UPDATE(encrypted_secret) ON provider_credentials TO nexus_budget')
  await pool.query(sql)
})
afterAll(async () => {
  await pool.end()
})

describe('database workload boundaries', () => {
  it('refuses a workload identity that owns a table and could disable RLS', async () => {
    const c = await pool.connect()
    try {
      await c.query(
        'BEGIN; CREATE TABLE role_owned_probe(id integer); ALTER TABLE role_owned_probe OWNER TO nexus_budget',
      )
      await expect(c.query(readFileSync('infra/db-workload-roles.sql', 'utf8'))).rejects.toThrow(
        'unsafe existing workload role',
      )
    } finally {
      await c.query('ROLLBACK')
      c.release()
    }
  })

  for (const role of ['nexus_budget', 'nexus_control', 'nexus_gateway']) {
    it(`${role} cannot create final usage`, async () => {
      const p = rolePool(role)
      try {
        await expect(
          p.query(`INSERT INTO ledger_transactions(tenant_id,type,idempotency_key) VALUES('t','usage',$1)`, [role]),
        ).rejects.toMatchObject({ code: '42501' })
      } finally {
        await p.end()
      }
    })
  }
  it('Worker can create balanced usage; budget/control cannot attach postings to it', async () => {
    const worker = rolePool('nexus_worker')
    try {
      await worker.query(`BEGIN;
        INSERT INTO ledger_transactions(id,tenant_id,type,idempotency_key) VALUES('worker-usage','t','usage','worker-usage');
        INSERT INTO ledger_postings(transaction_id,tenant_id,account_id,amount,entry_type)
          SELECT 'worker-usage','t',id,0,'credit' FROM ledger_accounts WHERE tenant_id='t';
        COMMIT;`)
    } finally {
      await worker.end()
    }
    for (const role of ['nexus_budget', 'nexus_control', 'nexus_gateway']) {
      const p = rolePool(role)
      try {
        await expect(
          p.query(`INSERT INTO ledger_postings(transaction_id,tenant_id,account_id,amount,entry_type)
        SELECT 'worker-usage','t',id,0,'credit' FROM ledger_accounts WHERE tenant_id='t'`),
        ).rejects.toMatchObject({ code: '42501' })
      } finally {
        await p.end()
      }
    }
  })
  it('budget executes real authorization but cannot release or update ledger facts', async () => {
    const p = rolePool('nexus_budget')
    try {
      const grant = await authorizeBudget(p, {
        version: 1,
        tenant_id: 't',
        organization_id: 'o',
        key_id: 'k',
        request_id: 'reserved-role',
        model_id: 'm',
        provider: 'test',
        currency: 'USD',
        price_version_id: 'pp',
        sale_price_snapshot_id: 'sp',
        exchange_rate_snapshot_id: null,
        estimated_input_tokens: 1_000_000,
        estimated_output_tokens: 0,
        ttl_seconds: 900,
      })
      expect(grant.amount_micros).toBe('1000000')
      await expect(
        p.query(
          `INSERT INTO ledger_transactions(tenant_id,type,idempotency_key) VALUES('t','reservation_release','forbidden-release')`,
        ),
      ).rejects.toMatchObject({ code: '42501' })
      await expect(p.query(`UPDATE ledger_transactions SET description='tampered'`)).rejects.toMatchObject({
        code: '42501',
      })
      await expect(p.query(`UPDATE provider_credentials SET encrypted_secret='tampered'`)).rejects.toMatchObject({
        code: '42501',
      })
    } finally {
      await p.end()
    }
  })
  it('control retains legitimate funding, with immutable ledger history', async () => {
    const p = rolePool('nexus_control')
    const c = await p.connect()
    try {
      await c.query('BEGIN')
      await postWalletCredit('t', 'wallet', 1n, 'control-fund', 'recharge', undefined, undefined, c)
      await c.query('COMMIT')
      await expect(c.query('DELETE FROM ledger_transactions')).rejects.toMatchObject({ code: '42501' })
    } finally {
      c.release()
      await p.end()
    }
  })
  it('removes inherited PUBLIC table and function capabilities', async () => {
    const p = rolePool('nexus_budget')
    try {
      await expect(p.query("UPDATE provider_credentials SET name='forbidden'")).rejects.toMatchObject({ code: '42501' })
      await expect(p.query('SELECT public.workload_definer_probe()')).rejects.toMatchObject({ code: '42501' })
    } finally {
      await p.end()
    }
  })
  it('does not let Control rewrite final usage projections', async () => {
    const p = rolePool('nexus_control')
    try {
      for (const table of ['usage_records', 'usage_events']) {
        await expect(p.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: '42501' })
      }
    } finally {
      await p.end()
    }
  })
  it('preserves historical account identity and rejects wallet-linked reservation accounts', async () => {
    await pool.query(
      "INSERT INTO wallet_accounts(id,tenant_id,organization_id,currency) VALUES('wallet-two','t','o','EUR')",
    )
    const p = rolePool('nexus_budget')
    try {
      await expect(
        p.query("UPDATE ledger_accounts SET wallet_id='wallet-two' WHERE wallet_id='wallet'"),
      ).rejects.toThrow('ledger_account_identity_immutable')
      await expect(
        p.query(
          "INSERT INTO ledger_accounts(tenant_id,wallet_id,type,code) VALUES('t','wallet','reservation','fake-reservation')",
        ),
      ).rejects.toThrow('ledger_account_wallet_binding_invalid')
      await expect(
        p.query(`INSERT INTO ledger_postings(transaction_id,tenant_id,account_id,amount,entry_type)
        SELECT t.id,'t',a.id,1,'credit' FROM ledger_transactions t,ledger_accounts a
        WHERE t.idempotency_key='reservation:reserved-role' AND a.wallet_id='wallet'`),
      ).rejects.toMatchObject({ code: '42501' })
    } finally {
      await p.end()
    }
  })
  it('rejects a callable SECURITY DEFINER path in another schema', async () => {
    const c = await pool.connect()
    try {
      await c.query(`BEGIN; CREATE SCHEMA roles_review_probe; GRANT USAGE ON SCHEMA roles_review_probe TO PUBLIC;
        CREATE FUNCTION roles_review_probe.escape() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
        GRANT EXECUTE ON FUNCTION roles_review_probe.escape() TO PUBLIC;`)
      await expect(c.query(readFileSync('infra/db-workload-roles.sql', 'utf8'))).rejects.toThrow(
        'accessible SECURITY DEFINER function',
      )
    } finally {
      await c.query('ROLLBACK')
      c.release()
    }
  })
  it('runs a real Worker settlement, dead-letter audit, reconciliation and replay under its role', async () => {
    const event = {
      schema_version: 1,
      event_id: 'roles-settlement-event-0001',
      occurred_at: new Date().toISOString(),
      tenant_id: 't',
      request_id: 'reserved-role',
      attempt_id: 'roles-attempt',
      model_id: 'm',
      status: 'completed',
      price_version_id: 'pp',
      catalog_version_id: 'roles-catalog',
      usage: { input_tokens: 1_000_000, output_tokens: 0, estimated: false },
    }
    await pool.query(`UPDATE request_records SET status='completed',input_tokens=1000000,output_tokens=0 WHERE id='reserved-role';
      INSERT INTO attempts(id,request_id,tenant_id,provider_id,attempt_number,status) VALUES('roles-attempt','reserved-role','t','p',1,'completed');`)
    await pool.query(
      `INSERT INTO outbox_events(id,tenant_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
      VALUES('roles-valid','t','usage','reserved-role','usage.completed',$1,'roles-valid'),('roles-invalid','t','usage','bad-request','usage.completed','{}','roles-invalid')`,
      [JSON.stringify(event)],
    )
    const p = rolePool('nexus_worker')
    const c = await p.connect()
    const config = loadWorkerConfig({
      DATABASE_URL: process.env.DATABASE_URL,
      WORKER_ID: 'roles-worker',
      WORKER_MAX_ATTEMPTS: '1',
    })
    try {
      const result = await runWorkerTick(c, config, { reconcile: true })
      expect(result).toMatchObject({ published: 1, deadLettered: 1, retried: 0 })
      expect(
        (
          await c.query(
            "SELECT action FROM audit_events WHERE action IN ('billing.settled','billing.outbox_dead_letter') ORDER BY action",
          )
        ).rows.map((r) => r.action),
      ).toEqual(['billing.outbox_dead_letter', 'billing.settled'])
      expect(
        (
          await c.query(
            "SELECT count(*)::int AS count FROM ledger_transactions WHERE idempotency_key IN ('usage:reserved-role','reservation_release:reserved-role')",
          )
        ).rows[0].count,
      ).toBe(2)
      await c.query("UPDATE outbox_events SET status='pending',attempts=0 WHERE id='roles-valid'")
      expect((await runWorkerTick(c, config, { reconcile: true })).published).toBe(1)
      expect(
        (
          await c.query(
            "SELECT count(*)::int AS count FROM ledger_transactions WHERE idempotency_key IN ('usage:reserved-role','reservation_release:reserved-role')",
          )
        ).rows[0].count,
      ).toBe(2)
    } finally {
      c.release()
      await p.end()
    }
  })
})
