import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { Pool } from 'pg'

// Deliberately restricted to the disposable convergence fixture, never a production restore tool.
const source = new URL(process.env.MIGRATION_RECOVERY_DATABASE_URL || '')
assert.equal(source.hostname, '127.0.0.1')
assert.equal(source.port, '55439')
assert.equal(source.pathname, '/convergence_legacy16')
const container = 'nexus-convergence-audit-postgres'
const restoredDatabase = `convergence_restore16_${Date.now()}`
const sourcePool = new Pool({ connectionString: source.toString() })
const adminUrl = new URL(source)
adminUrl.pathname = '/postgres'
const admin = new Pool({ connectionString: adminUrl.toString() })
const restoredUrl = new URL(source)
restoredUrl.pathname = `/${restoredDatabase}`
const restored = new Pool({ connectionString: restoredUrl.toString() })
const quote = (name) => `"${name.replaceAll('"', '""')}"`

async function facts(pool) {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows
  assert.ok(tables.length > 0, 'Fixture has no tables')
  const result = []
  for (const { tablename } of tables) {
    const row = (
      await pool.query(`SELECT count(*)::text AS count,
      md5(coalesce(string_agg(md5(row_to_json(t)::text), '' ORDER BY row_to_json(t)::text),'')) AS digest
      FROM public.${quote(tablename)} t`)
    ).rows[0]
    result.push({ table: tablename, ...row })
  }
  return result
}

try {
  const before = await facts(sourcePool)
  const dump = spawnSync(
    'docker',
    ['exec', container, 'pg_dump', '-U', 'postgres', '--no-owner', '--no-acl', 'convergence_legacy16'],
    {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  )
  assert.equal(dump.status, 0, 'Fixture pg_dump failed')
  await mkdir('.test-artifacts/migration-recovery', { recursive: true })
  await writeFile('.test-artifacts/migration-recovery/legacy16.sql', dump.stdout)
  await admin.query(`CREATE DATABASE ${quote(restoredDatabase)}`)
  const restore = spawnSync(
    'docker',
    ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', restoredDatabase],
    {
      input: dump.stdout,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  )
  assert.equal(restore.status, 0, 'Fixture restore failed')
  const after = await facts(restored)
  assert.deepEqual(after, before, 'Restored source/mapping/ledger facts differ')
  const receipt = {
    executed_at: new Date().toISOString(),
    source: 'convergence_legacy16',
    restored: restoredDatabase,
    tables: after.length,
    rows: after.reduce((n, row) => n + BigInt(row.count), 0n).toString(),
    result: 'All public table counts and deterministic row digests match; source database preserved.',
  }
  await writeFile('.test-artifacts/migration-recovery.json', JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt))
} finally {
  await Promise.all([sourcePool.end(), admin.end(), restored.end()])
}
