import path from 'node:path'
import { lstat } from 'node:fs/promises'
import type { Pool } from 'pg'
import { scanCodex } from '../observer/importer'
import type { AgentConfig } from './configuration'

/** Reuse the same parser, cursor and cross-process lock for supervised profile telemetry. */
export async function observeProfiles(pool: Pool, config: AgentConfig) {
  const sources: string[] = []
  for (const profile of config.profiles) {
    for (const directory of ['sessions', 'archived_sessions']) {
      const source = path.join(profile.home, directory)
      if ((await lstat(source).catch(() => null))?.isDirectory()) sources.push(source)
    }
  }
  if (!sources.length) return
  await scanCodex(pool, {
    tenantId: config.tenantId,
    organizationId: config.organizationId,
    sources,
    roots: config.workspaces.map((w) => ({ root: w.cwd, projectId: w.projectId })),
    providers: [],
  })
}
