import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { Pool } from 'pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { connectorIdentities, connectorLeases, connectorPairings } from '../../src/db/schema'

const runnerPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runnerPath)
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const artifacts = join(repository, '.test-artifacts')
const journal = JSON.parse(readFileSync(join(repository, 'drizzle/meta/_journal.json'), 'utf8')) as {
  entries: { tag: string; when: number }[]
}
const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('Explicit disposable DATABASE_URL is required for connector migration tests')
const target = new URL(connectionString)
if (
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.port !== '55439' ||
  !['/migration_constraint_round44', '/convergence_ci15'].includes(target.pathname)
)
  throw new Error('Dedicated loopback connector migration database is required')
const pool = new Pool({ connectionString })

const expectedConstraints = [connectorPairings, connectorIdentities, connectorLeases]
  .flatMap((table) => {
    const config = getTableConfig(table)
    return [
      ...config.columns
        .filter((column) => column.isUnique)
        .map((column) => {
          if (!column.uniqueName) throw new Error('ORM unique constraint name is required')
          return { table: config.name, name: column.uniqueName, type: 'u' }
        }),
      ...config.foreignKeys
        .filter((key) => config.name !== 'connector_leases' || key.reference().columns[0].name === 'connector_id')
        .map((key) => ({ table: config.name, name: key.getName(), type: 'f' })),
    ]
  })
  .sort((left, right) => left.name.localeCompare(right.name))

beforeEach(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
})
afterAll(async () => {
  await pool.end()
})

async function catalog() {
  return (
    await pool.query(`SELECT c.oid::text AS oid, t.relname AS table, c.conname AS name, c.contype AS type,
      c.conkey, c.confkey, c.confrelid::text AS referenced_table_oid,
      pg_get_constraintdef(c.oid) AS definition, c.convalidated AS validated,
      c.condeferrable AS deferrable, c.condeferred AS deferred,
      c.confupdtype AS update_action, c.confdeltype AS delete_action, c.confmatchtype AS match_type,
      c.conindid::text AS index_oid, ix.relname AS index_name,
      pg_get_indexdef(c.conindid) AS index_definition, am.amname AS index_method,
      i.indkey::text AS index_keys, i.indisunique AS index_unique,
      i.indisvalid AS index_valid, i.indisready AS index_ready,
      pg_get_expr(i.indpred,i.indrelid) AS index_predicate
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
      LEFT JOIN pg_class ix ON ix.oid=c.conindid
      LEFT JOIN pg_index i ON i.indexrelid=ix.oid
      LEFT JOIN pg_am am ON am.oid=ix.relam
    WHERE n.nspname='public' AND c.contype IN ('u','f') AND (
      t.relname IN ('connector_pairings','connector_identities') OR
      (t.relname='connector_leases' AND c.conkey=ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid=t.oid AND attname='connector_id')]))
    ORDER BY c.oid`)
  ).rows
}

async function history() {
  return (await pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows
}

async function rows() {
  const result: Record<string, unknown[]> = {}
  for (const table of ['owned_connections', 'connector_pairings', 'connector_identities', 'connector_leases']) {
    const key = table === 'connector_pairings' ? 'connection_id' : 'id'
    result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY ${key}`)).rows
  }
  return result
}

function assertNames(constraints: Awaited<ReturnType<typeof catalog>>) {
  expect
    .soft(
      constraints
        .map(({ table, name, type }) => ({ table, name, type }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    )
    .toEqual(expectedConstraints)
  const unique = constraints.filter((constraint) => constraint.type === 'u')
  expect.soft(unique.map(({ index_name }) => index_name).sort()).toEqual(
    expectedConstraints
      .filter(({ type }) => type === 'u')
      .map(({ name }) => name)
      .sort(),
  )
  expect(constraints).toHaveLength(6)
  expect(unique).toHaveLength(3)
  for (const constraint of constraints) {
    expect(constraint.validated).toBe(true)
    expect(constraint.deferrable).toBe(false)
    expect(constraint.deferred).toBe(false)
    expect(constraint.index_valid).toBe(true)
    expect(constraint.index_ready).toBe(true)
    expect(constraint.index_unique).toBe(true)
    if (constraint.type === 'f') {
      expect(constraint.update_action).toBe('a')
      expect(constraint.delete_action).toBe(constraint.table === 'connector_leases' ? 'a' : 'c')
    }
  }
}

function withoutNames(constraints: Awaited<ReturnType<typeof catalog>>) {
  return constraints.map(({ name: _name, index_name: indexName, index_definition: definition, ...constraint }) => ({
    ...constraint,
    // RENAME CONSTRAINT also renames a UNIQUE backing index, preserving its OID and shape.
    index_definition: definition.replace(`INDEX ${indexName} `, 'INDEX <name> '),
  }))
}

async function seed() {
  await pool.query(`
    INSERT INTO owned_connections(id,tenant_id,provider,mode,status,capabilities)
      VALUES ('connection-a','tenant-test','fixture','local','ready','{"models":["model-test"]}'),
             ('connection-b','tenant-test','fixture','local','pending','{}');
    INSERT INTO connector_pairings(connection_id,tenant_id,token_hash,expires_at,consumed_at)
      VALUES ('connection-a','tenant-test','pairing-hash-test','2030-01-01T00:00:00Z','2026-01-01T00:00:00Z');
    INSERT INTO connector_identities(id,connection_id,tenant_id,credential_hash,revoked_at)
      VALUES ('identity-a','connection-a','tenant-test','credential-hash-test','2026-01-02T00:00:00Z');
    INSERT INTO connector_leases(id,tenant_id,connection_id,lease_token_hash,connector_id,ready_models,expires_at,transport_seen_at)
      VALUES ('lease-a','tenant-test','connection-a','lease-hash-test','identity-a','["model-test"]',
        '2030-01-01T00:00:00Z','2026-01-03T00:00:00Z')`)
}

async function through27() {
  expect(journal.entries[26].tag).toBe('0026_provider_request_metadata')
  mkdirSync(artifacts, { recursive: true })
  expect(dirname(realpathSync(artifacts))).toBe(realpathSync(repository))
  const directory = mkdtempSync(join(artifacts, 'connector-constraint-prefix-'))
  try {
    mkdirSync(join(directory, 'meta'))
    writeFileSync(
      join(directory, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 27) }),
    )
    for (const entry of journal.entries.slice(0, 27))
      copyFileSync(join(repository, `drizzle/${entry.tag}.sql`), join(directory, `${entry.tag}.sql`))
    expect((await runMigrations(pool, { migrationsFolder: directory })).applied).toBe(27)
  } finally {
    const targetDirectory = realpathSync(directory)
    expect(dirname(targetDirectory)).toBe(realpathSync(artifacts))
    expect(basename(targetDirectory)).toMatch(/^connector-constraint-prefix-/)
    rmSync(targetDirectory, { recursive: true, force: true })
  }
}

describe('connector constraint canonical migrations', () => {
  it('deploys aligned physical names from scratch and reruns without changes', async () => {
    expect.soft((await runMigrations(pool)).applied).toBe(28)
    assertNames(await catalog())
    const original = await history()
    expect(original).toHaveLength(journal.entries.length)
    for (const [index, entry] of journal.entries.entries()) {
      expect(original[index].hash).toBe(
        createHash('sha256')
          .update(readFileSync(join(repository, `drizzle/${entry.tag}.sql`)))
          .digest('hex'),
      )
      expect(original[index].created_at).toBe(String(entry.when))
    }
    const constraints = await catalog()
    expect((await runMigrations(pool)).applied).toBe(0)
    expect(await history()).toEqual(original)
    expect(await catalog()).toEqual(constraints)
  })

  it('upgrades populated twenty-seven-entry history by renaming without rebuilding or changing rows', async () => {
    await through27()
    await seed()
    const originalRows = await rows()
    const originalHistory = await history()
    const originalConstraints = await catalog()
    expect.soft((await runMigrations(pool)).applied).toBe(1)
    const upgradedConstraints = await catalog()
    assertNames(upgradedConstraints)
    expect(withoutNames(upgradedConstraints)).toEqual(withoutNames(originalConstraints))
    expect(await rows()).toEqual(originalRows)
    expect((await history()).slice(0, 27)).toEqual(originalHistory)
    expect(await history()).toHaveLength(journal.entries.length)
    const upgradedHistory = await history()
    expect((await runMigrations(pool)).applied).toBe(0)
    expect(await rows()).toEqual(originalRows)
    expect(await catalog()).toEqual(upgradedConstraints)
    expect(await history()).toEqual(upgradedHistory)
  })

  it('preserves three UNIQUE and three foreign-key rejection boundaries after upgrade', async () => {
    await through27()
    await seed()
    await runMigrations(pool)
    const originalRows = await rows()
    const violations = [
      [
        '23505',
        "INSERT INTO connector_pairings VALUES('connection-b','tenant-test','pairing-hash-test','2030-01-01',NULL)",
      ],
      [
        '23505',
        "INSERT INTO connector_identities(id,connection_id,tenant_id,credential_hash) VALUES('identity-b','connection-a','tenant-test','new-hash')",
      ],
      [
        '23505',
        "INSERT INTO connector_identities(id,connection_id,tenant_id,credential_hash) VALUES('identity-b','connection-b','tenant-test','credential-hash-test')",
      ],
      [
        '23503',
        "INSERT INTO connector_pairings VALUES('missing-connection','tenant-test','new-hash','2030-01-01',NULL)",
      ],
      [
        '23503',
        "INSERT INTO connector_identities(id,connection_id,tenant_id,credential_hash) VALUES('identity-b','missing-connection','tenant-test','new-hash')",
      ],
      [
        '23503',
        "INSERT INTO connector_leases(id,tenant_id,connection_id,lease_token_hash,connector_id,expires_at) VALUES('lease-b','tenant-test','connection-b','new-lease-hash','missing-identity','2030-01-01')",
      ],
    ]
    for (const [code, sql] of violations) await expect(pool.query(sql)).rejects.toMatchObject({ code })
    expect(await rows()).toEqual(originalRows)
    expect((await runMigrations(pool)).applied).toBe(0)
  })
})
