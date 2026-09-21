import { createHash } from 'node:crypto'
import { lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { CodexParser, PARSER_VERSION } from './codex'
import { matchWorkspace, normalizeWorkspace, type WorkspaceRoot } from './workspace'
import { readJsonl } from './stream'
import { readSessionMetadata, enrichSessionMetadata } from './session-metadata'

export interface ObserverScope {
  tenantId: string
  organizationId: string
}
export interface ObserverConfig extends ObserverScope {
  sources: string[]
  roots: Array<{ root: string; projectId: string }>
  providers: Array<{ identifier: string; provider: string; product: string; connectionId: string }>
}
export function validateObserverConfig(value: unknown): ObserverConfig {
  const object = (v: unknown, keys: string[]) => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some((k) => !keys.includes(k)))
      throw new Error('Invalid observer configuration')
    return v as Record<string, unknown>
  }
  const id = (v: unknown) => {
    if (typeof v !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,128}$/.test(v)) throw new Error('Invalid observer identifier')
    return v
  }
  const c = object(value, ['tenantId', 'organizationId', 'sources', 'roots', 'providers'])
  if (!Array.isArray(c.sources) || !c.sources.length || !Array.isArray(c.roots) || !Array.isArray(c.providers))
    throw new Error('Invalid observer lists')
  const config: ObserverConfig = {
    tenantId: id(c.tenantId),
    organizationId: id(c.organizationId),
    sources: c.sources.map((v) => {
      if (typeof v !== 'string' || !path.isAbsolute(v)) throw new Error('Absolute telemetry source required')
      return v
    }),
    roots: c.roots.map((v) => {
      const r = object(v, ['root', 'projectId'])
      return { root: normalizeWorkspace(String(r.root)), projectId: id(r.projectId) }
    }),
    providers: c.providers.map((v) => {
      const p = object(v, ['identifier', 'provider', 'product', 'connectionId'])
      return {
        identifier: id(p.identifier),
        provider: id(p.provider),
        product: id(p.product),
        connectionId: id(p.connectionId),
      }
    }),
  }
  if (
    new Set(config.providers.map((p) => p.identifier)).size !== config.providers.length ||
    new Set(config.providers.map((p) => p.connectionId)).size !== config.providers.length
  )
    throw new Error('Ambiguous provider mapping')
  matchWorkspace(
    null,
    config.roots.map((r) => ({ ...r, projectName: '' })),
  )
  return config
}
async function lockScope(client: PoolClient, scope: ObserverScope, write = true) {
  if (write)
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `observer:${scope.tenantId}:${scope.organizationId}`,
    ])
  if (
    !(
      await client.query('SELECT id FROM organizations WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL', [
        scope.tenantId,
        scope.organizationId,
      ])
    ).rowCount
  )
    throw new Error('Observer organization unavailable')
}
async function rootsFor(client: PoolClient, scope: ObserverScope): Promise<WorkspaceRoot[]> {
  return (
    await client.query<WorkspaceRoot>(
      `SELECT r.root,r.project_id AS "projectId",p.name AS "projectName" FROM project_workspace_roots r JOIN projects p ON p.id=r.project_id AND p.tenant_id=r.tenant_id AND p.organization_id=r.organization_id WHERE r.tenant_id=$1 AND r.organization_id=$2 AND p.archived_at IS NULL`,
      [scope.tenantId, scope.organizationId],
    )
  ).rows
}
export async function configureObserver(pool: Pool, raw: ObserverConfig) {
  const config = validateObserverConfig(raw),
    client = await pool.connect()
  try {
    await client.query('BEGIN')
    await lockScope(client, config)
    for (const r of config.roots)
      if (
        !(
          await client.query(
            'SELECT id FROM projects WHERE tenant_id=$1 AND organization_id=$2 AND id=$3 AND archived_at IS NULL',
            [config.tenantId, config.organizationId, r.projectId],
          )
        ).rowCount
      )
        throw new Error('Observer project unavailable')
    await client.query('DELETE FROM project_workspace_roots WHERE tenant_id=$1 AND organization_id=$2', [
      config.tenantId,
      config.organizationId,
    ])
    for (const r of config.roots)
      await client.query(
        'INSERT INTO project_workspace_roots(tenant_id,organization_id,root,project_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [config.tenantId, config.organizationId, r.root, r.projectId],
      )
    for (const p of config.providers) {
      const capabilities = {
        connection_type: 'subscription',
        execution_mode: 'interactive',
        routing: false,
        subscription_product: p.product,
        provider_identifier: p.identifier,
      }
      await client.query(
        `INSERT INTO owned_connections(id,tenant_id,provider,mode,status,capabilities) VALUES($1,$2,$3,'subscription_interactive','active',$4::jsonb) ON CONFLICT(id) DO NOTHING`,
        [p.connectionId, config.tenantId, p.provider, JSON.stringify(capabilities)],
      )
      const existing = (
        await client.query(
          `SELECT id FROM owned_connections WHERE id=$1 AND tenant_id=$2 AND provider=$3 AND mode='subscription_interactive' AND revoked_at IS NULL AND credential_ref IS NULL AND credential_fingerprint IS NULL AND capabilities=$4::jsonb`,
          [p.connectionId, config.tenantId, p.provider, JSON.stringify(capabilities)],
        )
      ).rowCount
      if (!existing) throw new Error('Observer connection mapping conflicts with existing connection')
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
async function discover(sources: string[]) {
  const files = new Set<string>()
  async function walk(file: string) {
    const stat = await lstat(file)
    if (stat.isSymbolicLink()) throw new Error('Telemetry sources must not be symbolic links')
    if (stat.isDirectory()) {
      for (const entry of await readdir(file)) await walk(path.join(file, entry))
    } else if (stat.isFile() && file.endsWith('.jsonl')) files.add(await realpath(file))
  }
  for (const source of sources) await walk(source)
  return [...files].sort()
}
export class ObserverBusyError extends Error {
  constructor() {
    super('already_syncing')
  }
}

/** One database session owns the lock and every file transaction, including CLI scans. */
export async function scanCodex(pool: Pool, raw: ObserverConfig, options: { dryRun?: boolean } = {}) {
  const config = validateObserverConfig(raw)
  const client = await pool.connect()
  const key = `observer-scan:${config.tenantId}:${config.organizationId}`
  let locked = false
  let disconnected = false
  const connectionError = () => {
    disconnected = true
  }
  client.on('error', connectionError)
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(hashtext($1)) locked', [key])).rows[0].locked
    if (!locked) throw new ObserverBusyError()
    return await scanLocked(client, config, options)
  } finally {
    // Destroy the session if unlock fails; never return a locked client to the pool.
    try {
      if (locked && !disconnected) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key])
      client.removeListener('error', connectionError)
      client.release(disconnected)
    } catch {
      client.removeListener('error', connectionError)
      client.release(true)
    }
  }
}

async function scanLocked(client: PoolClient, raw: ObserverConfig, options: { dryRun?: boolean }) {
  const config = validateObserverConfig(raw),
    files = await discover(config.sources)
  const summary = {
    scannedFiles: files.length,
    newSessions: 0,
    newEvents: 0,
    updatedEvents: 0,
    skippedDuplicates: 0,
    unchangedFiles: 0,
    unassignedEvents: 0,
    bytesRead: 0,
    warnings: 0,
    dryRun: !!options.dryRun,
  }
  const newSessions = new Set<string>(),
    previewIds = new Set<string>()
  const groups = new Map<
    string,
    {
      projectId: string | null
      projectName: string | null
      provider: string | null
      subscriptionProduct: string | null
      sessions: Set<string>
      usageEvents: number
    }
  >()
  for (const file of files) {
    try {
      await client.query(options.dryRun ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
      await lockScope(client, config, !options.dryRun)
      const st = await lstat(file)
      const fileId = createHash('sha256')
        .update(JSON.stringify([file, st.dev, st.ino, st.birthtimeMs]))
        .digest('hex')
      const cursor = (
        await client.query(
          'SELECT byte_offset,state,parser_version FROM observer_scan_cursors WHERE tenant_id=$1 AND organization_id=$2 AND file_id=$3',
          [config.tenantId, config.organizationId, fileId],
        )
      ).rows[0]
      const resume = cursor && cursor.parser_version === PARSER_VERSION && Number(cursor.byte_offset) <= st.size
      const start = resume ? Number(cursor.byte_offset) : 0,
        parser = new CodexParser(resume ? cursor.state : undefined)
      if (resume && start === st.size) {
        summary.unchangedFiles++
        await client.query('COMMIT')
        continue
      }
      const sessionMetadata = await readSessionMetadata(file)
      if (!options.dryRun) await enrichSessionMetadata(client, config, sessionMetadata)
      const roots = await rootsFor(client, config)
      const connections = (
        await client.query<{ id: string; provider: string; identifier: string; product: string }>(
          `SELECT id,provider,capabilities->>'provider_identifier' identifier,capabilities->>'subscription_product' product FROM owned_connections WHERE tenant_id=$1 AND mode='subscription_interactive' AND status IN ('active','pending') AND revoked_at IS NULL AND credential_ref IS NULL AND credential_fingerprint IS NULL`,
          [config.tenantId],
        )
      ).rows
      const result = await readJsonl(file, start, st.size, async (rawEvent) => {
        const e = parser.parse(rawEvent)
        if (!e) return
        const root = matchWorkspace(e.cwd, roots)
        const configured = config.providers.find((p) => p.identifier === e.providerIdentifier)
        const conn = configured
          ? connections.find(
              (c) =>
                c.id === configured.connectionId &&
                c.identifier === configured.identifier &&
                c.provider === configured.provider &&
                c.product === configured.product,
            )
          : undefined
        if (configured && !conn) throw new Error('Observer connection unavailable; configure before scanning')
        const exists = (
          await client.query(
            'SELECT 1 FROM external_observed_usage WHERE tenant_id=$1 AND usage_source=$2 AND external_event_id=$3',
            [config.tenantId, e.source, e.eventId],
          )
        ).rowCount
        if (exists || previewIds.has(e.eventId)) {
          summary.skippedDuplicates++
          return
        }
        const sessionExists = (
          await client.query(
            'SELECT 1 FROM external_observed_usage WHERE tenant_id=$1 AND organization_id=$2 AND usage_source=$3 AND external_session_id=$4 LIMIT 1',
            [config.tenantId, config.organizationId, e.source, e.sessionId],
          )
        ).rowCount
        if (!sessionExists) newSessions.add(e.sessionId)
        if (!options.dryRun)
          await client.query(
            `INSERT INTO external_observed_usage(tenant_id,organization_id,usage_source,authority,external_session_id,external_event_id,turn_id,occurred_at,cwd,provider_identifier,provider,subscription_product,connection_id,model,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,total_tokens,project_id,project_name,matched_root,attributed_at,cli_version,parser_version,session_kind,parent_session_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,CASE WHEN $20::text IS NULL THEN NULL ELSE now() END,$23,$24,$25,$26)`,
            [
              config.tenantId,
              config.organizationId,
              e.source,
              e.authority,
              e.sessionId,
              e.eventId,
              e.turnId,
              e.timestamp,
              e.cwd,
              e.providerIdentifier,
              conn?.provider ?? e.providerIdentifier,
              conn?.product ?? null,
              conn?.id ?? null,
              e.model,
              e.tokens.input,
              e.tokens.cached,
              e.tokens.output,
              e.tokens.reasoning,
              e.tokens.total,
              root?.projectId ?? null,
              root?.projectName ?? null,
              root?.root ?? null,
              e.cliVersion,
              e.parserVersion,
              sessionMetadata?.sessionId === e.sessionId ? sessionMetadata.kind : null,
              sessionMetadata?.sessionId === e.sessionId ? sessionMetadata.parentSessionId : null,
            ],
          )
        previewIds.add(e.eventId)
        const groupKey = JSON.stringify([
          root?.projectId ?? null,
          conn?.provider ?? e.providerIdentifier,
          conn?.product ?? null,
        ])
        let group = groups.get(groupKey)
        if (!group) {
          group = {
            projectId: root?.projectId ?? null,
            projectName: root?.projectName ?? null,
            provider: conn?.provider ?? e.providerIdentifier,
            subscriptionProduct: conn?.product ?? null,
            sessions: new Set(),
            usageEvents: 0,
          }
          groups.set(groupKey, group)
        }
        group.sessions.add(e.sessionId)
        group.usageEvents++
        summary.newEvents++
        if (!root) summary.unassignedEvents++
      })
      summary.bytesRead += result.bytesRead
      summary.warnings += result.warnings + parser.warnings
      if (!options.dryRun)
        await client.query(
          `INSERT INTO observer_scan_cursors(tenant_id,organization_id,file_id,parser_version,byte_offset,state) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,organization_id,file_id) DO UPDATE SET byte_offset=excluded.byte_offset,state=excluded.state,parser_version=excluded.parser_version,updated_at=now()`,
          [config.tenantId, config.organizationId, fileId, PARSER_VERSION, result.offset, JSON.stringify(parser.state)],
        )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  }
  summary.newSessions = newSessions.size
  return { ...summary, groups: [...groups.values()].map((group) => ({ ...group, sessions: group.sessions.size })) }
}
export async function reattributeUnassigned(pool: Pool, scope: ObserverScope) {
  const client = await pool.connect()
  let count = 0
  try {
    await client.query('BEGIN')
    await lockScope(client, scope)
    const roots = await rootsFor(client, scope)
    const records = (
      await client.query<{ id: string; cwd: string | null }>(
        'SELECT id,cwd FROM external_observed_usage WHERE tenant_id=$1 AND organization_id=$2 AND project_id IS NULL FOR UPDATE',
        [scope.tenantId, scope.organizationId],
      )
    ).rows
    for (const record of records) {
      const root = matchWorkspace(record.cwd, roots)
      if (root) {
        await client.query(
          'UPDATE external_observed_usage SET project_id=$1,project_name=$2,matched_root=$3,attributed_at=now() WHERE id=$4 AND tenant_id=$5 AND organization_id=$6 AND project_id IS NULL',
          [root.projectId, root.projectName, root.root, record.id, scope.tenantId, scope.organizationId],
        )
        count++
      }
    }
    await client.query('COMMIT')
    return count
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** Enrich existing records only; no usage import or cursor writes. */
export async function enrichCodexSessions(pool: Pool, raw: ObserverConfig) {
  const config = validateObserverConfig(raw),
    files = await discover(config.sources)
  const client = await pool.connect()
  let updatedEvents = 0
  try {
    await client.query('BEGIN')
    await lockScope(client, config)
    for (const file of files)
      updatedEvents += await enrichSessionMetadata(client, config, await readSessionMetadata(file))
    await client.query('COMMIT')
    return { scannedHeaders: files.length, updatedEvents }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
