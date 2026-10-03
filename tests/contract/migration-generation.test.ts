import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const artifacts = join(repository, '.test-artifacts')
const kit = join(repository, 'node_modules/drizzle-kit/bin.cjs')
const noChanges = 'No schema changes, nothing to migrate'

type Fixture = { directory: string; schema: string; output: string; metadata: string }
type Journal = { entries: { tag: string }[] }

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

function withFixture(check: (fixture: Fixture) => void) {
  mkdirSync(artifacts, { recursive: true })
  expect(dirname(realpathSync(artifacts))).toBe(realpathSync(repository))
  const directory = mkdtempSync(join(artifacts, 'migration-generation-'))
  const output = join(directory, 'drizzle')
  const metadata = join(output, 'meta')
  const schema = join(directory, 'schema.ts')
  const originalSchema = readFileSync(join(repository, 'src/db/schema.ts'))
  const originalMetadata = metadataState(join(repository, 'drizzle/meta'))
  try {
    mkdirSync(output)
    cpSync(join(repository, 'drizzle/meta'), metadata, { recursive: true })
    writeFileSync(schema, originalSchema)
    // JSON avoids importing the repository config or loading any .env file.
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({ dialect: 'postgresql', schema: './schema.ts', out: './drizzle' }),
    )
    check({ directory, schema, output, metadata })
  } finally {
    const target = realpathSync(directory)
    expect(dirname(target)).toBe(realpathSync(artifacts))
    expect(basename(target)).toMatch(/^migration-generation-/)
    rmSync(target, { recursive: true, force: true })
    expect(readFileSync(join(repository, 'src/db/schema.ts'))).toEqual(originalSchema)
    expect(metadataState(join(repository, 'drizzle/meta'))).toEqual(originalMetadata)
  }
}

function generate(fixture: Fixture) {
  // Do not inherit credentials, NODE_OPTIONS or application runtime settings.
  // Next's ProcessEnv declaration requires NODE_ENV; do not inherit its value.
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' }
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'ComSpec']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const result = spawnSync(process.execPath, [kit, 'generate', '--config=config.json', '--name=generation_control'], {
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
  return output
}

function sqlFiles(fixture: Fixture) {
  return readdirSync(fixture.output)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

describe('offline migration generation', () => {
  it('leaves SQL, snapshots and journal unchanged when the schema has no changes', () => {
    withFixture((fixture) => {
      const before = metadataState(fixture.metadata)
      const output = generate(fixture)
      // Kit can print an internal error and still exit zero; require its
      // explicit no-change result as well as unchanged files and bytes.
      expect.soft(output).toContain(noChanges)
      expect.soft(sqlFiles(fixture)).toEqual([])
      expect(metadataState(fixture.metadata)).toEqual(before)
    })
  }, 30000)

  it('generates only a new nullable column and then returns to an unchanged baseline', () => {
    withFixture((fixture) => {
      const source = readFileSync(fixture.schema, 'utf8')
      const table = /export const projects = pgTable\(\s*'projects',\s*\{/
      expect(source.match(table)).not.toBeNull()
      expect(source).not.toContain('migration_generation_probe')
      writeFileSync(
        fixture.schema,
        source.replace(table, "$&\n    migrationGenerationProbe: text('migration_generation_probe'),"),
      )
      const before = metadataState(fixture.metadata)
      const journalPath = join(fixture.metadata, '_journal.json')
      const journalBefore: Journal = JSON.parse(readFileSync(journalPath, 'utf8'))
      const snapshots = Object.keys(before).filter((name) => name.endsWith('_snapshot.json'))
      const latest = JSON.parse(readFileSync(join(fixture.metadata, snapshots.at(-1)!), 'utf8')) as { id: string }

      const output = generate(fixture)
      const files = sqlFiles(fixture)
      expect(files, output).toHaveLength(1)
      const sql = readFileSync(join(fixture.output, files[0]), 'utf8')
      const statements = sql
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean)
      // Exact DDL also excludes replaying connector tables or metadata indexes.
      expect(statements).toEqual(['ALTER TABLE "projects" ADD COLUMN "migration_generation_probe" text;'])
      const after = metadataState(fixture.metadata)
      const added = Object.keys(after).filter((name) => !(name in before))
      expect(added).toHaveLength(1)
      expect(added[0]).toMatch(/_snapshot\.json$/)
      const snapshot = JSON.parse(readFileSync(join(fixture.metadata, added[0]), 'utf8')) as { prevId: string }
      expect(snapshot.prevId).toBe(latest.id)
      for (const name of Object.keys(before).filter((name) => name !== '_journal.json')) {
        expect(after[name], name).toBe(before[name])
      }
      const journalAfter: Journal = JSON.parse(readFileSync(journalPath, 'utf8'))
      expect(journalAfter.entries).toHaveLength(journalBefore.entries.length + 1)
      expect(journalAfter.entries.slice(0, -1)).toEqual(journalBefore.entries)

      expect(generate(fixture)).toContain(noChanges)
      expect(sqlFiles(fixture)).toEqual(files)
      expect(readFileSync(join(fixture.output, files[0]), 'utf8')).toBe(sql)
      expect(metadataState(fixture.metadata)).toEqual(after)
    })
  }, 45000)
})
