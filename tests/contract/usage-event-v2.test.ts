import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import fixtures from './fixtures/usage-event-v2.json'
import schema from '../../packages/contracts/schemas/usage-event-v2.schema.json'
import { validateUsageEventV2, usageEventTypeV2 } from '../../packages/contracts/usage-event-v2'
import { validateUsageEvent } from '../../packages/contracts/usage-event'

describe('canonical immutable usage v2', () => {
  for (const fixture of fixtures)
    it(fixture.name, () => {
      expect(validateUsageEventV2(fixture.event).ok).toBe(fixture.valid)
      if ('valid_v1' in fixture) expect(validateUsageEvent(fixture.event).ok).toBe(fixture.valid_v1)
    })
  it('keeps the v2 event namespace separate', () => {
    expect(usageEventTypeV2('completed')).toBe('usage.v2.completed')
  })
  it('rejects every missing required field and every unknown object field', () => {
    for (const [path, objectSchema] of [
      ['', schema],
      ['usage', schema.properties.usage],
      ['attribution', schema.properties.attribution],
    ] as const) {
      for (const missing of objectSchema.required) {
        const event = structuredClone(fixtures[0].event) as Record<string, unknown>
        const target = path ? (event[path] as Record<string, unknown>) : event
        delete target[missing]
        expect(validateUsageEventV2(event).ok, `${path}.${missing}`).toBe(false)
      }
    }
  })
  it('accepts valid wire fixtures under the standard JSON Schema vocabulary', () => {
    const ajv = new Ajv({ strict: false })
    addFormats(ajv)
    const validate = ajv.compile(schema)
    for (const fixture of fixtures.filter((f) => f.valid)) expect(validate(fixture.event), fixture.name).toBe(true)
  })
  it('checks generated TS and Go bindings against canonical schema', () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/generate-usage-v2.mjs', '--check'], {
        cwd: process.cwd(),
        stdio: 'pipe',
      }),
    ).not.toThrow()
  })
})
