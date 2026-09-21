import { describe, expect, it } from 'vitest'
import { money, num } from './ui'

describe('console evidence formatting', () => {
  it('keeps missing financial/token evidence distinct from measured zero', () => {
    expect(money(null)).toBe('未知')
    expect(num(null)).toBe('未知')
    expect(money('0', 2)).toBe('$0.00')
    expect(num('0')).toBe('0')
  })
  it('preserves exact large counts and fixed-point money', () => {
    expect(num('9007199254740993')).toBe('9,007,199,254,740,993')
    expect(money('9007199254740993.123456', 6)).toBe('$9007199254740993.123456')
    expect(money('1.005', 2)).toBe('$1.01')
    expect(money('-1.005', 2)).toBe('$-1.01')
  })
})
