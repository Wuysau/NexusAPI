import { describe, expect, it } from 'vitest'
import {
  SUBSCRIPTION_PRODUCTS,
  connectionSubscriptionProduct,
  getSubscriptionProduct,
  isCodexSubscription,
} from './catalog'

describe('subscription capability catalog', () => {
  it('has stable unique IDs and official HTTPS documentation without embedded credentials', () => {
    expect(SUBSCRIPTION_PRODUCTS.length).toBeGreaterThanOrEqual(19)
    expect(new Set(SUBSCRIPTION_PRODUCTS.map((p) => p.id)).size).toBe(SUBSCRIPTION_PRODUCTS.length)
    for (const product of SUBSCRIPTION_PRODUCTS) {
      expect(product.id).toMatch(/^[a-z][a-z0-9_]+$/)
      for (const value of [
        product.nativeGuideUrl,
        product.apiGuideUrl,
        product.channelPreset?.baseUrl,
        product.nativeApi?.baseUrl,
      ].filter(Boolean)) {
        const url = new URL(value!)
        expect(url.protocol).toBe('https:')
        expect(url.username + url.password).toBe('')
      }
    }
  })
  it('only advertises implemented native observation and distinguishes tool-only plans from ordinary API presets', () => {
    expect(SUBSCRIPTION_PRODUCTS.filter((p) => p.capabilities.nativeAccountObservation).map((p) => p.id)).toEqual([
      'openai_codex',
    ])
    expect(SUBSCRIPTION_PRODUCTS.filter((p) => p.capabilities.nativeUsageObservation).map((p) => p.id)).toEqual([
      'openai_codex',
    ])
    for (const id of ['zai_glm', 'alibaba_bailian']) {
      const product = getSubscriptionProduct(id)!
      expect(product.capabilities.gatewayAccess).toBe('restricted_coding_key')
      expect(product.nativeApi?.baseUrl).not.toBe(product.channelPreset?.baseUrl)
      expect(product.channelPreset?.auth).toBe('separate_api_key')
    }
    expect(getSubscriptionProduct('github_copilot')?.channelPreset).toBeUndefined()
  })
  it('preserves legacy Codex and never activates Codex for unrelated or unknown products', () => {
    const legacy = { provider: 'openai', mode: 'subscription_interactive' }
    expect(isCodexSubscription(legacy)).toBe(true)
    expect(isCodexSubscription({ ...legacy, subscription_product: 'unknown' })).toBe(false)
    expect(isCodexSubscription({ ...legacy, subscription_product: 'claude_code' })).toBe(false)
    expect(isCodexSubscription({ ...legacy, mode: 'direct_api', subscription_product: 'openai_codex' })).toBe(false)
    expect(isCodexSubscription({ ...legacy, provider: 'anthropic', subscription_product: 'openai_codex' })).toBe(false)
    expect(connectionSubscriptionProduct({ provider: 'anthropic', mode: 'subscription_interactive' })).toBeUndefined()
    for (const id of [null, {}, '', '__proto__', 'OpenAI_Codex']) expect(getSubscriptionProduct(id)).toBeUndefined()
  })
})
