import { existsSync } from 'node:fs'
import { startLocalServices } from './local-services.mjs'

if (process.platform !== 'win32')
  throw new Error('Local desktop path selection requires Windows; use npm run dev otherwise.')
if (existsSync('.env.local')) process.loadEnvFile('.env.local')
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1])))
  throw new Error('Usage: npm run dev:local -- [--port 3000]')
const port = Number(args[1] ?? 3000)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535')
startLocalServices(['dev', '--hostname', '127.0.0.1', '--port', String(port)], {
  ...process.env,
  NEXUS_DESKTOP_ORIGIN: 'http://127.0.0.1:' + port,
})
