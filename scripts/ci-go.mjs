import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { prepareProjectGatewayFixture } from './prepare-project-gateway-fixture.mjs'
const database = new URL(process.env.GATEWAY_BUDGET_INTEGRATION_DATABASE_URL || '')
if (database.hostname !== '127.0.0.1' || database.port !== '55439' || database.pathname !== '/convergence_gateway27')
  throw new Error('Explicit Gateway service fixture required')
const env = {
  ...process.env,
  DATABASE_URL: database.href,
  BUDGET_SERVICE_TOKEN: 'convergence-budget-gateway-fixture-token',
  BUDGET_PORT: '3311',
  BUDGET_HOST: '127.0.0.1',
  NODE_ENV: 'development',
}
const children = []
function start(file) {
  const child = spawn(process.execPath, [file], { env, stdio: 'inherit' })
  children.push(child)
  return child
}
async function execute(file) {
  const child = start(file)
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0) throw new Error(`Required fixture stage failed: ${file}`)
}
async function executeGatewayGate() {
  // Execute the exact Harness command; the outer CI fixture runner is not a
  // replacement command label for gateway:check evidence.
  const child =
    process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run gateway:check'], {
          env,
          stdio: 'inherit',
          windowsHide: true,
        })
      : spawn('npm', ['run', 'gateway:check'], { env, stdio: 'inherit' })
  children.push(child)
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0) throw new Error('Required npm run gateway:check failed')
}
try {
  await prepareProjectGatewayFixture()
  start('dist/budget.cjs')
  let ready = false
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch('http://127.0.0.1:3311/readyz', {
        headers: { authorization: `Bearer ${env.BUDGET_SERVICE_TOKEN}` },
        signal: AbortSignal.timeout(1000),
      })
      if (response.ok) {
        ready = true
        break
      }
    } catch {}
    await delay(200)
  }
  if (!ready) throw new Error('Budget fixture not ready')
  await executeGatewayGate()
  start('dist/worker.cjs')
  await execute('scripts/verify-budget-worker.mjs')
} finally {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
}
