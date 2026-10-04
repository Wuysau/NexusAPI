import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { pool } from '@/db'

const supplied = process.env.DATABASE_URL
if (!supplied) throw new Error('Explicit disposable idle recovery database required')
const target = new URL(supplied)
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  target.hostname !== '127.0.0.1' ||
  target.port !== '55439' ||
  !['/workspace_control_idle_recovery_round84', '/convergence_ci15'].includes(target.pathname) ||
  supplied.includes('?') ||
  supplied.includes('#') ||
  process.env.NODE_ENV !== 'test'
)
  throw new Error('Exact disposable idle recovery fixture required')
const migrationPath = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(migrationPath)
let owner: PoolClient | undefined
let locked = false
let tableCreated = false
const observations: Record<string, unknown>[] = []
const table = 'nexus_control_idle_recovery84'
async function until(read: () => boolean, label: string, timeout = 3000) {
  const end = Date.now() + timeout
  while (!read()) {
    if (Date.now() >= end) throw new Error(label)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
beforeAll(async () => {
  owner = await pool.connect()
  if ((await owner.query('SELECT current_database() name')).rows[0]?.name !== target.pathname.slice(1))
    throw new Error('Idle recovery actual database mismatch')
  locked = (
    await owner.query("SELECT pg_try_advisory_lock(hashtextextended('nexus-control-idle-recovery84',0)) locked")
  ).rows[0]?.locked
  if (!locked) throw new Error('Idle recovery fixture already owned')
  if (
    (
      await owner.query(
        "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
      )
    ).rows[0]?.n !== 0
  )
    throw new Error('Idle recovery fixture has other clients')
  expect((await runMigrations(pool)).total).toBe(28)
  await owner.query(`CREATE TABLE ${table} (value text PRIMARY KEY)`)
  tableCreated = true
}, 30000)
afterAll(async () => {
  if (process.env.NEXUS_IDLE_RECOVERY_REPORT === '1')
    console.info('Control Plane idle recovery safe observations:', JSON.stringify(observations))
  try {
    if (owner && locked) {
      try {
        if (tableCreated) await owner.query(`DROP TABLE ${table}`)
      } finally {
        await owner.query("SELECT pg_advisory_unlock(hashtextextended('nexus-control-idle-recovery84',0))")
      }
    }
  } finally {
    owner?.release()
    await pool.end()
  }
})
function childProgram(body: string) {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    DATABASE_URL: supplied,
    PGAPPNAME: 'nexus-idle-recovery84-child',
  }
  for (const name of ['Path', 'PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE'])
    if (process.env[name] !== undefined) environment[name] = process.env[name]
  const script = `const imported=await import(${JSON.stringify(pathToFileURL(resolve('src/db/index.ts')).href)});const pool=imported.pool??imported.default.pool;const report=(value)=>process.stdout.write(JSON.stringify(value)+String.fromCharCode(10));${body}`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    env: environment,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = '',
    stderr = '',
    exit: number | null | undefined
  const lines: Record<string, unknown>[] = []
  child.stdout.on('data', (bytes) => {
    output += bytes.toString()
    let end
    while ((end = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, end)
      output = output.slice(end + 1)
      try {
        lines.push(JSON.parse(line))
      } catch {
        throw new Error('Child emitted non-JSON output')
      }
    }
  })
  child.stderr.on('data', (bytes) => {
    stderr += bytes.toString()
  })
  child.stdin.on('error', () => {})
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      exit = code
      resolve()
    })
  })
  return {
    child,
    closed,
    lines,
    exit: () => exit,
    stderr: () => stderr,
    async cleanup() {
      if (exit === undefined) child.kill()
      await closed
    },
  }
}
it('an idle backend loss preserves the process and allows a new explicit query without replay', async () => {
  const c = childProgram(
    `const resume=new Promise(resolve=>process.stdin.once('data',resolve));const client=await pool.connect();const pid=(await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;await client.query("INSERT INTO ${table} VALUES ('completed')");client.release();report({phase:'idle',pid});await resume;const replacement=(await pool.query('SELECT pg_backend_pid() pid')).rows[0].pid;report({phase:'recovered',replacement,listeners:pool.listenerCount('error')});await pool.end();process.stdin.destroy();`,
  )
  let stayedAlive = false
  try {
    await until(() => c.lines.some((line) => line.phase === 'idle'), 'Actual child must become idle before termination')
    const pid = c.lines.find((line) => line.phase === 'idle')!.pid
    expect(Number.isInteger(pid)).toBe(true)
    const backend = await owner!.query(
      "SELECT pid,state FROM pg_stat_activity WHERE datname=current_database() AND pid=$1 AND application_name='nexus-idle-recovery84-child'",
      [pid],
    )
    expect(backend.rows).toEqual([{ pid, state: 'idle' }])
    const killed = await owner!.query(
      "SELECT pg_terminate_backend(pid) killed FROM pg_stat_activity WHERE datname=current_database() AND pid=$1 AND application_name='nexus-idle-recovery84-child'",
      [pid],
    )
    expect(killed.rows).toEqual([{ killed: true }])
    await until(
      () => c.exit() !== undefined || c.lines.some((line) => line.error_kind === 'database_idle_connection_lost'),
      'Child must observe actual backend loss',
    )
    stayedAlive = c.exit() === undefined
    if (stayedAlive) {
      c.child.stdin.write('explicit-next-query\n')
      await until(() => c.exit() !== undefined, 'Recovered owned child must exit')
    }
    const writes = (await owner!.query(`SELECT count(*)::int n FROM ${table} WHERE value='completed'`)).rows[0]?.n
    observations.push({ case: 'actual-idle-loss', stayedAlive, exit: c.exit(), writes })
    expect(stayedAlive).toBe(true)
    expect(c.exit()).toBe(0)
    expect(c.lines.filter((line) => line.error_kind === 'database_idle_connection_lost')).toHaveLength(1)
    expect(c.lines.find((line) => line.phase === 'recovered')?.replacement).not.toBe(pid)
    expect(c.lines.find((line) => line.phase === 'recovered')?.listeners).toBe(1)
    expect(writes).toBe(1)
    expect(c.stderr()).toBe('')
  } finally {
    await c.cleanup()
  }
}, 10000)
it('idle error diagnostics omit raw error text, credentials, SQL and client objects', async () => {
  const c = childProgram(
    `await pool.query('SELECT 1');pool.emit('error',Object.assign(new Error('private-error-sentinel84'),{connectionString:'private-credential-sentinel84',query:'private-sql-sentinel84',client:{secret:'fixture-private-client-sentinel84'}}));report({phase:'continued'});await pool.end();`,
  )
  try {
    await until(() => c.exit() !== undefined, 'Synthetic diagnostic child must settle')
    const serialized = JSON.stringify(c.lines) + c.stderr()
    const leaked = [
      'private-error-sentinel84',
      'private-credential-sentinel84',
      'private-sql-sentinel84',
      'fixture-private-client-sentinel84',
    ].some((value) => serialized.includes(value))
    observations.push({ case: 'diagnostic-boundary', exit: c.exit(), leaked })
    expect(c.exit()).toBe(0)
    expect(leaked).toBe(false)
    expect(c.lines.filter((line) => line.error_kind === 'database_idle_connection_lost')).toHaveLength(1)
    expect(c.lines.some((line) => line.phase === 'continued')).toBe(true)
    expect(c.stderr()).toBe('')
  } finally {
    await c.cleanup()
  }
}, 10000)
it('control: an ordinary SQL error still rejects and a subsequent explicit query works', async () => {
  const c = childProgram(
    `let code;try{await pool.query("INSERT INTO ${table}(missing_column) VALUES ('bad')")}catch(error){code=error.code}report({phase:'sql-error',code});report({phase:'healthy',value:(await pool.query('SELECT 1 n')).rows[0].n});await pool.end();`,
  )
  try {
    await until(() => c.exit() !== undefined, 'SQL error control child must settle')
    expect(c.exit()).toBe(0)
    expect(c.lines.find((line) => line.phase === 'sql-error')?.code).toBe('42703')
    expect(c.lines.find((line) => line.phase === 'healthy')?.value).toBe(1)
    expect(c.lines.filter((line) => line.error_kind === 'database_idle_connection_lost')).toHaveLength(0)
    expect((await owner!.query(`SELECT count(*)::int n FROM ${table} WHERE value='bad'`)).rows[0]?.n).toBe(0)
    observations.push({ case: 'sql-error-control', rejects: true, healthy: true, writes: 0 })
  } finally {
    await c.cleanup()
  }
}, 10000)

it('control: an in-flight query still fails on backend loss without an implicit retry', async () => {
  const c = childProgram(
    `const client=await pool.connect();const pid=(await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;report({phase:'active',pid});let code;try{await client.query("INSERT INTO ${table} SELECT 'interrupted' FROM pg_sleep(20)")}catch(error){code=error.code}finally{client.release(true)}report({phase:'query-error',code});report({phase:'healthy',value:(await pool.query('SELECT 1 n')).rows[0].n});await pool.end();`,
  )
  try {
    await until(() => c.lines.some((line) => line.phase === 'active'), 'Child must begin an explicit checkout')
    const pid = c.lines.find((line) => line.phase === 'active')!.pid
    expect(Number.isInteger(pid)).toBe(true)
    let sleeping = false
    const deadline = Date.now() + 3000
    while (!sleeping && Date.now() < deadline) {
      const rows = await owner!.query(
        "SELECT state,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid=$1 AND application_name='nexus-idle-recovery84-child'",
        [pid],
      )
      sleeping = rows.rows[0]?.state === 'active' && rows.rows[0]?.wait_event === 'PgSleep'
      if (!sleeping) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(sleeping).toBe(true)
    expect(
      (
        await owner!.query(
          "SELECT pg_terminate_backend(pid) killed FROM pg_stat_activity WHERE datname=current_database() AND pid=$1 AND application_name='nexus-idle-recovery84-child'",
          [pid],
        )
      ).rows,
    ).toEqual([{ killed: true }])
    await until(() => c.exit() !== undefined, 'Interrupted query child must settle')
    expect(c.exit()).toBe(0)
    expect(c.lines.find((line) => line.phase === 'query-error')?.code).toBe('57P01')
    expect(c.lines.find((line) => line.phase === 'healthy')?.value).toBe(1)
    expect(c.lines.filter((line) => line.error_kind === 'database_idle_connection_lost')).toHaveLength(0)
    expect((await owner!.query(`SELECT count(*)::int n FROM ${table} WHERE value='interrupted'`)).rows[0]?.n).toBe(0)
    expect(c.stderr()).toBe('')
  } finally {
    await c.cleanup()
  }
}, 10000)

it('development module reloads reuse the cached pool without accumulating error listeners', async () => {
  const source = JSON.stringify(resolve('src/db/index.ts'))
  const c = childProgram(
    `const {createRequire}=await import('node:module');const load=createRequire(${JSON.stringify(pathToFileURL(resolve('package.json')).href)});for(let i=0;i<3;i++){delete load.cache[load.resolve(${source})];const again=load(${source});report({phase:'reload',samePool:again.pool===pool,listeners:again.pool.listenerCount('error')})}await pool.query('SELECT 1');await pool.end();`,
  )
  try {
    await until(() => c.exit() !== undefined, 'Module reload child must settle')
    expect(c.exit()).toBe(0)
    expect(c.lines).toEqual(Array.from({ length: 3 }, () => ({ phase: 'reload', samePool: true, listeners: 1 })))
    expect(c.stderr()).toBe('')
  } finally {
    await c.cleanup()
  }
}, 10000)
