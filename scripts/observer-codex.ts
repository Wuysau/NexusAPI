import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import {
  configureObserver,
  enrichCodexSessions,
  reattributeUnassigned,
  scanCodex,
  validateObserverConfig,
} from '../src/lib/observer/importer'
import { PARSER_VERSION } from '../src/lib/observer/codex'
import { observerSettings } from '../src/lib/observer/configuration'
import { ObserverCliError, observerDiagnostic, type ObserverStage } from '../src/lib/observer/diagnostics'

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2)
  if (command === 'help' || command === '--help') {
    console.log(
      'Observer ' +
        PARSER_VERSION +
        '\nUsage: npm run observer:codex -- <configure|scan|enrich-sessions|reattribute|reset-cursors|delete-observations> [--config <nonsecret.json>] [--dry-run] [--confirm-scope <tenantId>/<organizationId>]\nConfig: --config > CODEX_OBSERVER_CONFIG_PATH > config/nexus-observer.json.\nDatabase: shell DATABASE_URL > .env.observer.local > .env.local. Use the same database as the workspace UI. Never add credentials to the JSON config.',
    )
  } else {
    let pool: Pool | undefined
    let stage: ObserverStage = 'arguments'
    try {
      if (
        !['configure', 'scan', 'enrich-sessions', 'reattribute', 'reset-cursors', 'delete-observations'].includes(
          command,
        )
      )
        throw new Error('Invalid command')
      const options = new Map<string, string | boolean>()
      for (let i = 0; i < args.length; i++) {
        const key = args[i]
        if (!['--config', '--dry-run', '--confirm-scope'].includes(key) || options.has(key))
          throw new Error('Invalid arguments')
        if (key !== '--dry-run' && (!args[i + 1] || args[i + 1].startsWith('--')))
          throw new ObserverCliError('invalid_arguments')
        options.set(key, key === '--dry-run' ? true : args[++i])
      }
      const configPath =
        typeof options.get('--config') === 'string' ? String(options.get('--config')) : observerSettings().configPath
      if (!process.env.DATABASE_URL) throw new ObserverCliError('database_missing')
      if (options.has('--dry-run') && command !== 'scan') throw new Error('Dry-run supported for scan only')
      stage = 'config_read'
      const contents = await readFile(configPath, 'utf8')
      stage = 'config_json'
      const parsed: unknown = JSON.parse(contents.replace(/^\uFEFF/, ''))
      stage = 'config_validate'
      const config = validateObserverConfig(parsed)
      stage = 'database'
      pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 })
      await pool.query('SELECT 1')
      stage = 'operation'
      if (command === 'scan')
        console.log(JSON.stringify(await scanCodex(pool, config, { dryRun: options.has('--dry-run') })))
      else if (command === 'enrich-sessions') console.log(JSON.stringify(await enrichCodexSessions(pool, config)))
      else if (command === 'configure') {
        await configureObserver(pool, config)
        console.log('Workspace roots and non-routable subscription mappings configured.')
      } else if (command === 'reattribute')
        console.log(JSON.stringify({ attributedEvents: await reattributeUnassigned(pool, config) }))
      else {
        if (options.get('--confirm-scope') !== `${config.tenantId}/${config.organizationId}`)
          throw new ObserverCliError('invalid_arguments')
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
            `observer:${config.tenantId}:${config.organizationId}`,
          ])
          if (command === 'delete-observations')
            await client.query(
              'DELETE FROM external_observed_usage WHERE tenant_id=$1 AND organization_id=$2 AND usage_source=$3',
              [config.tenantId, config.organizationId, 'codex_local'],
            )
          await client.query('DELETE FROM observer_scan_cursors WHERE tenant_id=$1 AND organization_id=$2', [
            config.tenantId,
            config.organizationId,
          ])
          await client.query('COMMIT')
          console.log('Scoped observer operation completed.')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally {
          client.release()
        }
      }
    } catch (error) {
      // Never stringify parser/DB/config errors: they can contain local input values.
      console.error(observerDiagnostic(error, stage))
      process.exitCode = 1
    } finally {
      await pool?.end()
    }
  }
}
void main()
