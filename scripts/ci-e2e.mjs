import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import pg from 'pg'
import { runMigrations } from './db-migrate.mjs'
import { redact } from './ci-gate.mjs'
const url = new URL(process.env.CI_E2E_DATABASE_URL || '')
if (!url.pathname.startsWith('/convergence_e2e'))
  throw new Error('Explicit disposable convergence_e2e database required')
const pool = new pg.Pool({ connectionString: url.href })
try {
  await runMigrations(pool)
} finally {
  await pool.end()
}
const env = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: url.href,
  TEST_ORIGIN: 'http://127.0.0.1:3320',
  APP_BASE_URL: 'http://127.0.0.1:3320',
}
mkdirSync('.test-artifacts/ci', { recursive: true })
// App output is retained separately for fixture diagnosis; application must redact credentials itself.
let log = ''
const app = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3320'],
  { env, stdio: ['ignore', 'pipe', 'pipe'] },
)
const capture = (chunk) => {
  log = (log + chunk.toString()).slice(-8 * 1024 * 1024)
}
app.stdout.on('data', capture)
app.stderr.on('data', capture)
let startupError
app.on('error', (error) => {
  startupError = error
})
try {
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    if (startupError || app.exitCode !== null) throw new Error('E2E app failed to start')
    try {
      const response = await fetch(env.TEST_ORIGIN + '/api/health', { signal: AbortSignal.timeout(1000) })
      if (response.status < 500) {
        ready = true
        break
      }
    } catch {}
    await delay(500)
  }
  if (!ready) throw new Error('E2E app readiness timed out')
  const test =
    process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run test:e2e'], { env, stdio: 'inherit' })
      : spawn('npm', ['run', 'test:e2e'], { env, stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => {
    test.once('error', reject)
    test.once('exit', resolve)
  })
  if (code !== 0) throw new Error('Required E2E flows failed')
} finally {
  if (process.platform === 'win32')
    await new Promise((resolve) => {
      const kill = spawn('taskkill', ['/pid', String(app.pid), '/t', '/f'], { stdio: 'ignore' })
      kill.once('exit', resolve)
      kill.once('error', resolve)
    })
  else {
    app.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => app.once('exit', resolve)),
      delay(5000).then(() => app.kill('SIGKILL')),
    ])
  }
  writeFileSync('.test-artifacts/ci/e2e-server.log', redact(log, env))
}
