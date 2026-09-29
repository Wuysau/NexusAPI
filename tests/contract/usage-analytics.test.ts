import { describe, expect, it } from 'vitest'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import {
  AnalyticsQueryError,
  parseUsageAnalyticsQuery,
  validateUsageAnalyticsResponse,
  ANALYTICS_GROUP_BY,
} from '../../packages/contracts/usage-analytics'
import type { AnalyticsMetrics } from '../../packages/contracts/usage-analytics'
import schema from '../../packages/contracts/schemas/usage-analytics-query.schema.json'
import responseSchema from '../../packages/contracts/schemas/usage-analytics-response.schema.json'

const now = new Date('2026-09-16T12:00:00Z')
const parse = (query = '') => parseUsageAnalyticsQuery(new URLSearchParams(query), now)

it('rejects the former browser date-only and snake_case queries while accepting every canonical group', () => {
  expect(() => parse('from=2026-09-01&to=2026-09-15')).toThrow(AnalyticsQueryError)
  expect(() => parse('groupBy=execution_mode')).toThrow(AnalyticsQueryError)
  for (const groupBy of ANALYTICS_GROUP_BY) {
    expect(parse(`from=2026-09-01T00:00:00%2B08:00&to=2026-09-16T00:00:00%2B08:00&groupBy=${groupBy}`)).toMatchObject({
      from: '2026-08-31T16:00:00.000Z',
      to: '2026-09-15T16:00:00.000Z',
      groupBy,
    })
  }
})

const responseFixture = () => {
  const metric = { knownSum: '9007199254740993000', unknownRequests: '0', total: '9007199254740993000' }
  const metrics = {
    requests: '9007199254740993',
    tokens: { input: metric, output: metric, cached: metric, reasoning: metric, total: metric },
    money: [
      {
        currency: 'USD',
        charge: metric,
        upstreamCost: metric,
        margin: { knownSum: '-90', unknownRequests: '0', total: '-90' },
      },
    ],
  }
  return structuredClone({
    from: '1970-01-01T00:00:00.000Z',
    to: now.toISOString(),
    asOf: now.toISOString(),
    groupBy: 'project',
    totals: metrics,
    groups: [{ key: '__unknown__', label: null, metrics }],
    totalGroups: '1',
    limit: 100,
    offset: 0,
    nextOffset: null,
  })
}
describe('canonical analytics response', () => {
  it('enforces absent money constraints with standard Ajv2020 keywords alone', () => {
    const ajv = new Ajv({ allErrors: true })
    addFormats(ajv)
    // Register extension annotations without implementing their runtime semantics.
    ajv.addKeyword('x-exact-total')
    ajv.addKeyword('x-time-range')
    const validate = ajv.compile(responseSchema)
    const absent = { knownSum: '0', unknownRequests: '0', total: null, hasFacts: false }
    const value = responseFixture()
    expect(validate(value)).toBe(true)
    const withMetric = (metric: unknown) => ({
      ...value,
      totals: { ...value.totals, money: [{ ...value.totals.money[0], margin: metric }] },
    })
    for (const valid of [
      absent,
      { knownSum: '0', unknownRequests: '0', total: '0' },
      { knownSum: '0', unknownRequests: '1', total: null },
    ]) {
      expect(validate(withMetric(valid)), JSON.stringify(validate.errors)).toBe(true)
      expect(validateUsageAnalyticsResponse(withMetric(valid)).ok).toBe(true)
    }
    for (const invalid of [
      { ...absent, total: '0' },
      { ...absent, knownSum: '9', total: '9' },
      { ...absent, knownSum: '9' },
      { ...absent, unknownRequests: '1' },
      { ...absent, hasFacts: true },
      { ...absent, hasFacts: 'false' },
    ]) {
      expect(validate(withMetric(invalid)), JSON.stringify(invalid)).toBe(false)
      expect(validateUsageAnalyticsResponse(withMetric(invalid)).ok).toBe(false)
    }
    expect(validate({ ...value, totals: { ...value.totals, tokens: { ...value.totals.tokens, input: absent } } })).toBe(
      false,
    )
  })
  it('distinguishes absent money dimensions from zero and unknown without allowing absent token facts', () => {
    const absent = { knownSum: '0', unknownRequests: '0', total: null, hasFacts: false }
    const value = responseFixture()
    const withMetric = (metric: unknown) => ({
      ...value,
      totals: { ...value.totals, money: [{ ...value.totals.money[0], margin: metric }] },
    })
    expect(validateUsageAnalyticsResponse(withMetric(absent))).toEqual({ ok: true, errors: [] })
    for (const invalid of [
      { ...absent, total: '0' },
      { ...absent, knownSum: '9' },
      { ...absent, unknownRequests: '1' },
      { ...absent, hasFacts: true },
      { ...absent, hasFacts: 'false' },
    ]) {
      expect(validateUsageAnalyticsResponse(withMetric(invalid)).ok).toBe(false)
    }
    expect(
      validateUsageAnalyticsResponse({
        ...value,
        totals: { ...value.totals, tokens: { ...value.totals.tokens, input: absent } },
      }).ok,
    ).toBe(false)
  })
  it('accepts exact large counts, signed margin and nullable currency', () => {
    const value = responseFixture()
    expect(validateUsageAnalyticsResponse(value)).toEqual({ ok: true, errors: [] })
    const unknown = { knownSum: '0', unknownRequests: '1', total: null }
    expect(
      validateUsageAnalyticsResponse({
        ...value,
        totals: {
          ...value.totals,
          money: [{ currency: null, charge: unknown, upstreamCost: unknown, margin: unknown }],
        },
      }).ok,
    ).toBe(true)
  })
  it.each([
    ['totals.requests', 1],
    ['totals.requests', '-1'],
    ['totals.requests', '1e9'],
    ['totals.tokens.input.knownSum', '-1'],
    ['totals.tokens.input.total', 1.5],
    ['totals.tokens.input.unknownRequests', null],
    ['totals.tokens.input.unknownRequests', '-1'],
    ['totals.tokens.input.total', null],
    ['totals.tokens.input.total', '3'],
    ['totals.money.0.charge.knownSum', 1.5],
    ['totals.money.0.charge.knownSum', '1.5'],
    ['totals.money.0.currency', 'usd'],
    ['totals.money.0.currency', 'US'],
    ['totals.extra', true],
    ['totals.tokens.extra', true],
    ['totals.tokens.input.extra', true],
    ['totals.money.0.extra', true],
    ['groups.0.extra', true],
    ['extra', true],
    ['limit', 201],
    ['nextOffset', -1],
    ['asOf', '2026-02-30T00:00:00Z'],
    ['groups', null],
  ])('rejects invalid response field %s', (path, replacement) => {
    const value = responseFixture()
    const parts = (path as string).split('.')
    let parent: Record<string, unknown> = value
    for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>
    parent[parts.at(-1)!] = replacement
    expect(validateUsageAnalyticsResponse(value).ok).toBe(false)
  })
  it('rejects missing required fields at every object level', () => {
    for (const path of ['', 'totals', 'totals.tokens', 'totals.tokens.input', 'totals.money.0', 'groups.0']) {
      const value = responseFixture()
      let target: Record<string, unknown> = value
      for (const part of path.split('.').filter(Boolean)) target = target[part] as Record<string, unknown>
      delete target[Object.keys(target)[0]]
      expect(validateUsageAnalyticsResponse(value).ok).toBe(false)
    }
  })
})

describe('canonical analytics query', () => {
  it('supports pagination past one million while reserving safe addition headroom', () => {
    const maximum = Number.MAX_SAFE_INTEGER - 200
    expect(parse('offset=1000001').offset).toBe(1000001)
    expect(parse(`offset=${maximum}&limit=200`).offset + 200).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => parse(`offset=${maximum + 1}`)).toThrow(AnalyticsQueryError)
    const response = responseFixture()
    response.offset = maximum
    expect(validateUsageAnalyticsResponse(response).ok).toBe(true)
    expect(validateUsageAnalyticsResponse({ ...response, nextOffset: maximum }).ok).toBe(true)
    expect(validateUsageAnalyticsResponse({ ...response, offset: maximum + 1 }).ok).toBe(false)
  })
  it('keeps runtime enum acceptance aligned with canonical schema', () => {
    for (const key of ['scope', 'groupBy', 'executionMode', 'status'] as const) {
      for (const value of schema.properties[key].enum) expect(parse(`${key}=${value}`)[key]).toBe(value)
    }
  })
  it('serializes exact amounts and explicit unknowns without numeric coercion', () => {
    const unknown = { knownSum: '900719925474099300000', unknownRequests: '1', total: null }
    const metrics: AnalyticsMetrics = {
      requests: '9007199254740993',
      tokens: { input: unknown, output: unknown, cached: unknown, reasoning: unknown, total: unknown },
      money: [
        {
          currency: null,
          charge: unknown,
          upstreamCost: unknown,
          margin: { knownSum: '-9007199254740993', unknownRequests: '0', total: '-9007199254740993' },
        },
      ],
    }
    expect(JSON.parse(JSON.stringify(metrics))).toEqual(metrics)
  })
  it('freezes default bounds and pagination', () => {
    expect(parse()).toEqual({
      scope: 'organization',
      groupBy: 'project',
      from: '1970-01-01T00:00:00.000Z',
      to: now.toISOString(),
      asOf: now.toISOString(),
      limit: 100,
      offset: 0,
      status: 'all',
    })
  })
  it('normalizes offsets and clamps only default to', () => {
    const q = parse('from=2026-09-15T12:00:00%2B08:00&asOf=2026-09-16T00:00:00Z')
    expect(q.from).toBe('2026-09-15T04:00:00.000Z')
    expect(q.to).toBe(q.asOf)
  })
  it('accepts bounded filters and legacy provider omission', () => {
    expect(
      parse(
        'scope=tenant&projectId=__unknown__&groupBy=connection&executionMode=unknown&limit=200&offset=1000000&provider=all&q=%20hello%20',
      ),
    ).toMatchObject({
      scope: 'tenant',
      projectId: '__unknown__',
      groupBy: 'connection',
      executionMode: 'unknown',
      limit: 200,
      offset: 1000000,
      q: 'hello',
    })
    expect(parse('provider=all')).not.toHaveProperty('provider')
  })
  it.each([
    'tenantId=x',
    'limit=1&limit=2',
    'scope=all',
    'groupBy=key',
    'executionMode=platform',
    'status=completed',
    'limit=0',
    'limit=201',
    'limit=1.1',
    'limit=1e2',
    'limit=%2B1',
    'offset=-1',
    'offset=9007199254740792',
    'projectId=',
    'projectId=a%20b',
    'model=a%0Ab',
    'providerId=' + 'a'.repeat(129),
    'q=' + 'a'.repeat(201),
    'from=2025-02-29T00:00:00Z',
    'from=2026-04-31T00:00:00Z',
    'from=2026-01-01',
    'from=2026-01-01T24:00:00Z',
    'from=2026-01-01T00:00:60Z',
    'from=2026-01-01T00:00:00%2B24:00',
    'from=2026-09-17T00:00:00Z',
    'asOf=2026-09-17T00:00:00Z',
    'to=2026-09-17T00:00:00Z',
    'from=2026-09-16T00:00:00Z&to=2026-09-15T00:00:00Z',
    'cursor=abc=',
    'cursor=____',
    'cursor=W10',
    'cursor=e30A',
  ])('rejects invalid query %s', (query) => {
    expect(() => parse(query)).toThrow(AnalyticsQueryError)
    try {
      parse(query)
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: 'invalid_request' })
    }
  })
  it('accepts canonical JSON object cursor', () => {
    expect(parse('cursor=eyJpZCI6ImEifQ').cursor).toBe('eyJpZCI6ImEifQ')
  })
})
