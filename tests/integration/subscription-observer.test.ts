import { Pool } from 'pg'
import { mkdtemp, writeFile, appendFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { configureObserver, scanCodex, reattributeUnassigned } from '../../src/lib/observer/importer'
import { queryUsageAnalytics } from '../../src/lib/billing/analytics'
import { parseUsageAnalyticsQuery, validateUsageAnalyticsResponse } from '../../packages/contracts/usage-analytics'
import { ObserverService, requestObserverSync, readObserverRuntime } from '../../src/lib/observer/service'
import { observerSettings } from '../../src/lib/observer/configuration'
if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
const dir = await mkdtemp(path.join(tmpdir(), 'nexus-observer-'))
const file = path.join(dir, 'rollout-fixture.jsonl')
const scope = { tenantId: 'observer-tenant', organizationId: 'observer-org' }
const canaries = ['PROMPT_CANARY_30', 'ASSISTANT_CANARY_30', 'TOOL_CANARY_30', 'CREDENTIAL_CANARY_30']
const header = [
  {
    type: 'session_meta',
    payload: {
      id: 'session-test',
      cwd: 'D:/Nexus',
      model_provider: 'openai',
      cli_version: '0.154.0',
      prompt: canaries[0],
      access_token: canaries[3],
    },
  },
  {
    type: 'response_item',
    payload: { assistant_message: canaries[1], tool_output: canaries[2], refresh_token: canaries[3] },
  },
  { type: 'turn_context', payload: { turn_id: 'turn-test', cwd: 'D:/Nexus', model: 'model-a' } },
]
const event = (n: number, extra = {}) => ({
  type: 'event_msg',
  timestamp: '2026-09-18T08:00:00.000Z',
  payload: {
    type: 'token_count',
    info: {
      last_token_usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 5, total_tokens: 25, ...extra },
      total_token_usage: { input_tokens: 20 * n, output_tokens: 5 * n, total_tokens: 25 * n },
    },
    authorization: canaries[3],
  },
})
const lines = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n'
const config = {
  ...scope,
  sources: [file],
  roots: [{ root: 'D:/Nexus', projectId: 'observer-project' }],
  providers: [
    { identifier: 'openai', provider: 'openai', product: 'openai_codex', connectionId: 'observer-connection' },
  ],
}
beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES ('observer-org','observer-tenant','Observer','observer'),('other-org','other-tenant','Other','other');
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES ('observer-project','observer-tenant','observer-org','Nexus'),('second-project','observer-tenant','observer-org','Second'),('other-project','other-tenant','other-org','Other');`)
  await writeFile(file, lines(...header, event(1)))
})
afterAll(async () => {
  await pool.end()
  await rm(dir, { recursive: true, force: true })
})
it('migrates the privacy-bounded schema and configures non-routable connections', async () => {
  await configureObserver(pool, config)
  const c = (await pool.query("SELECT * FROM owned_connections WHERE id='observer-connection'")).rows[0]
  expect(c).toMatchObject({
    mode: 'subscription_interactive',
    credential_ref: null,
    credential_fingerprint: null,
    capabilities: { routing: false, execution_mode: 'interactive', connection_type: 'subscription' },
  })
  const columns = (
    await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='external_observed_usage'")
  ).rows.map((r) => r.column_name)
  expect(columns).not.toContain('raw_event')
  await expect(
    configureObserver(pool, { ...config, roots: [{ root: 'D:/Other', projectId: 'other-project' }] }),
  ).rejects.toThrow()
})
it('dry-run writes nothing; first scan, repeat scan and appends are atomic and idempotent', async () => {
  const dryRun = await scanCodex(pool, config, { dryRun: true })
  expect(dryRun.newEvents).toBe(1)
  expect(dryRun.groups).toEqual([
    {
      projectId: 'observer-project',
      projectName: 'Nexus',
      provider: 'openai',
      subscriptionProduct: 'openai_codex',
      sessions: 1,
      usageEvents: 1,
    },
  ])
  expect((await pool.query('SELECT * FROM observer_scan_cursors')).rowCount).toBe(0)
  expect((await scanCodex(pool, config)).newEvents).toBe(1)
  const repeat = await scanCodex(pool, config)
  expect(repeat.newEvents).toBe(0)
  expect(repeat.bytesRead).toBe(0)
  await appendFile(file, lines(event(1), event(2)))
  expect((await scanCodex(pool, config)).newEvents).toBe(1)
  const tail = JSON.stringify(event(3))
  await appendFile(file, tail.slice(0, -5))
  expect((await scanCodex(pool, config)).newEvents).toBe(0)
  await appendFile(
    file,
    tail.slice(-5) + '\n' + '{broken}\n' + lines({ type: 'future', payload: { shell_output: canaries[2] } }),
  )
  const result = await scanCodex(pool, config)
  expect(result.newEvents).toBe(1)
  expect(result.warnings).toBeGreaterThan(0)
  await pool.query('DELETE FROM observer_scan_cursors WHERE tenant_id=$1', [scope.tenantId])
  expect((await scanCodex(pool, config)).newEvents).toBe(0)
  expect((await pool.query('SELECT * FROM external_observed_usage')).rowCount).toBe(3)
})
it('persists no canary content or financial side effects', async () => {
  for (const table of ['external_observed_usage', 'observer_scan_cursors', 'owned_connections']) {
    const serialized = JSON.stringify((await pool.query(`SELECT to_jsonb(t) value FROM ${table} t`)).rows)
    for (const secret of canaries) expect(serialized).not.toContain(secret)
  }
  for (const table of ['usage_events', 'usage_records', 'outbox_events', 'ledger_transactions', 'request_records'])
    expect((await pool.query(`SELECT * FROM ${table}`)).rowCount).toBe(0)
})
it('captures historical attribution and explicitly fills only Unassigned', async () => {
  await configureObserver(pool, { ...config, roots: [{ root: 'D:/Nexus', projectId: 'second-project' }] })
  expect((await pool.query('SELECT DISTINCT project_id FROM external_observed_usage')).rows).toEqual([
    { project_id: 'observer-project' },
  ])
  await expect(pool.query("UPDATE external_observed_usage SET project_id='second-project'")).rejects.toThrow()
  await appendFile(
    file,
    lines({ type: 'turn_context', payload: { turn_id: 'turn-other', cwd: '/unassigned', model: 'model-b' } }, event(4)),
  )
  expect((await scanCodex(pool, config)).unassignedEvents).toBe(1)
  await configureObserver(pool, {
    ...config,
    roots: [...config.roots, { root: '/unassigned', projectId: 'second-project' }],
  })
  expect(await reattributeUnassigned(pool, scope)).toBe(1)
  expect(await reattributeUnassigned(pool, scope)).toBe(0)
  expect(
    (await pool.query("SELECT count(*)::int n FROM external_observed_usage WHERE project_id='observer-project'"))
      .rows[0].n,
  ).toBe(3)
})
it('reuses authorized Analytics with source, authority, model and project filters', async () => {
  const access = {
    tenantId: scope.tenantId,
    organizations: [{ organizationId: scope.organizationId, allProjects: true, projectIds: [] }],
    financialOrganizationId: null,
  }
  const q = (params: string) =>
    parseUsageAnalyticsQuery(
      new URLSearchParams(
        'from=2026-09-18T00:00:00Z&to=2026-09-19T00:00:00Z&asOf=' + new Date().toISOString() + '&' + params,
      ),
      new Date(),
    )
  const report = await queryUsageAnalytics(
    pool,
    access,
    q('usageSource=codex_local&authority=client_observed&groupBy=model'),
  )
  expect(validateUsageAnalyticsResponse(report)).toEqual({ ok: true, errors: [] })
  expect(report.totals).toMatchObject({
    requests: '0',
    observedEvents: '4',
    sessions: '1',
    money: [],
    tokens: { reasoning: { total: null }, cached: { total: '0' } },
  })
  expect(report.groups.map((g) => g.key)).toEqual(['model-a', 'model-b'])
  expect(
    (await queryUsageAnalytics(pool, access, q('usageSource=codex_local&projectId=observer-project'))).totals
      .observedEvents,
  ).toBe('3')
  expect(
    (await queryUsageAnalytics(pool, access, q('usageSource=all&authority=authoritative'))).totals.observedEvents,
  ).toBe('0')
  expect(
    (await queryUsageAnalytics(pool, access, q('usageSource=codex_local&provider=openai&groupBy=subscription')))
      .groups[0].key,
  ).toBe('openai_codex')
  expect(
    (await queryUsageAnalytics(pool, { ...access, tenantId: 'other-tenant' }, q('usageSource=all'))).totals
      .observedEvents,
  ).toBe('0')
  expect(
    (
      await queryUsageAnalytics(
        pool,
        { ...access, organizations: [{ organizationId: scope.organizationId, allProjects: false, projectIds: [] }] },
        q('usageSource=all'),
      )
    ).totals.observedEvents,
  ).toBe('0')
})

it('deduplicates copied files and safely replays truncation', async () => {
  const copied = path.join(dir, 'rollout-copy.jsonl')
  await copyFile(file, copied)
  const replay = await scanCodex(pool, { ...config, sources: [copied] })
  expect(replay.newEvents).toBe(0)
  expect(replay.skippedDuplicates).toBe(4)
  await writeFile(file, lines(...header, event(5)))
  expect((await scanCodex(pool, config)).newEvents).toBe(1)
  expect((await scanCodex(pool, config)).newEvents).toBe(0)
})

it('identifies Coding Plan only through explicit nonsecret provider mapping', async () => {
  const coding = path.join(dir, 'rollout-coding-plan.jsonl')
  await writeFile(
    coding,
    lines(
      {
        type: 'session_meta',
        payload: { id: 'coding-session', cwd: 'D:/Nexus', model_provider: 'coding-plan-profile' },
      },
      header[2],
      event(1),
    ),
  )
  const codingConfig = {
    ...config,
    sources: [coding],
    providers: [
      {
        identifier: 'coding-plan-profile',
        provider: 'alibaba',
        product: 'alibaba_coding_plan',
        connectionId: 'coding-connection',
      },
    ],
  }
  await configureObserver(pool, codingConfig)
  expect((await scanCodex(pool, codingConfig)).newEvents).toBe(1)
  expect(
    (
      await pool.query(
        "SELECT provider,subscription_product,authority FROM external_observed_usage WHERE external_session_id='coding-session'",
      )
    ).rows,
  ).toEqual([{ provider: 'alibaba', subscription_product: 'alibaba_coding_plan', authority: 'client_observed' }])
})

it('runs a durable background lifecycle, coalesces manual requests and resumes after restart', async () => {
  const configPath = path.join(dir, 'active.json')
  const settings = observerSettings({ CODEX_OBSERVER_CONFIG_PATH: configPath, CODEX_OBSERVER_INTERVAL_SECONDS: '2' })
  const service = new ObserverService(pool, settings)
  try {
    expect(await service.tick()).toBe('not_configured')
    await writeFile(configPath, JSON.stringify(config))
    expect(await service.tick()).toBe('idle')
    const first = await readObserverRuntime(pool, config, settings)
    expect(first?.last_successful_sync_at).toBeTruthy()
    expect(first?.last_result.newEvents).toBe(0)
    expect(first?.last_result.bytesRead).toBe(0)
    expect(await requestObserverSync(pool, config, settings)).toBe('queued')
    expect(await requestObserverSync(pool, config, settings)).toBe('already_syncing')
    await service.tick()
    expect((await readObserverRuntime(pool, config, settings))?.requested_at).toBeNull()
    const competitor = new ObserverService(pool, settings)
    expect(await competitor.tick()).toBe('already_running')
    await competitor.stop()
  } finally {
    await service.stop()
  }
  const restarted = new ObserverService(pool, settings)
  try {
    await restarted.tick()
    expect((await readObserverRuntime(pool, config, settings))?.last_result.bytesRead).toBe(0)
    expect(await readObserverRuntime(pool, { ...scope, tenantId: 'other-tenant' }, settings)).toBeNull()
    await writeFile(configPath, JSON.stringify({ ...config, sources: [path.join(dir, 'missing')] }))
    await requestObserverSync(pool, config, settings)
    const before = (await pool.query('SELECT file_id,byte_offset FROM observer_scan_cursors ORDER BY file_id')).rows
    expect(await restarted.tick()).toBe('source_unavailable')
    const failed = await readObserverRuntime(pool, config, settings)
    expect(failed?.last_error).toBe('source_unavailable')
    expect(failed?.last_successful_sync_at).toBeTruthy()
    expect((await pool.query('SELECT file_id,byte_offset FROM observer_scan_cursors ORDER BY file_id')).rows).toEqual(
      before,
    )
    await writeFile(configPath, JSON.stringify(config))
    await requestObserverSync(pool, config, settings)
    expect(await restarted.tick()).toBe('idle')
    expect((await readObserverRuntime(pool, config, settings))?.last_error).toBeNull()
    await writeFile(configPath, '{secret invalid json')
    expect(await restarted.tick()).toBe('error')
    expect((await readObserverRuntime(pool, config, settings))?.last_error).toBe('invalid_configuration')
  } finally {
    await restarted.stop()
  }
})

it('excludes overlapping scans across database sessions without moving the cursor', async () => {
  const client = await pool.connect()
  const key = `observer-scan:${scope.tenantId}:${scope.organizationId}`
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [key])
    await expect(scanCodex(pool, config)).rejects.toThrow('already_syncing')
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key])
    client.release()
  }
  expect((await scanCodex(pool, config)).newEvents).toBe(0)
})

it('automatically imports only appended bytes, rolls back a failed file, and retries on the next interval', async () => {
  const live = path.join(dir, 'live.jsonl')
  const configPath = path.join(dir, 'live-config.json')
  const settings = observerSettings({ CODEX_OBSERVER_CONFIG_PATH: configPath, CODEX_OBSERVER_INTERVAL_SECONDS: '1' })
  const liveConfig = { ...config, sources: [live] }
  await writeFile(
    live,
    lines({ ...header[0], payload: { ...header[0].payload, id: 'background-session' } }, header[2], event(1)),
  )
  await writeFile(configPath, JSON.stringify(liveConfig))
  const service = new ObserverService(pool, settings)
  try {
    expect(await service.tick()).toBe('idle')
    expect((await readObserverRuntime(pool, config, settings))?.last_result.newEvents).toBe(1)
    const appended = lines(event(2))
    await appendFile(live, appended)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await service.tick()
    expect((await readObserverRuntime(pool, config, settings))?.last_result).toMatchObject({
      newEvents: 1,
      bytesRead: Buffer.byteLength(appended),
    })
    await pool.query(`CREATE FUNCTION fail_observer_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_CONTENT_CANARY'; END $$;
      CREATE TRIGGER fail_observer_fixture BEFORE INSERT ON external_observed_usage FOR EACH ROW EXECUTE FUNCTION fail_observer_fixture()`)
    const before = (await pool.query('SELECT file_id,byte_offset FROM observer_scan_cursors ORDER BY file_id')).rows
    await appendFile(live, lines(event(3)))
    await requestObserverSync(pool, config, settings)
    expect(await service.tick()).toBe('error')
    expect((await pool.query('SELECT file_id,byte_offset FROM observer_scan_cursors ORDER BY file_id')).rows).toEqual(
      before,
    )
    expect(JSON.stringify(await readObserverRuntime(pool, config, settings))).not.toContain('PRIVATE_CONTENT_CANARY')
    await pool.query(
      'DROP TRIGGER fail_observer_fixture ON external_observed_usage; DROP FUNCTION fail_observer_fixture()',
    )
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(await service.tick()).toBe('idle')
    expect((await readObserverRuntime(pool, config, settings))?.last_result.newEvents).toBe(1)
    await pool.query(`UPDATE observer_runtime SET heartbeat_at=now()-interval '30 seconds' WHERE instance_id=$1`, [
      settings.instanceId,
    ])
    expect((await readObserverRuntime(pool, config, settings))?.state).toBe('stopped')
    expect(await requestObserverSync(pool, config, settings)).toBe('worker_unavailable')
  } finally {
    await service.stop()
  }
})

it('recovers a terminated database lease and supports manual sync with auto sync disabled', async () => {
  const configPath = path.join(dir, 'disconnect-config.json')
  const settings = observerSettings({ CODEX_OBSERVER_CONFIG_PATH: configPath, CODEX_OBSERVER_ENABLED: 'false' })
  await writeFile(configPath, JSON.stringify(config))
  const workerPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    application_name: 'observer-disconnect-fixture',
    connectionTimeoutMillis: 2000,
  })
  workerPool.on('error', () => {})
  const service = new ObserverService(workerPool, settings)
  try {
    await service.tick()
    const idle = await readObserverRuntime(pool, config, settings)
    expect(idle?.state).toBe('idle')
    expect(idle?.last_sync_started_at).toBeNull()
    expect(idle?.next_sync_at).toBeNull()
    // HTTP can use its already-held client, even if its pool has no spare connections.
    const single = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 500 })
    const client = await single.connect()
    try {
      expect(await requestObserverSync(client, config, settings)).toBe('queued')
    } finally {
      client.release()
      await single.end()
    }
    await service.tick()
    expect((await readObserverRuntime(pool, config, settings))?.last_successful_sync_at).toBeTruthy()
    const leasePid = (
      await pool.query(
        `SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.application_name='observer-disconnect-fixture' AND l.locktype='advisory' AND l.granted`,
      )
    ).rows[0].pid
    await pool.query('SELECT pg_terminate_backend($1)', [leasePid])
    await new Promise((resolve) => setTimeout(resolve, 50))
    await service.tick()
    expect((await readObserverRuntime(pool, config, settings))?.state).toBe('idle')
    expect(await requestObserverSync(pool, config, settings)).toBe('queued')
    expect(await service.tick()).toBe('idle')
  } finally {
    await service.stop()
    await workerPool.end()
  }
  expect((await readObserverRuntime(pool, config, settings))?.state).toBe('stopped')
  expect(await requestObserverSync(pool, config, settings)).toBe('worker_unavailable')
})

it('runs as a separate worker and gracefully stops when the parent IPC channel closes', async () => {
  const configPath = path.join(dir, 'process-config.json')
  const settings = observerSettings({ CODEX_OBSERVER_CONFIG_PATH: configPath })
  await writeFile(configPath, JSON.stringify(config))
  const worker = spawn(process.execPath, ['--import', 'tsx', 'services/observer/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, CODEX_OBSERVER_CONFIG_PATH: configPath },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  })
  const exited = new Promise<number | null>((resolve) => worker.once('exit', resolve))
  try {
    let ready = false
    for (let i = 0; i < 50; i++) {
      if ((await readObserverRuntime(pool, config, settings))?.last_successful_sync_at) {
        ready = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(ready).toBe(true)
    worker.disconnect()
    expect(await exited).toBe(0)
    expect((await readObserverRuntime(pool, config, settings))?.state).toBe('stopped')
  } finally {
    if (worker.exitCode === null) worker.kill()
  }
}, 10000)
