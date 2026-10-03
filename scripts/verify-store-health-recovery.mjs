import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { runMigrations } from './db-migrate.mjs'

// Opt-in destructive fixture: never read .env or infer an application database.
const databaseName = 'gateway_test_health_recovery_round57'
const repository = fileURLToPath(new URL('../', import.meta.url))
const source = process.env.GATEWAY_HEALTH_RECOVERY_DATABASE_URL || ''
const prepareOnly = process.argv[2] === '--prepare-only'
let phase = 'explicit fixture validation'
let directory
let binary
let pool
let privateValues = [source]

function redact(value) {
  for (const secret of privateValues) if (secret) value = value.split(secret).join('<fixture-private>')
  return value
}

function execute(args, environment, timeout) {
  const result = spawnSync('go', args, {
    cwd: join(repository, 'services/gateway'),
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  })
  process.stdout.write(redact(`${result.stdout || ''}${result.stderr || ''}`))
  if (result.error || result.status !== 0) throw new Error('Required Go stage failed')
}

try {
  const target = new URL(source)
  if (
    source.includes('?') ||
    source.includes('#') ||
    target.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost'].includes(target.hostname) ||
    target.port !== '55439' ||
    target.pathname !== `/${databaseName}` ||
    process.env.NODE_ENV === 'production'
  )
    throw new Error('Exact disposable PostgreSQL fixture required')
  privateValues = [source, target.href, decodeURIComponent(target.password)]

  // Build before touching the database; the formal leaf starts this executable.
  directory = await mkdtemp(join(tmpdir(), 'nexus-store-health-'))
  binary = join(directory, process.platform === 'win32' ? 'gateway.exe' : 'gateway')
  const environment = { GOENV: 'off', GOTOOLCHAIN: 'local', GOWORK: 'off' }
  for (const key of [
    'PATH',
    'HOME',
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'ComSpec',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
  ])
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  phase = 'native Gateway build'
  execute(['build', '-o', binary, '.'], environment, 120000)

  phase = 'dedicated database identity and migration setup'
  pool = new pg.Pool({ connectionString: source, max: 1, connectionTimeoutMillis: 3000, query_timeout: 10000 })
  if ((await pool.query('SELECT current_database() AS name')).rows[0].name !== databaseName)
    throw new Error('Dedicated database identity mismatch')
  // The caller must first create this exact isolated database. Refuse to reset
  // a fixture that another process still owns.
  if (
    Number(
      (
        await pool.query(
          'SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
        )
      ).rows[0].count,
    ) !== 0
  )
    throw new Error('Dedicated database has active owners')
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const migrations = await runMigrations(pool)
  if (migrations.total !== 28 || migrations.applied !== 28) throw new Error('Canonical migration count mismatch')
  await pool.query(`
    INSERT INTO organizations(id,tenant_id,name,slug) VALUES('org-test','tenant-test','Synthetic health fixture','round57');
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES('project-test','tenant-test','org-test','Synthetic project');
    INSERT INTO downstream_api_keys(id,tenant_id,organization_id,name,hash,prefix,project_id)
      VALUES('key-test','tenant-test','org-test','Synthetic key','fixture-hash','fixture','project-test');
    INSERT INTO providers(id,code,name,official_base_url) VALUES('prov_openai','openai','Synthetic provider','http://127.0.0.1');
    INSERT INTO provider_credentials(id,provider_id,name,encrypted_secret,is_platform_managed)
      VALUES('cred_test','prov_openai','Synthetic managed credential','synthetic-never-decrypted',true);
    INSERT INTO channels(id,tenant_id,provider_id,provider_credential_id,name)
      VALUES('chan_test_1','tenant-test','prov_openai','cred_test','Synthetic channel');
    INSERT INTO provider_price_versions(id,provider_id,upstream_model_id,input_price,output_price,source_type,status)
      VALUES('pv_test_openai_gpt-4o','prov_openai','gpt-4o',2.5,10,'manual','active');
    INSERT INTO price_components(price_version_id,kind,amount)
      VALUES('pv_test_openai_gpt-4o','input',2.5),('pv_test_openai_gpt-4o','output',10);
    INSERT INTO sale_price_rules(id,tenant_id,organization_id,provider_id,upstream_model_id,pricing_mode)
      VALUES('rule-fixture','tenant-test','org-test','prov_openai','gpt-4o','markup');
    INSERT INTO sale_price_snapshots(id,rule_id,provider_price_version_id,pricing_mode,input_price,output_price)
      VALUES('sale-fixture','rule-fixture','pv_test_openai_gpt-4o','markup',2.5,10);
  `)
  await pool.end()
  pool = undefined

  if (!prepareOnly) {
    phase = 'actual Gateway storage recovery test'
    execute(
      ['test', '.', '-run', '^TestStoreHealthRecoveryPostgres$', '-count=1', '-v', '-timeout', '45s'],
      {
        ...environment,
        GATEWAY_HEALTH_RECOVERY_DATABASE_URL: source,
        GATEWAY_HEALTH_RECOVERY_BINARY: binary,
      },
      90000,
    )
  }

  phase = 'dedicated database handoff'
  pool = new pg.Pool({ connectionString: source, max: 1, connectionTimeoutMillis: 3000, query_timeout: 3000 })
  const active = Number(
    (
      await pool.query(
        'SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
      )
    ).rows[0].count,
  )
  if (active !== 0) throw new Error('Native process left database sessions open')
  console.log(
    prepareOnly
      ? 'Storage recovery fixture prepared with 28 canonical migrations for the full Go race suite; no other sessions remain.'
      : 'Storage recovery verified with 28 canonical migrations; no other fixture sessions remain.',
  )
} catch {
  // Driver errors may contain connection strings. Tests print only safe observations.
  console.error(`Storage recovery verification failed during ${phase}.`)
  process.exitCode = 1
} finally {
  try {
    if (pool) await pool.end()
    // Only the one generated executable and its now-empty temporary directory.
    if (binary) await rm(binary, { force: true })
    if (directory) await rmdir(directory)
  } catch {
    console.error('Storage recovery fixture cleanup failed.')
    process.exitCode = 1
  }
}
