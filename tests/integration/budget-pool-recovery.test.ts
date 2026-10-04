import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'

const supplied = process.env.DATABASE_URL
if (!supplied) throw new Error('Explicit disposable Budget idle recovery database required')
const database = new URL(supplied)
if (
  !['postgres:', 'postgresql:'].includes(database.protocol) ||
  database.hostname !== '127.0.0.1' ||
  database.port !== '55439' ||
  !['/workspace_budget_idle_recovery_round87', '/convergence_ci15'].includes(database.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV !== 'test'
)
  throw new Error('Exact disposable Budget idle recovery fixture required')

const folder = resolve('.test-artifacts/budget-idle-recovery-round87/formal-build')
const artifact = resolve(folder, 'budget.cjs')
const emptyEnvironment = resolve(folder, 'empty.env')
const app = `nexus-budget-idle-recovery87-test-${process.pid}`
const token = 'fixture-budget-idle-recovery87-test-token'
let owner: Client | undefined
let locked = false
const observations: Record<string, unknown>[] = []

async function until(read: () => boolean | Promise<boolean>, label: string, milliseconds = 4000) {
  const end = Date.now() + milliseconds
  while (!(await read())) {
    if (Date.now() >= end) throw new Error(label)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function backendRows() {
  return (
    await owner!.query<{ pid: number; state: string }>(
      'SELECT pid,state FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1',
      [app],
    )
  ).rows
}

async function accountingFacts() {
  const result: Record<string, { count: number; digest: string }> = {}
  for (const table of ['request_records', 'ledger_transactions', 'ledger_postings', 'outbox_events']) {
    result[table] = (
      await owner!.query<{ count: number; digest: string }>(
        `SELECT count(*)::int count, md5(COALESCE(jsonb_agg(to_jsonb(fact) ORDER BY fact.id)::text,'[]')) digest FROM ${table} fact`,
      )
    ).rows[0]
  }
  return result
}

beforeAll(async () => {
  owner = new Client({
    connectionString: supplied,
    application_name: 'nexus-budget-idle-recovery87-test-owner',
    connectionTimeoutMillis: 4000,
    statement_timeout: 8000,
  })
  await owner.connect()
  if ((await owner.query('SELECT current_database() name')).rows[0]?.name !== database.pathname.slice(1))
    throw new Error('Budget idle recovery actual database mismatch')
  locked = (await owner.query("SELECT pg_try_advisory_lock(hashtextextended('nexus-budget-idle-recovery87',0)) locked"))
    .rows[0]?.locked
  if (!locked) throw new Error('Budget idle recovery fixture already owned')
  if (
    (
      await owner.query(
        "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
      )
    ).rows[0]?.n !== 0
  )
    throw new Error('Budget idle recovery fixture has other clients')
  const migrationModule = pathToFileURL(resolve('scripts/db-migrate.mjs')).href
  const { runMigrations } = await import(migrationModule)
  const migrations = new Pool({
    connectionString: supplied,
    application_name: 'nexus-budget-idle-recovery87-test-migrations',
    max: 1,
    connectionTimeoutMillis: 4000,
    statement_timeout: 30000,
  })
  try {
    expect((await runMigrations(migrations)).total).toBe(28)
  } finally {
    await migrations.end()
  }
  await mkdir(folder, { recursive: true })
  await writeFile(emptyEnvironment, '')
  const buildModule = pathToFileURL(resolve('scripts/build-services.mjs')).href
  const { buildServices } = await import(buildModule)
  await buildServices(['budget'], folder)
}, 30000)

afterAll(async () => {
  if (process.env.NEXUS_BUDGET_RECOVERY_REPORT === '1')
    console.info('Budget idle recovery safe observations:', JSON.stringify(observations))
  try {
    if (owner && locked) {
      expect(
        (
          await owner.query(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
          )
        ).rows[0]?.n,
      ).toBe(0)
      await owner.query("SELECT pg_advisory_unlock(hashtextextended('nexus-budget-idle-recovery87',0))")
    }
  } finally {
    await owner?.end()
  }
})

async function startBudget() {
  const portLease = createServer()
  await new Promise<void>((resolve, reject) => {
    portLease.once('error', reject)
    portLease.listen(0, '127.0.0.1', resolve)
  })
  const port = (portLease.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => portLease.close((error) => (error ? reject(error) : resolve())))
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: supplied,
    PGAPPNAME: app,
    DOTENV_CONFIG_PATH: emptyEnvironment,
    BUDGET_SERVICE_TOKEN: token,
    GATEWAY_INTERNAL_TOKEN: 'fixture-distinct-control-recovery87-test-token',
    BUDGET_HOST: '127.0.0.1',
    BUDGET_PORT: String(port),
  }
  for (const name of ['Path', 'PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'COMSPEC', 'ComSpec', 'PATHEXT'])
    if (process.env[name] !== undefined) env[name] = process.env[name]
  const child = spawn(process.execPath, [artifact], {
    cwd: folder,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '',
    stderr = '',
    exit: number | null | undefined,
    spawnError = false
  child.stdout.on('data', (bytes) => {
    stdout += bytes.toString()
  })
  child.stderr.on('data', (bytes) => {
    stderr += bytes.toString()
  })
  child.once('error', () => {
    spawnError = true
  })
  const closed = new Promise<void>((resolve) =>
    child.once('close', (code) => {
      exit = code
      resolve()
    }),
  )
  const cleanup = async () => {
    if (exit === undefined) child.kill()
    await closed
    await until(async () => (await backendRows()).length === 0, 'Budget child database sessions did not close')
  }
  try {
    await until(
      () => stdout.includes('[budget] private authorization listener ready') || exit !== undefined,
      'Budget child listener did not start',
    )
    expect(spawnError).toBe(false)
    expect(exit).toBeUndefined()
  } catch (error) {
    await cleanup()
    throw error
  }
  return {
    exit: () => exit,
    stdout: () => stdout,
    stderr: () => stderr,
    closed,
    cleanup,
    request: (path: string, options: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(4000) }),
  }
}

it('a lost idle Budget backend preserves the actual service and permits a new explicit readiness query', async () => {
  const before = await accountingFacts()
  const service = await startBudget()
  try {
    const headers = { authorization: `Bearer ${token}` }
    const healthy = await service.request('/readyz', { headers })
    expect(healthy.status).toBe(200)
    expect(await healthy.json()).toEqual({ ready: true })
    await until(async () => {
      const rows = await backendRows()
      return rows.length === 1 && rows[0].state === 'idle'
    }, 'Actual Budget backend did not become uniquely idle')
    const original = (await backendRows())[0]
    expect(Number.isInteger(original.pid)).toBe(true)
    const result = await owner!.query(
      'SELECT pg_terminate_backend(pid) killed FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND pid=$2 AND state=$3',
      [app, original.pid, 'idle'],
    )
    expect(result.rows).toEqual([{ killed: true }])
    const diagnosticLines = () =>
      service
        .stdout()
        .split('\n')
        .slice(0, -1)
        .filter((line) => line.includes('database_idle_connection_lost'))
    await until(
      () => service.exit() !== undefined || diagnosticLines().length > 0,
      'Budget must handle the actual backend-loss event',
    )
    observations.push({
      operation: 'idle-loss',
      survived: service.exit() === undefined,
      exit: service.exit() ?? null,
      unhandledError: service.stderr().includes("Unhandled 'error' event"),
    })
    expect(service.exit()).toBeUndefined()
    expect(service.stderr().length).toBe(0)
    const diagnostics = diagnosticLines().map((line) => JSON.parse(line))
    expect(diagnostics.length).toBe(1)
    const diagnostic = diagnostics[0]
    expect(
      Object.keys(diagnostic).sort().join(',') === 'error_kind,level,msg,service,time' &&
        diagnostic.service === 'budget' &&
        diagnostic.level === 'error' &&
        diagnostic.msg === 'Idle database connection lost' &&
        diagnostic.error_kind === 'database_idle_connection_lost' &&
        typeof diagnostic.time === 'string',
    ).toBe(true)
    const recovered = await service.request('/readyz', { headers })
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toEqual({ ready: true })
    const replacements = await backendRows()
    expect(replacements).toHaveLength(1)
    expect(replacements[0].pid).not.toBe(original.pid)
    expect(await accountingFacts()).toEqual(before)
  } finally {
    await service.cleanup()
  }
}, 15000)

it('Budget still rejects unauthenticated readiness and malformed reservations without opening a database connection or changing facts', async () => {
  const before = await accountingFacts()
  const service = await startBudget()
  try {
    const denied = await service.request('/readyz')
    expect(denied.status).toBe(401)
    expect(await denied.json()).toEqual({ error: { code: 'unauthorized' } })
    expect(await backendRows()).toEqual([])
    const malformed = await service.request('/v1/reservations', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: '{}',
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: { code: 'invalid_request' } })
    expect(await backendRows()).toEqual([])
    expect(await accountingFacts()).toEqual(before)
    expect(service.exit()).toBeUndefined()
    expect(service.stderr().length).toBe(0)
    observations.push({
      operation: 'authorization-controls',
      unauthenticated: 401,
      malformed: 400,
      databaseConnections: 0,
      accountingUnchanged: true,
    })
  } finally {
    await service.cleanup()
  }
}, 15000)
