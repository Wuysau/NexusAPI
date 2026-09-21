import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const runnerPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runnerPath)
if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL is required for migration tests')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'))

beforeEach(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
})
afterAll(async () => {
  await pool.end()
})

async function through0004() {
  await pool.query(
    'CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)',
  )
  for (const entry of journal.entries.slice(0, 5)) {
    const sql = readFileSync(`drizzle/${entry.tag}.sql`, 'utf8')
    await pool.query(sql)
    await pool.query('INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)', [
      createHash('sha256').update(sql).digest('hex'),
      entry.when,
    ])
  }
}

describe('canonical journal migration', () => {
  it('bootstraps every journal entry and reruns without changes', async () => {
    expect((await runMigrations(pool)).applied).toBe(journal.entries.length)
    expect((await runMigrations(pool)).applied).toBe(0)
    expect((await pool.query('SELECT * FROM drizzle.__drizzle_migrations')).rowCount).toBe(journal.entries.length)
    expect((await pool.query("SELECT to_regclass('public.projects') AS name")).rows[0].name).toBe('projects')
  })

  it('upgrades original 0004 history while preserving original checksums', async () => {
    await through0004()
    expect((await runMigrations(pool)).applied).toBe(journal.entries.length - 5)
    const history = (await pool.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at'))
      .rows
    for (const [i, entry] of journal.entries.entries()) {
      expect(history[i].hash).toBe(
        createHash('sha256')
          .update(readFileSync(`drizzle/${entry.tag}.sql`))
          .digest('hex'),
      )
      expect(history[i].created_at).toBe(String(entry.when))
    }
  })

  it.each(['hash', 'timestamp', 'gap', 'duplicate'])('rejects invalid complete applied history: %s', async (kind) => {
    await through0004()
    if (kind === 'hash') await pool.query("UPDATE drizzle.__drizzle_migrations SET hash='bad' WHERE id=2")
    if (kind === 'timestamp')
      await pool.query('UPDATE drizzle.__drizzle_migrations SET created_at=created_at+1 WHERE id=2')
    if (kind === 'gap') await pool.query('DELETE FROM drizzle.__drizzle_migrations WHERE id=2')
    if (kind === 'duplicate')
      await pool.query(
        'INSERT INTO drizzle.__drizzle_migrations(hash,created_at) SELECT hash,created_at FROM drizzle.__drizzle_migrations WHERE id=2',
      )
    await expect(runMigrations(pool)).rejects.toThrow(/history/)
    expect((await pool.query("SELECT to_regclass('public.projects') AS name")).rows[0].name).toBeNull()
  })

  it.each([
    'ALTER TABLE outbox_events ALTER COLUMN claimed_by TYPE varchar(200)',
    "ALTER TABLE outbox_events ALTER COLUMN claimed_by SET DEFAULT 'unknown'",
    'ALTER TABLE outbox_events ALTER COLUMN claimed_by SET NOT NULL',
    'DROP INDEX outbox_events_claim_idx; CREATE INDEX outbox_events_claim_idx ON outbox_events(next_attempt_at,status)',
    "DROP INDEX outbox_events_claim_idx; CREATE INDEX outbox_events_claim_idx ON outbox_events(status,next_attempt_at) WHERE status='pending'",
  ])('refuses incompatible duplicate shape and rolls back pending DDL: %s', async (sql) => {
    await through0004()
    await pool.query(sql)
    await expect(runMigrations(pool)).rejects.toThrow(/outbox/)
    expect((await pool.query('SELECT * FROM drizzle.__drizzle_migrations')).rowCount).toBe(5)
    expect((await pool.query("SELECT to_regclass('public.projects') AS name")).rows[0].name).toBeNull()
  })

  it('refuses modified 0005 bytes before applying compatibility exceptions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-migrations-'))
    try {
      cpSync('drizzle', dir, { recursive: true })
      writeFileSync(
        join(dir, '0005_big_gauntlet.sql'),
        readFileSync(join(dir, '0005_big_gauntlet.sql'), 'utf8') + '\n-- changed',
      )
      await expect(runMigrations(pool, { migrationsFolder: dir })).rejects.toThrow(/checksum/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serializes concurrent bootstrap attempts through the advisory lock', async () => {
    const results = await Promise.all([runMigrations(pool), runMigrations(pool)])
    expect(results.map((result) => result.applied).sort((a, b) => a - b)).toEqual([0, journal.entries.length])
    expect((await pool.query('SELECT * FROM drizzle.__drizzle_migrations')).rowCount).toBe(journal.entries.length)
  })

  it('rolls back all pending schema and history when a later migration fails', async () => {
    await through0004()
    const dir = mkdtempSync(join(tmpdir(), 'nexus-migrations-'))
    try {
      cpSync('drizzle', dir, { recursive: true })
      const path = join(dir, `${journal.entries.at(-1).tag}.sql`)
      writeFileSync(
        path,
        readFileSync(path, 'utf8') + '\n--> statement-breakpoint\nSELECT missing_migration_function();',
      )
      await expect(runMigrations(pool, { migrationsFolder: dir })).rejects.toThrow(/missing_migration_function/)
      expect((await pool.query('SELECT * FROM drizzle.__drizzle_migrations')).rowCount).toBe(5)
      expect((await pool.query("SELECT to_regclass('public.projects') AS name")).rows[0].name).toBeNull()
      expect((await runMigrations(pool)).applied).toBe(journal.entries.length - 5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detects duplicate definition drift even on an otherwise completed rerun', async () => {
    await runMigrations(pool)
    await pool.query('DROP INDEX outbox_events_claim_idx')
    await expect(runMigrations(pool)).rejects.toThrow(/outbox_events_claim_idx/)
  })
})
