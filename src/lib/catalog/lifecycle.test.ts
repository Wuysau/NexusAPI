import { describe, it, expect } from 'vitest'
import {
  PRICE_LIFECYCLE_STATES,
  assertTransition,
  canAutoActivate,
  canTransition,
  classifyRisk,
  isPriceLifecycleState,
  LifecycleError,
  type AutoActivateCandidate,
} from './lifecycle'
import type { PriceComponent } from '../pricing/components'

const comp = (kind: PriceComponent['kind'], amount: string, unit = 'per_million_tokens'): PriceComponent => ({
  kind,
  unit,
  amount,
  conditions: {},
})

const baseCandidate = (over: Partial<AutoActivateCandidate> = {}): AutoActivateCandidate => ({
  provider: 'openai',
  modelId: 'gpt-4o',
  modelIdMatched: true,
  currency: 'USD',
  components: [comp('input', '2.50'), comp('output', '10.00')],
  ...over,
})

describe('price lifecycle state machine', () => {
  it('allows the documented transitions', () => {
    expect(canTransition('fetched', 'validated')).toBe(true)
    expect(canTransition('validated', 'pending_approval')).toBe(true)
    expect(canTransition('pending_approval', 'scheduled')).toBe(true)
    expect(canTransition('pending_approval', 'rejected')).toBe(true)
    expect(canTransition('scheduled', 'active')).toBe(true)
    expect(canTransition('active', 'superseded')).toBe(true)
  })

  it('rejects forbidden transitions', () => {
    expect(canTransition('active', 'fetched')).toBe(false)
    expect(canTransition('superseded', 'active')).toBe(false)
    expect(canTransition('rejected', 'validated')).toBe(false)
    expect(canTransition('fetched', 'active')).toBe(false)
    expect(canTransition('active', 'scheduled')).toBe(false)
    expect(() => assertTransition('superseded', 'active')).toThrow(LifecycleError)
    try {
      assertTransition('active', 'fetched')
    } catch (e) {
      expect((e as LifecycleError).code).toBe('invalid_transition')
    }
  })

  it('allows any state to be rejected (deny-by-default otherwise)', () => {
    for (const state of PRICE_LIFECYCLE_STATES) {
      if (state === 'rejected') continue
      expect(canTransition(state, 'rejected'), `${state} → rejected`).toBe(true)
    }
    expect(isPriceLifecycleState('pending_approval')).toBe(true)
    expect(isPriceLifecycleState('pending')).toBe(false)
  })
})

describe('canAutoActivate', () => {
  it('allows a well-formed first version', () => {
    expect(canAutoActivate(baseCandidate(), null)).toEqual({ ok: true, reasons: [] })
  })

  it('blocks an unmatched model id', () => {
    const r = canAutoActivate(baseCandidate({ modelIdMatched: false }), null)
    expect(r.ok).toBe(false)
    expect(r.reasons).toContain('model_id_unmatched')
  })

  it('blocks a parser structure change', () => {
    const r = canAutoActivate(baseCandidate({ parserStructureChanged: true }), null)
    expect(r.reasons).toContain('parser_structure_changed')
  })

  it('blocks an unknown currency and a currency change', () => {
    expect(canAutoActivate(baseCandidate({ currency: 'usd' }), null).reasons).toContain('currency_unknown')
    const active = { currency: 'USD', components: [comp('input', '2.50'), comp('output', '10.00')] }
    expect(canAutoActivate(baseCandidate({ currency: 'EUR' }), active).reasons).toContain('currency_changed')
  })

  it('blocks an undeterminable unit (unknown or mixed)', () => {
    expect(
      canAutoActivate(baseCandidate({ components: [comp('input', '2.50', 'per_furlong')] }), null).reasons,
    ).toContain('unit_undeterminable')
    const mixed = [comp('input', '2.50', 'per_million_tokens'), comp('request', '0.01', 'per_request')]
    expect(canAutoActivate(baseCandidate({ components: mixed }), null).reasons).toContain('unit_undeterminable')
  })

  it('blocks multi-context-tier ambiguity', () => {
    expect(canAutoActivate(baseCandidate({ contextTiers: [128_000, 200_000] }), null).reasons).toContain(
      'multi_context_tier_ambiguity',
    )
  })

  it('blocks a zero price unless the source marks the model free', () => {
    const zero = [comp('input', '0'), comp('output', '0')]
    expect(canAutoActivate(baseCandidate({ components: zero }), null).reasons).toContain('zero_price_on_non_free_model')
    const r = canAutoActivate(baseCandidate({ components: zero, isFreeModel: true }), null)
    expect(r.ok).toBe(true)
  })

  it('blocks a price change above 20% but allows exactly 20%', () => {
    const active = { currency: 'USD', components: [comp('input', '2.50'), comp('output', '10.00')] }
    // 2.50 → 3.10 is +24%
    expect(
      canAutoActivate(baseCandidate({ components: [comp('input', '3.10'), comp('output', '10.00')] }), active).reasons,
    ).toContain('price_change_exceeds_20pct')
    // 2.50 → 3.00 is exactly +20% (not "above")
    expect(
      canAutoActivate(baseCandidate({ components: [comp('input', '3.00'), comp('output', '10.00')] }), active).ok,
    ).toBe(true)
    // 0 → any non-zero is an anomaly
    expect(
      canAutoActivate(baseCandidate({ components: [comp('input', '0.01'), comp('output', '10.00')] }), {
        currency: 'USD',
        components: [comp('input', '0'), comp('output', '10.00')],
      }).reasons,
    ).toContain('price_change_exceeds_20pct')
  })
})

describe('classifyRisk', () => {
  it('flags removals, unit changes and small price increases as high risk', () => {
    const active = { currency: 'USD', components: [comp('input', '2.50'), comp('output', '10.00')] }
    expect(classifyRisk(baseCandidate({ removed: true }), active).reasons).toContain('model_removed')

    // +10% — not auto-blocked, but still high-risk for the review queue.
    const small = classifyRisk(baseCandidate({ components: [comp('input', '2.75'), comp('output', '10.00')] }), active)
    expect(small.highRisk).toBe(true)
    expect(small.reasons).toContain('price_increase')
    expect(small.reasons).not.toContain('price_change_exceeds_20pct')

    const unitChange = classifyRisk(baseCandidate({ components: [comp('input', '0.0000025', 'per_token')] }), active)
    expect(unitChange.reasons).toContain('unit_changed')
  })

  it('does not flag an unchanged low-risk version', () => {
    const active = { currency: 'USD', components: [comp('input', '2.50'), comp('output', '10.00')] }
    expect(classifyRisk(baseCandidate(), active)).toEqual({ highRisk: false, reasons: [] })
  })
})
