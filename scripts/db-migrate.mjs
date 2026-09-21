import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

const defaultFolder = fileURLToPath(new URL('../drizzle/', import.meta.url))
const compatibilityTag = '0005_big_gauntlet'
const compatibilityHash = '1764da614c756fd83176e3d281b0b96a82100cb68e8738223650ba62525e330e'
const duplicateStatements = new Set([
  'ALTER TABLE "outbox_events" ADD COLUMN "next_attempt_at" timestamp with time zone;',
  'ALTER TABLE "outbox_events" ADD COLUMN "claimed_by" text;',
  'ALTER TABLE "outbox_events" ADD COLUMN "claimed_at" timestamp with time zone;',
  'CREATE INDEX "outbox_events_claim_idx" ON "outbox_events" USING btree ("status","next_attempt_at");',
])

async function readMigrations(folder) {
  const journal = JSON.parse(await readFile(resolve(folder, 'meta/_journal.json'), 'utf8'))
  if (journal.dialect !== 'postgresql' || !Array.isArray(journal.entries)) throw new Error('Invalid migration journal')
  const migrations = []
  const tags = new Set()
  for (const [i, entry] of journal.entries.entries()) {
    if (
      entry.idx !== i ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= (migrations.at(-1)?.when ?? 0) ||
      typeof entry.tag !== 'string' ||
      !/^\d{4}_[a-z0-9_]+$/.test(entry.tag) ||
      tags.has(entry.tag)
    ) {
      throw new Error('Invalid migration journal history ordering')
    }
    tags.add(entry.tag)
    const bytes = await readFile(resolve(folder, `${entry.tag}.sql`))
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (entry.tag === compatibilityTag && hash !== compatibilityHash) {
      throw new Error('0005 compatibility checksum mismatch; historical SQL must remain unchanged')
    }
    migrations.push({
      ...entry,
      hash,
      statements: bytes
        .toString('utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    })
  }
  return migrations
}

// This is deliberately narrower than IF NOT EXISTS: the original 0003 shape
// must be present, including defaults, nullability and the complete index form.
async function validateOutboxCompatibility(client) {
  const columns = (
    await client.query(
      `
    SELECT a.attname, format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull, a.attidentity, a.attgenerated, a.atthasdef
    FROM pg_attribute a
    WHERE a.attrelid = to_regclass('public.outbox_events')
      AND a.attname = ANY($1::text[]) AND NOT a.attisdropped`,
      [['next_attempt_at', 'claimed_by', 'claimed_at']],
    )
  ).rows
  for (const [name, type] of [
    ['next_attempt_at', 'timestamp with time zone'],
    ['claimed_by', 'text'],
    ['claimed_at', 'timestamp with time zone'],
  ]) {
    const column = columns.find((c) => c.attname === name)
    if (
      !column ||
      column.type !== type ||
      column.attnotnull ||
      column.atthasdef ||
      column.attidentity ||
      column.attgenerated
    ) {
      throw new Error(`Incompatible outbox definition: ${name}`)
    }
  }
  const index = (
    await client.query(`
    SELECT pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid, i.indisready,
      i.indisunique, i.indisexclusion, i.indisprimary
    FROM pg_index i WHERE i.indexrelid = to_regclass('public.outbox_events_claim_idx')
      AND i.indrelid = to_regclass('public.outbox_events')`)
  ).rows[0]
  if (
    !index ||
    index.definition !==
      'CREATE INDEX outbox_events_claim_idx ON public.outbox_events USING btree (status, next_attempt_at)' ||
    !index.indisvalid ||
    !index.indisready ||
    index.indisunique ||
    index.indisexclusion ||
    index.indisprimary
  ) {
    throw new Error('Incompatible outbox definition: outbox_events_claim_idx')
  }
}

/** Apply only journaled SQL. The caller owns the pool and its connection configuration. */
export async function runMigrations(pool, { migrationsFolder = defaultFolder } = {}) {
  const migrations = await readMigrations(migrationsFolder)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Shared by every invocation, released by COMMIT/ROLLBACK or connection loss.
    await client.query('SELECT pg_advisory_xact_lock(1789018848, 16001)')
    await client.query('SET LOCAL search_path TO public, pg_catalog')
    await client.query('CREATE SCHEMA IF NOT EXISTS drizzle')
    await client.query(
      'CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)',
    )
    await client.query('LOCK TABLE drizzle.__drizzle_migrations IN EXCLUSIVE MODE')
    const history = (await client.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows
    for (const [i, applied] of history.entries()) {
      const expected = migrations[i]
      if (!expected || applied.hash !== expected.hash || String(applied.created_at) !== String(expected.when)) {
        throw new Error(`Migration history is not the complete canonical prefix at entry ${i}`)
      }
    }
    if (history.length >= 4) await validateOutboxCompatibility(client)
    let skipped = 0
    for (const migration of migrations.slice(history.length)) {
      if (migration.tag === compatibilityTag) await validateOutboxCompatibility(client)
      for (const statement of migration.statements) {
        if (migration.tag === compatibilityTag && duplicateStatements.has(statement)) {
          skipped++
          continue
        }
        await client.query(statement)
      }
      await client.query('INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)', [
        migration.hash,
        migration.when,
      ])
    }
    await client.query('COMMIT')
    return {
      applied: migrations.length - history.length,
      total: migrations.length,
      compatibilityStatementsSkipped: skipped,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL must be injected explicitly')
    process.exitCode = 1
  } else {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    try {
      console.log(JSON.stringify(await runMigrations(pool)))
    } catch (error) {
      console.error(
        `Canonical migration failed (${error.code ?? 'validation'}); verify history and catalog shape before retrying`,
      )
      process.exitCode = 1
    } finally {
      await pool.end()
    }
  }
}
