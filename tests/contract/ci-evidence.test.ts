import { describe, expect, it } from 'vitest'
const modulePath = '../../scripts/ci-gate.mjs'
const { testCounts, redact } = await import(modulePath)
describe('CI evidence output', () => {
  it('retains failures and skips instead of counting only passes', () => {
    expect(testCounts('Tests 12 passed | 2 failed | 1 skipped (15)')).toEqual({ passed: 12, failed: 2, skipped: 1 })
    expect(testCounts('Tests no tests')).toEqual({ passed: 0, failed: 0, skipped: 0 })
    expect(testCounts('9/10 e2e flows passed')).toEqual({ passed: 9, failed: 1, skipped: 0 })
    expect(testCounts('--- PASS: TestAllowed (0s)\n--- SKIP: TestMissingFixture (0s)')).toEqual({
      passed: 1,
      failed: 0,
      skipped: 1,
    })
  })
  it('redacts credential-bearing output', () => {
    expect(
      redact('token=fixture-sensitive-value postgresql://user:pass@db/name', {
        BUDGET_SERVICE_TOKEN: 'fixture-sensitive-value',
      }),
    ).toBe('token=[redacted] [redacted-database-url]')
  })
  it('counts nested Go skips and Vitest todo as incomplete', () => {
    expect(testCounts('--- PASS: TestOuter (0s)\n    --- SKIP: TestOuter/missing (0s)')).toEqual({
      passed: 1,
      failed: 0,
      skipped: 1,
    })
    expect(testCounts('Tests 12 passed | 1 todo (13)')).toEqual({ passed: 12, failed: 0, skipped: 1 })
  })
})
