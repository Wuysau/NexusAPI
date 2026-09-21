import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import DocsPage from '@/app/(dashboard)/docs/page'
import PlaygroundPage from '@/app/(dashboard)/playground/page'
import { ToastProvider } from '@/components/Toast'

// The old playground loads an authenticated catalog; the migration must remove
// credential submission independently of whether that catalog has any models.
vi.mock('@/components/lib/useApiData', () => ({
  useApiData: () => ({ data: { models: [{ upstreamModelId: 'test-model', displayName: 'Test' }] } }),
}))

afterEach(() => vi.unstubAllEnvs())

const docs = () => renderToStaticMarkup(createElement(ToastProvider, null, createElement(DocsPage)))

describe('Gateway caller migration', () => {
  it.each([
    '',
    '/v1',
    'javascript:alert(1)',
    'https://user:password@gateway.test/v1',
    'https://gateway.test/v1?token=secret',
    'https://gateway.test/v1#fragment',
  ])('does not publish request examples for missing or invalid gateway config: %s', (value) => {
    vi.stubEnv('NEXT_PUBLIC_GATEWAY_BASE_URL', value)
    const html = docs()
    expect(html).toContain('网关地址尚未配置')
    expect(html).not.toContain('curl ')
    expect(html).not.toContain('api.nexusai.dev')
  })

  it.each(['http://127.0.0.1:8080/v1/', 'https://gateway.test/nexus/v1/'])(
    'publishes only the explicit gateway URL: %s',
    (value) => {
      vi.stubEnv('NEXT_PUBLIC_GATEWAY_BASE_URL', value)
      const html = docs()
      expect(html).toContain(value.slice(0, -1) + '/chat/completions')
      expect(html).not.toContain('api.nexusai.dev')
    },
  )

  it('does not collect credentials or offer broken browser submission', () => {
    const html = renderToStaticMarkup(createElement(PlaygroundPage))
    expect(html).not.toContain('<form')
    expect(html).not.toContain('type="password"')
    expect(html).toContain('href="/docs"')
    expect(html).toContain('客户端')
  })

  it('quotes a configured URL in the copied shell example', () => {
    vi.stubEnv('NEXT_PUBLIC_GATEWAY_BASE_URL', 'https://gateway.test/api;version/v1')
    expect(docs()).toContain('&#x27;https://gateway.test/api;version/v1/chat/completions&#x27;')
  })
})
