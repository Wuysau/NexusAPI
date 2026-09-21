import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { validateObserverConfig, type ObserverConfig } from './importer'

export class ObserverConfigurationError extends Error {
  constructor() {
    super('invalid_configuration')
  }
}
export function observerSettings(env: Record<string, string | undefined> = process.env, cwd = process.cwd()) {
  const interval = Number(env.CODEX_OBSERVER_INTERVAL_SECONDS ?? 60)
  if (
    !Number.isInteger(interval) ||
    interval < 1 ||
    interval > 86400 ||
    (env.CODEX_OBSERVER_ENABLED !== undefined && !['true', 'false'].includes(env.CODEX_OBSERVER_ENABLED))
  )
    throw new ObserverConfigurationError()
  const configPath = path.resolve(cwd, env.CODEX_OBSERVER_CONFIG_PATH || 'config/nexus-observer.json')
  const identity = process.platform === 'win32' ? configPath.replace(/\\/g, '/').toLowerCase() : configPath
  return {
    enabled: env.CODEX_OBSERVER_ENABLED !== 'false',
    intervalSeconds: interval,
    configPath,
    instanceId: createHash('sha256')
      .update(hostname() + ':' + identity)
      .digest('hex'),
  }
}
export type ObserverSettings = ReturnType<typeof observerSettings>

export async function readActiveObserverConfig(settings: ObserverSettings): Promise<ObserverConfig | null> {
  try {
    const stat = await lstat(settings.configPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new ObserverConfigurationError()
    return validateObserverConfig(JSON.parse((await readFile(settings.configPath, 'utf8')).replace(/^\uFEFF/, '')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new ObserverConfigurationError()
  }
}

/** Call only after scoped authorization; the path is server-owned, never supplied by HTTP. */
export async function saveActiveObserverConfig(settings: ObserverSettings, config: ObserverConfig) {
  const contents = JSON.stringify(validateObserverConfig(config), null, 2) + '\n'
  await mkdir(path.dirname(settings.configPath), { recursive: true })
  const temporary = settings.configPath + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 })
    await rename(temporary, settings.configPath)
  } finally {
    await rm(temporary, { force: true })
  }
}
