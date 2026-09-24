import { describe, expect, it } from 'vitest'
import { validateAgentConfig, matchLocalWorkspace } from './configuration'

const base = {
  tenantId: 't',
  organizationId: 'o',
  profiles: [{ profileRef: 'a', connectionId: 'a', home: 'C:/nexus/a' }],
  workspaces: [{ projectId: 'p', cwd: 'D:/code' }],
}
describe('local supervisor allowlist', () => {
  it('requires isolated absolute profile homes and unique references', () => {
    expect(validateAgentConfig(base).profiles).toHaveLength(1)
    expect(() =>
      validateAgentConfig({ ...base, profiles: [...base.profiles, { ...base.profiles[0], profileRef: 'b' }] }),
    ).toThrow()
    expect(() => validateAgentConfig({ ...base, profiles: [{ ...base.profiles[0], home: '../auth' }] })).toThrow()
    expect(() => validateAgentConfig({ ...base, token: 'secret' })).toThrow()
  })
  it('accepts only registered exact workspaces and projects', () => {
    const config = validateAgentConfig(base)
    expect(matchLocalWorkspace(config, 'p', 'D:/code')).toBeTruthy()
    expect(matchLocalWorkspace(config, 'p', 'D:/code-other')).toBeFalsy()
    expect(matchLocalWorkspace(config, 'q', 'D:/code')).toBeFalsy()
  })
  it('treats differently cased Windows network paths as the same profile home', () => {
    expect(() =>
      validateAgentConfig({
        ...base,
        profiles: [
          { profileRef: 'a', connectionId: 'a', home: '\\\\SERVER\\Share\\Profile' },
          { profileRef: 'b', connectionId: 'b', home: '\\\\server\\share\\profile' },
        ],
      }),
    ).toThrow()
  })
})
