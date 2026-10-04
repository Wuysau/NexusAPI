import { spawn } from 'node:child_process'
import { connect, createServer, type Socket } from 'node:net'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'

const supplied = process.env.DATABASE_URL
if (!supplied) throw new Error('Explicit disposable health query database required')
const database = new URL(supplied)
if (
  !['postgres:', 'postgresql:'].includes(database.protocol) ||
  database.hostname !== '127.0.0.1' ||
  database.port !== '55439' ||
  !['/workspace_control_health_query_round89', '/convergence_ci15'].includes(database.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV !== 'test'
)
  throw new Error('Exact disposable health query fixture required')
const app = `nexus-health-query89-test-${process.pid}`
let owner: Client | undefined
let locked = false
const observations: Record<string, unknown>[] = []
const cleanupObservations: Record<string, unknown>[] = []
const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
async function until(read: () => boolean | Promise<boolean>, label: string, milliseconds = 4000) {
  const end = Date.now() + milliseconds
  while (!(await read())) {
    if (Date.now() >= end) throw new Error(label)
    await pause(10)
  }
}
async function backends() {
  return (
    await owner!.query<{ pid: number; state: string }>(
      'SELECT pid,state FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1',
      [app],
    )
  ).rows
}
beforeAll(async () => {
  owner = new Client({
    connectionString: supplied,
    application_name: 'nexus-health-query89-test-owner',
    connectionTimeoutMillis: 4000,
    statement_timeout: 8000,
  })
  await owner.connect()
  if ((await owner.query('SELECT current_database() name')).rows[0]?.name !== database.pathname.slice(1))
    throw new Error('Health query actual database mismatch')
  locked = (await owner.query("SELECT pg_try_advisory_lock(hashtextextended('nexus-control-health-query89',0)) locked"))
    .rows[0]?.locked
  if (!locked) throw new Error('Health query fixture already owned')
  if (
    (
      await owner.query(
        "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
      )
    ).rows[0]?.n !== 0
  )
    throw new Error('Health query fixture has another client')
  await owner.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const migrationModule = pathToFileURL(resolve('scripts/db-migrate.mjs')).href
  const { runMigrations } = await import(migrationModule)
  const migrations = new Pool({
    connectionString: supplied,
    application_name: 'nexus-health-query89-test-migrations',
    max: 1,
    connectionTimeoutMillis: 4000,
    statement_timeout: 30000,
  })
  try {
    expect((await runMigrations(migrations)).total).toBe(28)
  } finally {
    await migrations.end()
  }
}, 30000)
afterAll(async () => {
  if (process.env.NEXUS_HEALTH_QUERY_REPORT === '1')
    console.info('Health query safe observations:', JSON.stringify({ observations, cleanup: cleanupObservations }))
  try {
    if (owner && locked) {
      expect(
        (
          await owner.query(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
          )
        ).rows[0]?.n,
      ).toBe(0)
    }
    for (const cleanup of cleanupObservations)
      expect(cleanup).toEqual({ childExit: 0, forced: false, sockets: 0, backends: 0, clean: true })
  } finally {
    try {
      if (owner && locked)
        await owner.query("SELECT pg_advisory_unlock(hashtextextended('nexus-control-health-query89',0))")
    } finally {
      await owner?.end()
    }
  }
})

type Pair = {
  downstream: Socket
  upstream: Socket
  startup: boolean
  buffer: Buffer
  hold: boolean
  held: Buffer[]
  heldBytes: number
  healthQueries: number
  ordinaryQueries: number
  heldAt: number
}
type Fact = {
  phase: string
  status?: number
  ok?: boolean
  value?: number
  pid?: number
  database?: string
  elapsedMs?: number
  completed?: boolean
  pool: { total: number; idle: number; waiting: number }
}

async function fixture() {
  const active = new Set<Pair>(),
    all: Pair[] = []
  let framingFailed = false
  const release = (pair: Pair) => {
    pair.hold = false
    for (const bytes of pair.held) if (!pair.downstream.destroyed) pair.downstream.write(bytes)
    pair.held = []
  }
  const inspectFrames = (pair: Pair, bytes: Buffer) => {
    pair.buffer = Buffer.concat([pair.buffer, bytes])
    if (pair.buffer.length > 65536) throw new Error('Bounded query fixture framing overflow')
    if (!pair.startup) {
      if (pair.buffer.length < 4) return
      const length = pair.buffer.readUInt32BE(0)
      if (length < 8 || length > 65536) throw new Error('Unexpected startup frame')
      if (pair.buffer.length < length) return
      pair.buffer = pair.buffer.subarray(length)
      pair.startup = true
    }
    while (pair.buffer.length >= 5) {
      const length = pair.buffer.readUInt32BE(1)
      if (length < 4 || length > 65536) throw new Error('Unexpected query frame')
      if (pair.buffer.length < length + 1) return
      if (pair.buffer[0] === 81) {
        const text = pair.buffer.subarray(5, length + 1)
        if (text.equals(Buffer.from('select 1\0'))) pair.healthQueries++
        if (text.equals(Buffer.from('select 2 n\0'))) pair.ordinaryQueries++
        if (pair.hold) pair.heldAt = Date.now()
      }
      pair.buffer = pair.buffer.subarray(length + 1)
    }
  }
  // Every wire byte is forwarded unchanged; only delivery of an owned response is delayed.
  const server = createServer((downstream) => {
    const upstream = connect({ host: '127.0.0.1', port: 55439 })
    const pair: Pair = {
      downstream,
      upstream,
      startup: false,
      buffer: Buffer.alloc(0),
      hold: false,
      held: [],
      heldBytes: 0,
      healthQueries: 0,
      ordinaryQueries: 0,
      heldAt: 0,
    }
    active.add(pair)
    all.push(pair)
    downstream.on('data', (bytes) => {
      try {
        inspectFrames(pair, bytes)
      } catch {
        framingFailed = true
        downstream.destroy()
        upstream.destroy()
        return
      }
      if (!upstream.write(bytes)) downstream.pause()
    })
    upstream.on('drain', () => downstream.resume())
    upstream.on('data', (bytes) => {
      if (pair.hold) {
        pair.heldBytes += bytes.length
        if (pair.heldBytes > 65536) {
          framingFailed = true
          downstream.destroy()
          upstream.destroy()
          return
        }
        pair.held.push(bytes)
      } else if (!downstream.write(bytes)) upstream.pause()
    })
    downstream.on('drain', () => upstream.resume())
    downstream.on('error', () => upstream.destroy())
    upstream.on('error', () => downstream.destroy())
    downstream.on('close', () => {
      upstream.destroy()
      active.delete(pair)
    })
    upstream.on('close', () => downstream.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const url = new URL(database)
  url.port = String((server.address() as { port: number }).port)
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: url.href, PGAPPNAME: app }
  for (const name of ['Path', 'PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'COMSPEC', 'ComSpec', 'PATHEXT'])
    if (process.env[name] !== undefined) env[name] = process.env[name]
  const script = `const dbm=await import(${JSON.stringify(pathToFileURL(resolve('src/db/index.ts')).href)});const hm=await import(${JSON.stringify(pathToFileURL(resolve('src/app/api/health/route.ts')).href)});const pool=dbm.pool??dbm.default.pool;const GET=hm.GET??hm.default.GET;const report=x=>process.stdout.write(JSON.stringify(x)+String.fromCharCode(10));const stats=()=>({total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount});const warm=await GET();const identity=(await pool.query('SELECT pg_backend_pid() pid,current_database() name')).rows[0];report({phase:'warm',status:warm.status,ok:(await warm.json()).ok,pid:identity.pid,database:identity.name,pool:stats()});const {createInterface}=await import('node:readline');const input=createInterface({input:process.stdin,crlfDelay:Infinity});let pending,completed=false;input.on('line',command=>{if(command==='health'||command==='ordinary'){completed=false;const started=Date.now();pending=(async()=>{if(command==='health'){const r=await GET();report({phase:'health',status:r.status,ok:(await r.json()).ok,elapsedMs:Date.now()-started,pool:stats()})}else{const r=await pool.query('select 2 n');report({phase:'ordinary',value:r.rows[0].n,elapsedMs:Date.now()-started,pool:stats()})}completed=true})().catch(()=>{completed=true;report({phase:'unexpected-error',pool:stats()})})}else if(command==='inspect'){report({phase:'inspected',completed,pool:stats()})}else if(command==='finish'){void(async()=>{await pending;await pool.end();input.close();process.stdin.destroy()})().catch(()=>{process.exitCode=1;input.close();process.stdin.destroy()})}});`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const facts: Fact[] = []
  let partial = '',
    stderrBytes = 0,
    invalidOutput = false,
    exit: number | null | undefined
  child.stdout.on('data', (bytes) => {
    partial += bytes.toString()
    let newline
    while ((newline = partial.indexOf('\n')) >= 0) {
      const line = partial.slice(0, newline)
      partial = partial.slice(newline + 1)
      try {
        facts.push(JSON.parse(line))
      } catch {
        invalidOutput = true
      }
    }
  })
  child.stderr.on('data', (bytes) => {
    stderrBytes += bytes.length
  })
  child.stdin.on('error', () => {})
  child.on('error', () => {
    invalidOutput = true
  })
  const closed = new Promise<void>((resolve) =>
    child.once('close', (code) => {
      exit = code
      resolve()
    }),
  )
  const cleanup = async () => {
    let forced = false
    for (const pair of active) release(pair)
    if (exit === undefined) child.stdin.write('finish\n')
    try {
      await until(() => exit !== undefined, 'Owned health child did not finish', 2500)
    } catch {
      forced = true
      child.kill()
    }
    await closed
    for (const pair of active) {
      pair.downstream.destroy()
      pair.upstream.destroy()
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await until(
      async () => active.size === 0 && (await backends()).length === 0,
      'Owned health query sockets and backends did not close',
    )
    cleanupObservations.push({
      childExit: exit,
      forced,
      sockets: active.size,
      backends: (await backends()).length,
      clean: !framingFailed && !invalidOutput && stderrBytes === 0 && partial.length === 0,
    })
  }
  try {
    await until(
      () => facts.some((fact) => fact.phase === 'warm') || exit !== undefined,
      'Actual health child did not warm',
    )
    const warm = facts.find((fact) => fact.phase === 'warm')!
    expect(exit).toBeUndefined()
    expect(warm.status).toBe(200)
    expect(warm.ok).toBe(true)
    expect(warm.database).toBe(database.pathname.slice(1))
    expect(warm.pool).toEqual({ total: 1, idle: 1, waiting: 0 })
    expect(all.length).toBe(1)
    expect((await backends()).map((row) => row.pid)).toEqual([warm.pid])
    expect(all[0].healthQueries).toBe(1)
    return {
      all,
      facts,
      warm,
      release,
      cleanup,
      send: (command: string) => child.stdin.write(command + '\n'),
      clean: () => !framingFailed && !invalidOutput && stderrBytes === 0 && exit === undefined,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

it('a withheld established health response returns its fixed failure and removes the client before a new explicit healthy request', async () => {
  const f = await fixture(),
    pair = f.all[0]
  let completedBeforeRelease = false
  try {
    pair.hold = true
    f.send('health')
    await until(
      () => pair.healthQueries === 2 && pair.heldBytes > 0,
      'Real health SQL/response did not cross the proxy',
    )
    try {
      await until(
        () => f.facts.some((fact) => fact.phase === 'health'),
        'Health response exceeded its read budget',
        3200,
      )
      completedBeforeRelease = true
    } catch {
      /* Settle OLD safely before its expected failing assertion. */
    }
    if (completedBeforeRelease) {
      const failed = f.facts.find((fact) => fact.phase === 'health')!
      expect(failed.status).toBe(500)
      expect(failed.ok).toBe(false)
      expect(failed.elapsedMs).toBeGreaterThanOrEqual(1500)
      expect(failed.elapsedMs).toBeLessThan(3200)
      expect(failed.pool).toEqual({ total: 0, idle: 0, waiting: 0 })
      await until(
        async () => pair.downstream.destroyed && pair.upstream.destroyed && (await backends()).length === 0,
        'Timed-out health connection was not discarded',
      )
      expect(f.all.length).toBe(1)
      expect(pair.healthQueries).toBe(2)
      f.send('health')
      await until(
        () => f.facts.filter((fact) => fact.phase === 'health').length === 2,
        'Explicit healthy recovery did not finish',
      )
      const recovered = f.facts.filter((fact) => fact.phase === 'health')[1]
      expect(recovered.status).toBe(200)
      expect(recovered.ok).toBe(true)
      expect(f.all.length).toBe(2)
      expect((await backends())[0].pid).not.toBe(f.warm.pid)
      expect(f.all.reduce((sum, connection) => sum + connection.healthQueries, 0)).toBe(3)
    } else {
      f.release(pair)
      await until(
        () => f.facts.some((fact) => fact.phase === 'health'),
        'OLD health failed to settle after releasing its response',
      )
      expect(f.facts.find((fact) => fact.phase === 'health')!.status).toBe(200)
    }
    observations.push({
      case: 'health-read-bound',
      completedBeforeRelease,
      healthQueries: f.all.reduce((sum, connection) => sum + connection.healthQueries, 0),
    })
    expect(f.clean()).toBe(true)
  } finally {
    await f.cleanup()
  }
  expect(completedBeforeRelease).toBe(true)
}, 15000)

it('a timely established health response remains successful on its existing backend', async () => {
  const f = await fixture(),
    pair = f.all[0]
  try {
    pair.hold = true
    f.send('health')
    await until(() => pair.healthQueries === 2 && pair.heldBytes > 0, 'Timely health response was not observed')
    await pause(100)
    f.release(pair)
    await until(() => f.facts.some((fact) => fact.phase === 'health'), 'Timely health did not settle')
    const result = f.facts.find((fact) => fact.phase === 'health')!
    expect(result.status).toBe(200)
    expect(result.ok).toBe(true)
    expect(result.pool).toEqual({ total: 1, idle: 1, waiting: 0 })
    expect(f.all.length).toBe(1)
    expect((await backends())[0].pid).toBe(f.warm.pid)
    expect(f.clean()).toBe(true)
    observations.push({ case: 'timely-health', status: result.status, connections: f.all.length })
  } finally {
    await f.cleanup()
  }
}, 15000)

it('the health deadline does not impose a global timeout on an ordinary read-only query', async () => {
  const f = await fixture(),
    pair = f.all[0]
  try {
    pair.hold = true
    f.send('ordinary')
    await until(
      () => pair.ordinaryQueries === 1 && pair.heldBytes > 0,
      'Actual ordinary read response was not observed',
    )
    await pause(2400)
    f.send('inspect')
    await until(() => f.facts.some((fact) => fact.phase === 'inspected'), 'Ordinary query ownership was not reported')
    const inspected = f.facts.find((fact) => fact.phase === 'inspected')!
    const stillPending =
      !inspected.completed && !f.facts.some((fact) => fact.phase === 'ordinary' || fact.phase === 'unexpected-error')
    f.release(pair)
    await until(
      () => f.facts.some((fact) => fact.phase === 'ordinary' || fact.phase === 'unexpected-error'),
      'Ordinary read did not settle after release',
    )
    const result = f.facts.find((fact) => fact.phase === 'ordinary')
    expect(stillPending).toBe(true)
    expect(inspected.pool).toEqual({ total: 1, idle: 0, waiting: 0 })
    expect(result?.value).toBe(2)
    expect(result?.elapsedMs).toBeGreaterThan(2200)
    expect(f.all.length).toBe(1)
    expect((await backends())[0].pid).toBe(f.warm.pid)
    expect(pair.ordinaryQueries).toBe(1)
    expect(f.clean()).toBe(true)
    observations.push({ case: 'ordinary-query-scope', stillPending, value: result?.value, connections: f.all.length })
  } finally {
    await f.cleanup()
  }
}, 15000)
