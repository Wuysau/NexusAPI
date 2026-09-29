import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const compose = require('js-yaml').load(readFileSync('infra/docker-compose.prod.yml', 'utf8'))

describe('canonical production topology', () => {
  it('builds four independent, non-root, read-only services', () => {
    const files = [
      'infra/Dockerfile',
      'services/gateway/Dockerfile',
      'services/worker/Dockerfile',
      'services/budget/Dockerfile',
    ]
    for (const [index, name] of ['app', 'gateway', 'worker', 'budget'].entries()) {
      const service = compose.services[name]
      expect(service.build.dockerfile).toBe(files[index])
      expect(service.build.context).toBe('${NEXUS_BUILD_CONTEXT:-..}')
      expect(service.user).toBe('1001:1001')
      expect(service.read_only).toBe(true)
    }
    expect(compose.services.budget.ports).toBeUndefined()
    expect(compose.services.worker.ports).toBeUndefined()
    expect(compose.services.gateway.depends_on.app).toBeUndefined()
    expect(compose.services.budget.depends_on.worker).toBeUndefined()
    expect(compose.services.worker.depends_on.budget).toBeUndefined()
  })
  it('uses canonical Gateway env and separate database identities without local KMS defaults', () => {
    const gateway = compose.services.gateway.environment
    expect(gateway.GATEWAY_ENV).toBe('production')
    for (const key of ['DATABASE_URL', 'REDIS_URL', 'CONTROL_PLANE_URL', 'BUDGET_SERVICE_URL', 'BUDGET_SERVICE_TOKEN'])
      expect(gateway[key]).toBeTruthy()
    for (const key of ['GATEWAY_DATABASE_URL', 'GATEWAY_REDIS_URL', 'GATEWAY_CONTROL_PLANE_URL'])
      expect(gateway[key]).toBeUndefined()
    const connections = ['app', 'gateway', 'worker', 'budget'].map(
      (name) => compose.services[name].environment.DATABASE_URL,
    )
    expect(new Set(connections).size).toBe(4)
    expect(compose.services.app.environment.KMS_PROVIDER).not.toContain(':-local')
    expect(compose.services.budget.environment.GATEWAY_INTERNAL_TOKEN).toBeUndefined()
  })
  it('allows Gateway draining and terminal persistence before container termination', () => {
    const grace = String(compose.services.gateway.stop_grace_period)
    expect(grace).toMatch(/^\d+s$/)
    expect(Number.parseInt(grace, 10)).toBeGreaterThanOrEqual(45)
  })
})
