import { describe, expect, it } from 'vitest'
import { verifyPassword } from '@/lib/crypto'

describe('password verification', () => {
  it('rejects malformed stored hashes without throwing on unequal digest lengths', () => {
    expect(() => verifyPassword('password', 'scrypt$16384$8$1$00$00')).not.toThrow()
    expect(verifyPassword('password', 'scrypt$16384$8$1$00$00')).toBe(false)
  })
})
