// Companion to the local Web/Observer launcher. No seed, migration or credential output.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
if (process.env.NODE_ENV === 'production' || process.env.GATEWAY_ENV === 'production')
  throw new Error('Local gateway launcher is not a production entry point')
for (const file of ['.env.local', '.env.observer.local'])
  if (existsSync(resolve(root, file))) process.loadEnvFile(resolve(root, file))
if (process.env.NODE_ENV === 'production' || process.env.GATEWAY_ENV === 'production')
  throw new Error('Local gateway launcher is not a production entry point')
for (const variable of ['DATABASE_URL', 'SNAPSHOT_SIGNING_KEY', 'GATEWAY_INTERNAL_TOKEN'])
  if (!process.env[variable]) throw new Error(`Missing ${variable}; use the same local environment as the console`)
const directory = resolve(process.env.NEXUS_LOCAL_CREDENTIAL_DIR || join(homedir(), '.nexusapi', 'credentials'))
if (!existsSync(join(directory, 'master.key'))) throw new Error('Save a local channel API Key in the console first')
const artifacts = resolve(root, '.test-artifacts')
mkdirSync(artifacts, { recursive: true })
const binary = join(artifacts, process.platform === 'win32' ? 'nexus-gateway-local.exe' : 'nexus-gateway-local')
const built = spawnSync('go', ['build', '-o', binary, '.'], {
  cwd: resolve(root, 'services/gateway'),
  stdio: 'inherit',
  windowsHide: true,
})
if (built.status !== 0) throw new Error('Gateway build failed')
const env = {
  ...process.env,
  GATEWAY_ENV: 'development',
  GATEWAY_ADDR: process.env.GATEWAY_ADDR || '127.0.0.1:8080',
  CONTROL_PLANE_URL: process.env.CONTROL_PLANE_URL || process.env.NEXUS_DESKTOP_ORIGIN || 'http://127.0.0.1:3000',
  NEXUS_LOCAL_CREDENTIAL_DIR: directory,
  GATEWAY_SNAPSHOT_REFRESH_SECONDS: '5',
  WORKER_POLL_INTERVAL_MS: '1000',
  WORKER_HEARTBEAT_FILE: join(artifacts, 'local-gateway-worker-heartbeat.json'),
  GATEWAY_OTEL_DISABLED: 'true',
}
const worker = spawn(process.execPath, ['--import', 'tsx', 'services/worker/index.ts'], {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: true,
})
const gateway = spawn(binary, [], { cwd: root, env, stdio: 'inherit', windowsHide: true })
let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  worker.kill()
  gateway.kill()
}
for (const child of [worker, gateway]) {
  child.on('error', () => {
    process.exitCode = 1
    stop()
  })
  child.on('exit', (code) => {
    if (!stopping) {
      process.exitCode = code || 1
      stop()
    }
  })
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
console.log('[local gateway] Gateway and usage Worker started; Web/Observer remain in their existing process')
