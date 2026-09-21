import { describe, expect, it, vi } from 'vitest'
import { POST as reserve } from '@/app/api/internal/gateway/reserve/route'
import { POST as settle } from '@/app/api/internal/gateway/settle/route'
import { isBudgetRequest } from '../../packages/contracts/budget'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const Ajv = require('ajv')
const validateSchema = new Ajv().compile(
  JSON.parse(readFileSync('packages/contracts/schemas/budget-request.schema.json', 'utf8')),
)

vi.mock('@/db', () => ({
  pool: new Proxy(
    {},
    {
      get() {
        throw new Error('retired route reached database')
      },
    },
  ),
}))

describe('accounting workload boundary', () => {
  it.each([reserve, settle])('retires Control Plane funds endpoints without consuming payload', async (handler) => {
    const request = new Request('https://control.test/api/internal/gateway/settle', {
      method: 'POST',
      body: 'invalid JSON',
    })
    const response = await handler(request)
    expect(response.status).toBe(410)
    expect(request.bodyUsed).toBe(false)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await response.json()).error.code).toBe('billing_endpoint_retired')
  })
  const valid = {
    version: 1,
    tenant_id: 't',
    organization_id: 'o',
    request_id: 'r',
    key_id: 'k',
    model_id: 'm',
    provider: 'p',
    currency: 'USD',
    price_version_id: 'pp',
    sale_price_snapshot_id: 'sp',
    exchange_rate_snapshot_id: null,
    estimated_input_tokens: 100,
    estimated_output_tokens: 50,
    ttl_seconds: 900,
  }
  it('requires bounded integer tokens and explicit immutable versions', () => {
    expect(isBudgetRequest(valid)).toBe(true)
    expect(validateSchema(valid)).toBe(true)
    expect(isBudgetRequest({ ...valid, prompt: 'must not enter the accounting ledger' })).toBe(false)
    for (const change of [
      { version: 2 },
      { estimated_input_tokens: -1 },
      { estimated_output_tokens: 1.2 },
      { estimated_output_tokens: Infinity },
      { sale_price_snapshot_id: '' },
      { exchange_rate_snapshot_id: undefined },
      { ttl_seconds: 0 },
      { currency: 'usd' },
    ]) {
      expect(isBudgetRequest({ ...valid, ...change })).toBe(false)
      expect(validateSchema({ ...valid, ...change })).toBe(false)
    }
  })
  it('accepts explicit immutable attribution and rejects unknown or spoofed context', () => {
    const context = {
      project_id: 'project-a',
      project_name: 'Project A',
      api_key_id: 'k',
      key_kind: 'shared',
      principal_id: null,
      attribution_status: 'attributed',
      requested_model: 'alias',
      streaming: true,
      catalog_version_id: 'catalog',
      policy_version_id: null,
    }
    expect(isBudgetRequest({ ...valid, attribution_context: context })).toBe(true)
    expect(validateSchema({ ...valid, attribution_context: context })).toBe(true)
    for (const change of [
      { principal_id: 'creator' },
      { execution_mode: 'managed' },
      { connection_id: 'injected' },
      { attribution_status: 'unknown' },
      { streaming: undefined },
      { policy_version_id: undefined },
      { policy_version_id: '' },
      { policy_version_id: 'x'.repeat(129) },
      { catalog_version_id: 'x'.repeat(129) },
      { requested_model: ' alias ' },
    ]) {
      const request = { ...valid, attribution_context: { ...context, ...change } }
      expect(isBudgetRequest(request)).toBe(false)
      expect(validateSchema(request)).toBe(false)
    }
    expect(isBudgetRequest({ ...valid, attribution_context: { ...context, api_key_id: 'other' } })).toBe(false)
  })
})
