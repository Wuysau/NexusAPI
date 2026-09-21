import { describe, expect, it } from 'vitest'
import { channelConfigurationState } from './configuration'

describe('channel configuration evidence', () => {
  it('does not treat enabled channels without a credential as configured', () => {
    expect(channelConfigurationState({ enabled: true, credential: null })).toBe('missing_credential')
  })

  it('distinguishes disabled channels and disabled or unknown credential references', () => {
    expect(channelConfigurationState({ enabled: false, credential: null })).toBe('disabled')
    expect(channelConfigurationState({ enabled: true, credential: { enabled: false } })).toBe('credential_disabled')
    expect(channelConfigurationState({ enabled: true, credential: { enabled: null } })).toBe('credential_unknown')
  })

  it('reports a stored enabled reference without asserting successful routing', () => {
    expect(channelConfigurationState({ enabled: true, credential: { enabled: true } })).toBe('reference_recorded')
  })
})
