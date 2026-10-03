import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const runnerPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runnerPath)
if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL is required')
let database: URL
try {
  database = new URL(process.env.DATABASE_URL)
} catch {
  throw new Error('Invalid disposable DATABASE_URL')
}
if (
  !['127.0.0.1', 'localhost'].includes(database.hostname) ||
  database.port !== '55439' ||
  !['/migration_constraint_round44', '/convergence_ci15'].includes(database.pathname)
) {
  throw new Error('Dedicated connector constraint migration or CI database is required; this suite resets its schema')
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const artifacts = join(repository, '.test-artifacts')
const kit = join(repository, 'node_modules/drizzle-kit/bin.cjs')
const noChanges = 'No schema changes, nothing to migrate'
const pairingUnique = 'connector_pairings_token_hash_unique'
const pairingFK = 'connector_pairings_connection_id_owned_connections_id_fk'
type Fixture = { directory: string; schema: string; output: string; metadata: string }
type Constraint = {
  table_name: string
  name: string
  kind: string
  columns: string[]
  oid: string
  index_oid: string
  definition: string
  validated: boolean
}

beforeEach(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  await pool.query(`
    INSERT INTO owned_connections(id,tenant_id,provider,mode) VALUES
      ('generation-pairing','generation-tenant','fixture','byok'),
      ('generation-identity','generation-tenant','fixture','byok'),
      ('generation-lease','generation-tenant','fixture','byok');
    INSERT INTO connector_pairings(connection_id,tenant_id,token_hash,expires_at)
      VALUES('generation-pairing','generation-tenant','generation-pairing-hash','2030-01-01');
    INSERT INTO connector_identities(id,connection_id,tenant_id,credential_hash)
      VALUES('generation-identity-id','generation-identity','generation-tenant','generation-credential-hash');
    INSERT INTO connector_leases(id,connection_id,tenant_id,lease_token_hash,connector_id,ready_models,expires_at)
      VALUES('generation-lease-id','generation-lease','generation-tenant','generation-lease-hash',
        'generation-identity-id','["fixture-model"]','2030-01-01')
  `)
})
afterAll(async () => {
  await pool.end()
})

function metadataState(directory: string) {
  return Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => [
        name,
        createHash('sha256')
          .update(readFileSync(join(directory, name)))
          .digest('hex'),
      ]),
  )
}

async function withFixture(check: (fixture: Fixture) => Promise<void>) {
  mkdirSync(artifacts, { recursive: true })
  expect(dirname(realpathSync(artifacts))).toBe(realpathSync(repository))
  const directory = mkdtempSync(join(artifacts, 'connector-constraint-generation-'))
  const output = join(directory, 'drizzle')
  const metadata = join(output, 'meta')
  const schema = join(directory, 'schema.ts')
  const originalSchema = readFileSync(join(repository, 'src/db/schema.ts'))
  const originalMetadata = metadataState(join(repository, 'drizzle/meta'))
  try {
    mkdirSync(output)
    cpSync(join(repository, 'drizzle/meta'), metadata, { recursive: true })
    writeFileSync(schema, originalSchema)
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({ dialect: 'postgresql', schema: './schema.ts', out: './drizzle' }),
    )
    await check({ directory, schema, output, metadata })
  } finally {
    const target = realpathSync(directory)
    expect(dirname(target)).toBe(realpathSync(artifacts))
    expect(basename(target)).toMatch(/^connector-constraint-generation-/)
    rmSync(target, { recursive: true, force: true })
    expect(readFileSync(join(repository, 'src/db/schema.ts'))).toEqual(originalSchema)
    expect(metadataState(join(repository, 'drizzle/meta'))).toEqual(originalMetadata)
  }
}

function generate(fixture: Fixture) {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' }
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'ComSpec']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const result = spawnSync(process.execPath, [kit, 'generate', '--config=config.json', '--name=constraint_control'], {
    cwd: fixture.directory,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
    maxBuffer: 2 * 1024 * 1024,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  expect(result.error, output).toBeUndefined()
  expect(result.status, output).toBe(0)
  const files = readdirSync(fixture.output).filter((name) => name.endsWith('.sql'))
  return { output, files }
}

function generatedStatements(fixture: Fixture) {
  const { output, files } = generate(fixture)
  expect(files, output).toHaveLength(1)
  return readFileSync(join(fixture.output, files[0]), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean)
}

async function constraints(client: PoolClient) {
  const rows = (
    await client.query<Constraint>(`SELECT t.relname AS table_name,c.conname AS name,c.contype AS kind,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.ord) AS columns,
      c.oid::text AS oid,c.conindid::text AS index_oid,pg_get_constraintdef(c.oid) AS definition,
      c.convalidated AS validated
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' AND t.relname IN ('connector_pairings','connector_identities','connector_leases')
        AND c.contype IN ('f','u') ORDER BY t.relname,c.conname`)
  ).rows
  return rows.filter(
    (row) =>
      row.table_name !== 'connector_leases' ||
      (row.kind === 'f' && row.columns.length === 1 && row.columns[0] === 'connector_id'),
  )
}

async function storedData(client: PoolClient) {
  return {
    connections: (await client.query('SELECT * FROM owned_connections ORDER BY id')).rows,
    pairings: (await client.query('SELECT * FROM connector_pairings ORDER BY connection_id')).rows,
    identities: (await client.query('SELECT * FROM connector_identities ORDER BY id')).rows,
    leases: (await client.query('SELECT * FROM connector_leases ORDER BY id')).rows,
  }
}

async function executeAndRollback(statements: string[], target: string, change: 'unique' | 'fk') {
  const client = await pool.connect()
  try {
    const beforeConstraints = await constraints(client)
    const beforeData = await storedData(client)
    expect(beforeConstraints).toHaveLength(6)
    await client.query('BEGIN')
    try {
      // On OLD metadata the generated DROP target is absent from PostgreSQL.
      expect(beforeConstraints.map((constraint) => constraint.name)).toContain(target)
      for (const statement of statements) await client.query(statement)
      const changed = await constraints(client)
      expect(changed.filter((constraint) => constraint.name !== target)).toEqual(
        beforeConstraints.filter((constraint) => constraint.name !== target),
      )
      if (change === 'unique') {
        expect(changed).toHaveLength(5)
        expect(changed.map((constraint) => constraint.name)).not.toContain(target)
      } else {
        expect(changed).toHaveLength(6)
        expect(changed.find((constraint) => constraint.name === target)?.definition).toContain('ON DELETE RESTRICT')
      }
      expect(await storedData(client)).toEqual(beforeData)
    } finally {
      await client.query('ROLLBACK')
      expect(await constraints(client)).toEqual(beforeConstraints)
      expect(await storedData(client)).toEqual(beforeData)
    }
  } finally {
    client.release()
  }
}

describe('connector constraint generation against the canonical schema', () => {
  it('keeps unchanged schema generation at zero DDL', async () => {
    await withFixture(async (fixture) => {
      const before = metadataState(fixture.metadata)
      const { output, files } = generate(fixture)
      expect(output).toContain(noChanges)
      expect(files).toEqual([])
      expect(metadataState(fixture.metadata)).toEqual(before)
    })
  }, 30000)

  it('generates a valid UNIQUE removal and restores every constraint and row on rollback', async () => {
    await withFixture(async (fixture) => {
      const source = readFileSync(fixture.schema, 'utf8')
      const needle = "tokenHash: text('token_hash').notNull().unique(),"
      expect(source.split(needle)).toHaveLength(2)
      writeFileSync(fixture.schema, source.replace(needle, "tokenHash: text('token_hash').notNull(),"))
      const statements = generatedStatements(fixture)
      expect(statements).toEqual([`ALTER TABLE "connector_pairings" DROP CONSTRAINT "${pairingUnique}";`])
      await executeAndRollback(statements, pairingUnique, 'unique')
    })
  }, 30000)

  it('generates a valid FK action change and restores every constraint and row on rollback', async () => {
    await withFixture(async (fixture) => {
      const source = readFileSync(fixture.schema, 'utf8')
      const start = source.indexOf("export const connectorPairings = pgTable('connector_pairings', {")
      const end = source.indexOf('export const connectorIdentities', start)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      const pairing = source.slice(start, end)
      expect(pairing.split("onDelete: 'cascade'")).toHaveLength(2)
      writeFileSync(
        fixture.schema,
        source.slice(0, start) + pairing.replace("onDelete: 'cascade'", "onDelete: 'restrict'") + source.slice(end),
      )
      const statements = generatedStatements(fixture)
      expect(statements).toEqual([
        `ALTER TABLE "connector_pairings" DROP CONSTRAINT "${pairingFK}";`,
        `ALTER TABLE "connector_pairings" ADD CONSTRAINT "${pairingFK}" FOREIGN KEY ("connection_id") REFERENCES "public"."owned_connections"("id") ON DELETE restrict ON UPDATE no action;`,
      ])
      await executeAndRollback(statements, pairingFK, 'fk')
    })
  }, 30000)
})
