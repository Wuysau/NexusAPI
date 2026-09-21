import { describe, it, expect } from 'vitest'
import { redact, UpstreamError } from './openai-compatible'

describe('log redaction (redact)', () => {
  it('strips upstream error bodies to a status-only message', () => {
    const e = new UpstreamError('{ "error": {"message":"API key sk-leaked-secret-123"} }', 401)
    expect(redact(e)).toBe('upstream error (status 401)')
    expect(redact(e)).not.toContain('sk-leaked')
  })
  it('does not leak stack traces or internal messages for generic errors', () => {
    const e = new Error('connect ECONNREFUSED 10.0.0.5:443 internal-host')
    expect(redact(e)).toBe('upstream error')
    expect(redact(e)).not.toContain('10.0.0.5')
    expect(redact(e)).not.toContain('internal-host')
  })
})
