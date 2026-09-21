import { Pool } from 'pg'
import { observerSettings } from '../../src/lib/observer/configuration'
import { ObserverService } from '../../src/lib/observer/service'

let stopping = false
let wake: (() => void) | undefined
const stop = () => { stopping = true; wake?.() }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
process.once('disconnect', stop)
process.on('message', (message) => { if (message === 'stop') stop() })

async function main() {
  // No environment-file override here: a bundled worker inherits the app's exact DB.
  const settings = observerSettings()
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, max: 5 })
  pool.on('error', () => { /* The controller retries; never log raw database errors. */ })
  const service = new ObserverService(pool, settings)
  let previous = ''
  try {
    while (!stopping) {
      const state = await service.tick()
      if (state !== previous) console.log('[observer] ' + state)
      previous = state
      if (!stopping) await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000)
        wake = () => { clearTimeout(timer); resolve() }
      })
    }
  } finally {
    await service.stop().catch(() => {})
    await pool.end()
    if (process.connected) process.disconnect()
  }
}
main().catch(() => {
  console.error('[observer] startup_failed: check database and Observer environment configuration')
  process.exitCode = 1
  if (process.connected) process.disconnect()
})
