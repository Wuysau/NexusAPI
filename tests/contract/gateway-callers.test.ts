import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import DocsPage from '@/app/(dashboard)/docs/page'
import PlaygroundPage from '@/app/(dashboard)/playground/page'
import { ToastProvider } from '@/components/Toast'
import { SessionProvider } from '@/components/SessionProvider'

// The external-client examples remain bound to explicit Gateway configuration.
// The project Playground separately requires authenticated session capability.
vi.mock('@/components/lib/useApiData', () => ({
  useApiData: () => ({ data: { projects: [{ id: 'test-project', name: 'Test', status: 'active' }] } }),
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

  it('does not collect credentials before session capability is available', () => {
    const html = renderToStaticMarkup(createElement(SessionProvider, null, createElement(PlaygroundPage)))
    expect(html).not.toContain('<form')
    expect(html).not.toContain('type="password"')
    expect(html).toContain('apikey:create')
  })

  it('quotes a configured URL in the copied shell example', () => {
    vi.stubEnv('NEXT_PUBLIC_GATEWAY_BASE_URL', 'https://gateway.test/api;version/v1')
    expect(docs()).toContain('&#x27;https://gateway.test/api;version/v1/chat/completions&#x27;')
  })
})
