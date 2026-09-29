import { describe, expect, it, vi } from 'vitest'
vi.mock('@/db', () => ({ pool: {} }))
import { periodEndFor } from './service'

describe('paid subscription calendar periods', () => {
  it.each([
    ['month', '2025-01-31T16:25:00.123Z', '2025-02-28T16:25:00.123Z'],
    ['month', '2024-01-31T16:25:00.123Z', '2024-02-29T16:25:00.123Z'],
    ['month', '2025-12-31T16:25:00.123Z', '2026-01-31T16:25:00.123Z'],
    ['year', '2024-02-29T16:25:00.123Z', '2025-02-28T16:25:00.123Z'],
  ])('clamps %s period from %s to %s', (interval, start, end) => {
    const original = new Date(start)
    expect(periodEndFor(interval, original).toISOString()).toBe(end)
    expect(original.toISOString()).toBe(start)
  })
})
