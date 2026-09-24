import { expect, it } from 'vitest'
import { boundaryDecision } from './boundary'
it('waits for running tools even for manual and emergency switches', () => {
  expect(boundaryDecision({ state: 'running', reason: 'quota_exhausted', autoFailover: true })).toBe('wait')
  expect(boundaryDecision({ state: 'running', reason: 'manual_switch', autoFailover: false })).toBe('wait')
})
it('switches resource failures only and respects automatic opt-out', () => {
  expect(boundaryDecision({ state: 'failed', reason: 'quota_exhausted', autoFailover: true })).toBe('switch')
  expect(boundaryDecision({ state: 'failed', reason: 'unknown', autoFailover: true })).toBe('fail')
  expect(boundaryDecision({ state: 'failed', reason: 'rate_limit', autoFailover: false })).toBe('pause')
  expect(boundaryDecision({ state: 'idle', reason: 'manual_switch', autoFailover: false })).toBe('switch')
  expect(boundaryDecision({ state: 'idle', reason: 'approval_required', autoFailover: true })).toBe('pause')
})
it('uses near-limit and automatic-return signals only to prepare while the resource remains usable', () => {
  expect(boundaryDecision({ state: 'idle', reason: 'near_limit', autoFailover: true })).toBe('wait')
  expect(boundaryDecision({ state: 'failed', reason: 'near_limit', autoFailover: true })).toBe('wait')
  expect(boundaryDecision({ state: 'idle', reason: 'auto_return', autoFailover: true })).toBe('wait')
})
it('switches after a confirmed authentication failure', () => {
  expect(boundaryDecision({ state: 'failed', reason: 'authentication_failure', autoFailover: true })).toBe('switch')
})
