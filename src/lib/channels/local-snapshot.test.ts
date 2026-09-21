import { describe, expect, it } from 'vitest'
import { buildLocalSnapshot, type LocalSnapshotChannel } from './local-snapshot'

const channel = (over: Partial<LocalSnapshotChannel> = {}): LocalSnapshotChannel => ({
  tenant_id: 'tenant-a',
  id: 'channel-a',
  provider_id: 'provider-a',
  provider: 'custom',
  base_url: 'https://example.invalid/v1',
  protocol: 'openai',
  auth_scheme: 'bearer',
  models: ['customer/model'],
  region: 'global',
  data_residency: 'global',
  credential_mode: 'byok',
  credential_ref: 'credential-a',
  credential_version: 1,
  credential_fingerprint: 'fingerprint',
  connection_id: 'connection-a',
  weight: 1,
  priority: 1,
  capabilities: ['text', 'streaming', 'vision'],
  enabled: true,
  ...over,
})

describe('local BYOK runtime snapshots', () => {
  it.each(['openai', 'anthropic'])('maps saved UI chat capability to %s chat transport capabilities', (protocol) => {
    const result = buildLocalSnapshot('tenant-a', [channel({ protocol, capabilities: ['chat'] })])
    expect(result.channels[0].capabilities).toEqual(['streaming', 'text'])
    expect(result.models[0].capabilities).toEqual(['streaming', 'text'])
  })

  it.each([
    { protocol: 'unsupported', capabilities: ['chat'], expected: [] },
    { protocol: undefined, capabilities: ['chat'], expected: [] },
    { protocol: 'openai', capabilities: ['embeddings', 'vision', 'audio'], expected: [] },
    { protocol: 'anthropic', capabilities: ['text'], expected: ['text'] },
  ])('does not invent unsupported capabilities for $protocol/$capabilities', ({ protocol, capabilities, expected }) => {
    const input = channel({ protocol, capabilities })
    if (protocol === undefined) delete input.protocol
    const result = buildLocalSnapshot('tenant-a', [input])
    expect(result.channels[0].capabilities).toEqual(expected)
    expect(result.models[0].capabilities).toEqual(expected)
  })

  it('publishes only the requested tenant with explicit unknown limits and no prices', () => {
    const result = buildLocalSnapshot('tenant-a', [channel(), channel({ tenant_id: 'tenant-b', id: 'other' })])
    expect(result.channels).toHaveLength(1)
    expect(result.channels[0]).not.toHaveProperty('tenant_id')
    expect(result.models).toEqual([
      expect.objectContaining({
        id: 'customer/model',
        aliases: [],
        capabilities: ['streaming', 'text'],
        context_window: 0,
        max_output_tokens: 0,
        license: 'customer-configured-owned-access',
      }),
    ])
    expect(result.payload.price_versions).toEqual([])
    expect(result.payload.routing_policies).toEqual([])
    expect(result.payload.catalog_version?.id).toMatch(/^local-[a-f0-9]{64}$/)
  })

  it('keeps platform scope free of tenant channel and model configuration', () => {
    const result = buildLocalSnapshot(null, [channel()])
    expect(result.channels).toEqual([])
    expect(result.models).toEqual([])
    expect(result.payload.price_versions).toEqual([])
  })

  it('keeps catalog identity stable across refresh, input order and other tenant changes', () => {
    const a = channel(),
      b = channel({ id: 'channel-b', models: ['second'] })
    const first = buildLocalSnapshot('tenant-a', [a, b], new Date('2026-01-01'))
    const later = buildLocalSnapshot(
      'tenant-a',
      [b, channel({ tenant_id: 'other', id: 'other' }), a],
      new Date('2026-02-01'),
    )
    expect(first.payload.catalog_version).toEqual(later.payload.catalog_version)
    expect(first.payload.generated_at).not.toBe(later.payload.generated_at)
    for (const over of [
      { models: ['changed'] },
      { credential_version: 2 },
      { base_url: 'https://changed.invalid/v1' },
    ]) {
      expect(buildLocalSnapshot('tenant-a', [channel(over), b]).payload.catalog_version?.id).not.toBe(
        first.payload.catalog_version?.id,
      )
    }
  })

  it('never converts managed, disabled or unbound channels into local routes', () => {
    expect(
      buildLocalSnapshot('tenant-a', [channel({ credential_mode: 'managed' }), channel({ enabled: false })]).channels,
    ).toEqual([])
    expect(() => buildLocalSnapshot('tenant-a', [channel({ connection_id: null })])).toThrow()
    expect(() => buildLocalSnapshot('tenant-a', [channel({ credential_ref: '' })])).toThrow()
  })
})
