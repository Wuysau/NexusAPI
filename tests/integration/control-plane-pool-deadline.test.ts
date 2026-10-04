import { spawn } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { pool } from '@/db'
import { GET as health } from '@/app/api/health/route'

const supplied = process.env.DATABASE_URL
if (!supplied) throw new Error('Explicit disposable Control Plane pool fixture required')
const target = new URL(supplied)
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  target.hostname !== '127.0.0.1' ||
  target.port !== '55439' ||
  !['/workspace_control_pool_deadline_round83', '/convergence_ci15'].includes(target.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV !== 'test'
)
  throw new Error('Exact disposable Control Plane pool fixture required')
const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
let owner: PoolClient | undefined
let locked = false
const observations: Record<string, unknown>[] = []
const table = 'nexus_control_pool_deadline83'

async function until(read: () => boolean, label: string, timeout = 1000) {
  const end = Date.now() + timeout
  while (!read()) {
    if (Date.now() >= end) throw new Error(label)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
function observe<T>(pending: Promise<T>) {
  let outcome: { value?: T; error?: unknown } | undefined
  const settled = pending.then(
    (value) => (outcome = { value }),
    (error: unknown) => (outcome = { error }),
  )
  return { settled, read: () => outcome }
}
async function occupy() {
  const clients: PoolClient[] = []
  try {
    for (let i = 1; i < pool.options.max!; i++) clients.push(await pool.connect())
    expect(pool.idleCount).toBe(0)
    expect(pool.totalCount).toBe(pool.options.max)
    return clients
  } catch (error) {
    clients.forEach((client) => client.release())
    throw error
  }
}
beforeAll(async () => {
  owner = await pool.connect()
  if ((await owner.query('SELECT current_database() name')).rows[0]?.name !== target.pathname.slice(1))
    throw new Error('Control Plane pool actual database mismatch')
  locked = (
    await owner.query("SELECT pg_try_advisory_lock(hashtextextended('nexus-control-pool-deadline83',0)) locked")
  ).rows[0]?.locked
  if (!locked) throw new Error('Control Plane pool fixture already owned')
  if (
    (
      await owner.query(
        "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
      )
    ).rows[0]?.n !== 0
  )
    throw new Error('Control Plane pool fixture has other clients')
  expect((await runMigrations(pool)).total).toBe(28)
  await owner.query(`CREATE TABLE ${table} (value text PRIMARY KEY)`)
}, 30000)
afterAll(async () => {
  if (process.env.NEXUS_POOL_DEADLINE_REPORT === '1')
    console.info('Control Plane pool safe observations:', JSON.stringify(observations))
  try {
    if (owner && locked) {
      await owner.query(`DROP TABLE ${table}`)
      await owner.query("SELECT pg_advisory_unlock(hashtextextended('nexus-control-pool-deadline83',0))")
    }
  } finally {
    owner?.release()
    await pool.end()
  }
})

it('a saturated pool bounds the real health route and recovers after release', async () => {
  const clients = await occupy()
  const pending = observe(health())
  let completedBeforeRelease = false
  try {
    await until(() => pool.waitingCount === 1, 'Actual health query must wait in the pool')
    try {
      await until(() => pending.read() !== undefined, 'Health did not finish within acquisition bound', 3000)
      completedBeforeRelease = true
    } catch {
      // Release and settle OLD behavior before asserting the observed failure.
    }
    observations.push({ case: 'health', completedBeforeRelease, waitingBeforeRelease: pool.waitingCount })
  } finally {
    clients.forEach((client) => client.release())
    await pending.settled
  }
  expect(completedBeforeRelease).toBe(true)
  expect(pending.read()?.value?.status).toBe(500)
  expect(await pending.read()?.value?.json()).toEqual({ ok: false })
  expect((await health()).status).toBe(200)
  expect(pool.waitingCount).toBe(0)
})

it('a timed-out queued query never writes after a connection is released', async () => {
  const clients = await occupy()
  const pending = observe(pool.query(`INSERT INTO ${table} VALUES ('expired')`))
  let completedBeforeRelease = false
  let waitingBeforeRelease = -1
  try {
    await until(() => pool.waitingCount === 1, 'Actual INSERT must wait before dispatch')
    try {
      await until(() => pending.read() !== undefined, 'Queued INSERT did not time out', 3000)
      completedBeforeRelease = true
    } catch {
      // OLD queued work is deliberately allowed to settle only in this test database.
    }
    waitingBeforeRelease = pool.waitingCount
  } finally {
    clients.forEach((client) => client.release())
    await pending.settled
  }
  const writes = (await owner!.query(`SELECT count(*)::int n FROM ${table} WHERE value='expired'`)).rows[0]?.n
  observations.push({ case: 'queued-query', completedBeforeRelease, waitingBeforeRelease, writesAfterRelease: writes })
  expect(completedBeforeRelease).toBe(true)
  expect(pending.read()?.error).toBeInstanceOf(Error)
  expect(waitingBeforeRelease).toBe(0)
  expect(writes).toBe(0)
  expect((await pool.query('SELECT 1 n')).rows[0]?.n).toBe(1)
})

it('a timed-out explicit checkout leaves no pending or invisible client lease', async () => {
  const clients = await occupy()
  const pending = observe(pool.connect())
  let completedBeforeRelease = false
  let waitingBeforeRelease = -1
  try {
    await until(() => pool.waitingCount === 1, 'Actual checkout must wait in the pool')
    try {
      await until(() => pending.read() !== undefined, 'Queued checkout did not time out', 3000)
      completedBeforeRelease = true
    } catch {
      // Preserve OLD cleanup without losing its late-acquired client.
    }
    waitingBeforeRelease = pool.waitingCount
  } finally {
    clients.forEach((client) => client.release())
    await pending.settled
    pending.read()?.value?.release()
  }
  observations.push({
    case: 'checkout',
    completedBeforeRelease,
    waitingBeforeRelease,
    idleAfterRelease: pool.idleCount,
  })
  expect(completedBeforeRelease).toBe(true)
  expect(pending.read()?.error).toBeInstanceOf(Error)
  expect(waitingBeforeRelease).toBe(0)
  expect(pool.idleCount).toBe(pool.totalCount - 1)
})

it('control: a promptly released connection executes the queued query exactly once', async () => {
  const clients = await occupy()
  const pending = observe(pool.query(`INSERT INTO ${table} VALUES ('timely')`))
  try {
    await until(() => pool.waitingCount === 1, 'Control query must first enter the actual queue')
    clients.shift()!.release()
    await pending.settled
    expect(pending.read()?.error).toBeUndefined()
    expect(pending.read()?.value?.rowCount).toBe(1)
    expect((await owner!.query(`SELECT count(*)::int n FROM ${table} WHERE value='timely'`)).rows[0]?.n).toBe(1)
    expect(pool.waitingCount).toBe(0)
    observations.push({ case: 'timely-control', writes: 1, waiting: pool.waitingCount })
  } finally {
    clients.forEach((client) => client.release())
    await pending.settled
  }
})

it('a TCP peer stalled during PostgreSQL startup is bounded before any SQL dispatch', async () => {
  const sockets = new Set<Socket>()
  let startupBytes = 0
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('data', (bytes) => (startupBytes += bytes.length))
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected actual loopback TCP fixture')
  const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test' }
  for (const name of ['Path', 'PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE'])
    if (process.env[name] !== undefined) environment[name] = process.env[name]
  environment.DATABASE_URL = `postgresql://fixture:fixture@127.0.0.1:${address.port}/fixture`
  const script = `const imported=await import(${JSON.stringify(pathToFileURL(resolve('src/db/index.ts')).href)});const pool=imported.pool??imported.default.pool;try{await pool.query('SELECT 1');process.stdout.write('unexpected-success')}catch{process.stdout.write('bounded-failure')}finally{await pool.end()}`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (bytes) => (output += bytes.toString()))
  child.stderr.resume()
  const closed = observe(
    new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    }),
  )
  let completedWhileStalled = false
  try {
    await until(() => startupBytes > 0, 'Actual PostgreSQL startup must reach the stalled TCP peer', 2000)
    try {
      await until(() => closed.read() !== undefined, 'PostgreSQL startup did not time out', 3000)
      completedWhileStalled = true
    } catch {
      // Kill only this owned synthetic child when characterizing the OLD hang.
    }
  } finally {
    if (closed.read() === undefined) child.kill()
    sockets.forEach((socket) => socket.destroy())
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await closed.settled
  }
  observations.push({ case: 'startup', startupObserved: startupBytes > 0, completedWhileStalled, output })
  expect(completedWhileStalled).toBe(true)
  expect(closed.read()?.error).toBeUndefined()
  expect(closed.read()?.value).toBe(0)
  expect(output).toBe('bounded-failure')
}, 10000)
