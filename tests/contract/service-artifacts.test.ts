import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createBudgetServer } from '../../services/budget/server'
import type { Pool } from 'pg'

const worker = vi.hoisted(() => ({
  query: vi.fn(async () => ({
    rows: ['next_attempt_at', 'claimed_by', 'claimed_at'].map((column_name) => ({ column_name })),
  })),
  release: vi.fn(),
  end: vi.fn(async () => {}),
  poll: vi.fn(async () => ({ published: 0, retried: 0, deadLettered: 0 })),
  readHeartbeat: vi.fn(),
  writeHeartbeat: vi.fn(async () => {}),
}))
vi.mock('@/db', () => ({ pool: { connect: async () => worker, end: worker.end } }))
vi.mock('../../services/worker/consumer', () => ({ pollOutboxOnce: worker.poll }))
vi.mock('@/lib/billing/reconcile', () => ({ runReconciliation: vi.fn() }))
vi.mock('node:fs/promises', () => ({
  readFile: worker.readHeartbeat,
  writeFile: worker.writeHeartbeat,
  rename: vi.fn(async () => {}),
  unlink: vi.fn(async () => {}),
}))
vi.mock('pg', () => ({
  Pool: class {
    connect = async () => worker
    end = async () => {}
  },
}))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('compiled accounting service artifacts', () => {
  it('budget readiness requires workload auth and a reachable complete schema', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ready: true }] })
    const token = 'synthetic-budget-readiness-token'
    const server = createBudgetServer({ query } as unknown as Pool, token)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    const url = `http://127.0.0.1:${port}/readyz`
    try {
      expect((await fetch(url)).status).toBe(401)
      expect(query).not.toHaveBeenCalled()
      const headers = { authorization: `Bearer ${token}` }
      expect((await fetch(url, { headers })).status).toBe(200)
      query.mockResolvedValueOnce({ rows: [{ ready: false }] })
      expect((await fetch(url, { headers })).status).toBe(503)
      query.mockRejectedValueOnce(new Error('sensitive database connection details'))
      const unavailable = await fetch(url, { headers })
      expect(unavailable.status).toBe(503)
      expect(await unavailable.text()).not.toContain('sensitive')
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })
  it('builds runnable CommonJS artifacts without TypeScript alias imports', () => {
    const build = spawnSync(process.execPath, ['scripts/build-services.mjs', 'all'], { encoding: 'utf8' })
    expect(build.status, build.stderr).toBe(0)
    for (const name of ['worker', 'budget']) {
      const artifact = `dist/${name}.cjs`
      expect(readFileSync(artifact, 'utf8')).not.toMatch(/require\(["']@\//)
      const result = spawnSync(process.execPath, [artifact], {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          DATABASE_URL: '',
          BUDGET_SERVICE_TOKEN: '',
          DOTENV_CONFIG_PATH: 'nonexistent-fixture-env',
        },
      })
      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('DATABASE_URL is required')
    }
    const budget = spawnSync(process.execPath, ['dist/budget.cjs'], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/fixture',
        BUDGET_SERVICE_TOKEN: '',
        DOTENV_CONFIG_PATH: 'nonexistent-fixture-env',
      },
    })
    expect(budget.error).toBeUndefined()
    expect(budget.status).not.toBe(0)
    expect(budget.stderr).toContain('BUDGET_SERVICE_TOKEN')
    const health = spawnSync(process.execPath, ['dist/worker.cjs', '--healthcheck'], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/fixture',
        WORKER_HEARTBEAT_FILE: 'nonexistent-worker-heartbeat-fixture',
        DOTENV_CONFIG_PATH: 'nonexistent-fixture-env',
      },
    })
    expect(health.error).toBeUndefined()
    expect(health.status).toBe(1)
    expect(health.stdout).not.toContain('starting')
  }, 15000)

  it.each(['worker', 'budget'])('%s runtime uses its compiled artifact as a non-root user', (name) => {
    const dockerfile = readFileSync(`services/${name}/Dockerfile`, 'utf8')
    expect(dockerfile).toContain('node:24-alpine')
    expect(dockerfile).toContain('npm ci --omit=dev')
    expect(dockerfile).toContain('USER 1001:1001')
    expect(dockerfile).toContain(`CMD ["node", "dist/${name}.cjs"]`)
    expect(dockerfile).toContain('HEALTHCHECK')
    expect(dockerfile).not.toContain('npx tsx')
  })

  it('wakes an idle Worker immediately on SIGTERM despite a one-hour polling interval', async () => {
    vi.useFakeTimers()
    vi.stubEnv('DATABASE_URL', 'postgresql://synthetic:synthetic@127.0.0.1:1/fixture')
    vi.stubEnv('WORKER_POLL_INTERVAL_MS', '3600000')
    const listeners = new Set(process.listeners('SIGTERM'))
    const interruptListeners = new Set(process.listeners('SIGINT'))
    try {
      await import('../../services/worker/index')
      await vi.advanceTimersByTimeAsync(0)
      expect(worker.poll).toHaveBeenCalledOnce()
      process.emit('SIGTERM')
      await vi.advanceTimersByTimeAsync(0)
      expect(worker.end).toHaveBeenCalledOnce()
    } finally {
      await vi.runOnlyPendingTimersAsync()
      for (const listener of process.listeners('SIGTERM'))
        if (!listeners.has(listener)) process.off('SIGTERM', listener)
      for (const listener of process.listeners('SIGINT'))
        if (!interruptListeners.has(listener)) process.off('SIGINT', listener)
    }
  })

  it('Worker readiness rejects missing/stale heartbeat and missing retry schema', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://synthetic:synthetic@127.0.0.1:1/fixture')
    vi.stubEnv('WORKER_POLL_INTERVAL_MS', '1000')
    const { checkWorkerReadiness } = await import('../../services/worker/index')
    worker.readHeartbeat.mockRejectedValueOnce(new Error('missing heartbeat'))
    await expect(checkWorkerReadiness()).rejects.toThrow('missing heartbeat')
    worker.readHeartbeat.mockResolvedValueOnce(JSON.stringify({ pid: process.pid, completedAt: Date.now() - 2001 }))
    await expect(checkWorkerReadiness()).rejects.toThrow('stale')
    worker.readHeartbeat.mockResolvedValue(JSON.stringify({ pid: process.pid, completedAt: Date.now() }))
    worker.query.mockResolvedValueOnce({ rows: [] })
    await expect(checkWorkerReadiness()).rejects.toThrow('missing')
    await expect(checkWorkerReadiness()).resolves.toBeUndefined()
  })

  it('SIGTERM finishes the current transaction even if the heartbeat cannot be written', async () => {
    vi.useFakeTimers()
    vi.stubEnv('DATABASE_URL', 'postgresql://synthetic:synthetic@127.0.0.1:1/fixture')
    vi.resetModules()
    worker.end.mockClear()
    worker.query.mockClear()
    let finishBatch!: (value: { published: number; retried: number; deadLettered: number }) => void
    worker.poll.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishBatch = resolve
        }),
    )
    worker.writeHeartbeat.mockRejectedValueOnce(new Error('read-only filesystem'))
    const listeners = new Set(process.listeners('SIGTERM'))
    const interruptListeners = new Set(process.listeners('SIGINT'))
    const finish = () => finishBatch({ published: 0, retried: 0, deadLettered: 0 })
    try {
      await import('../../services/worker/index')
      await vi.advanceTimersByTimeAsync(0)
      process.emit('SIGTERM')
      await vi.advanceTimersByTimeAsync(0)
      expect(worker.end).not.toHaveBeenCalled()
      finish()
      await vi.advanceTimersByTimeAsync(0)
      expect(worker.query).toHaveBeenCalledWith('COMMIT')
      expect(worker.query).not.toHaveBeenCalledWith('ROLLBACK')
      expect(worker.end).toHaveBeenCalledOnce()
    } finally {
      finish()
      await vi.runOnlyPendingTimersAsync()
      for (const listener of process.listeners('SIGTERM'))
        if (!listeners.has(listener)) process.off('SIGTERM', listener)
      for (const listener of process.listeners('SIGINT'))
        if (!interruptListeners.has(listener)) process.off('SIGINT', listener)
    }
  })
})
