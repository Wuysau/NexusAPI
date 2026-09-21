import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { diagnoseConnection } from './diagnostic'
import { publicDiagnosticAddress } from './outbound'

describe('saved channel diagnostic', () => {
  it('handles no-content and nonstandard upstream statuses without throwing from a callback', async () => {
    for (const status of [204, 205, 700]) {
      const server = createServer((_req, res) => {
        res.writeHead(status)
        res.end()
      }).listen(0, '127.0.0.1')
      await new Promise<void>((r) => server.once('listening', r))
      try {
        const result = await diagnoseConnection(
          {
            base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
            protocol: 'openai',
            model: 'test',
          },
          'synthetic-key',
        )
        expect(result.ok).toBe(false)
      } finally {
        await new Promise<void>((r) => server.close(() => r()))
      }
    }
  })
  it('blocks DNS addresses in private, metadata, shared and transition networks', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '100.100.100.200',
      '192.0.2.1',
      '::1',
      '::ffff:127.0.0.1',
      '64:ff9b::a00:1',
      '2002:a00:1::1',
      'fe80::1',
    ])
      expect(publicDiagnosticAddress(address)).toBe(false)
    expect(publicDiagnosticAddress('8.8.8.8')).toBe(true)
    expect(publicDiagnosticAddress('2606:4700:4700::1111')).toBe(true)
  })
  it('does not connect when an HTTPS hostname resolves to a private address', async () => {
    let connections = 0
    const server = createServer().listen(0, '127.0.0.1')
    server.on('connection', () => connections++)
    await new Promise<void>((r) => server.once('listening', r))
    try {
      const port = (server.address() as { port: number }).port
      const result = await diagnoseConnection(
        { base_url: `https://localhost:${port}/v1`, protocol: 'openai', model: 'test' },
        'synthetic-diagnostic-key',
      )
      expect(result.ok).toBe(false)
      expect(connections).toBe(0)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
  it('sends Anthropic request to saved path and returns only safe usage, not response content or echoed key', async () => {
    const secret = 'synthetic-diagnostic-key'
    const server = createServer(async (req, res) => {
      expect(req.url).toBe('/dmx/anthropic/v1/messages')
      expect(req.headers['x-api-key']).toBe(secret)
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      expect(body.model).toBe('vendor/model')
      expect(body.max_tokens).toBe(16)
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          id: secret,
          type: 'message',
          content: [{ type: 'text', text: 'private-output' }],
          usage: { input_tokens: 12, output_tokens: 2 },
        }),
      )
    }).listen(0, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', r))
    try {
      const port = (server.address() as { port: number }).port
      const result = await diagnoseConnection(
        { base_url: `http://127.0.0.1:${port}/dmx/anthropic`, protocol: 'anthropic', model: 'vendor/model' },
        secret,
      )
      expect(result).toMatchObject({ ok: true, status: 200, inputTokens: '12', outputTokens: '2', responseId: null })
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(JSON.stringify(result)).not.toContain('private-output')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
  it('refuses redirects and emits no upstream error body or secret', async () => {
    let requests = 0
    const server = createServer((req, res) => {
      requests++
      res.writeHead(302, { Location: '/capture' })
      res.end('synthetic-sensitive-error')
    }).listen(0, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', r))
    try {
      const port = (server.address() as { port: number }).port
      const result = await diagnoseConnection(
        { base_url: `http://127.0.0.1:${port}/v1`, protocol: 'openai', model: 'test' },
        'synthetic-diagnostic-key',
      )
      expect(result).toMatchObject({ ok: false, status: 302 })
      expect(requests).toBe(1)
      expect(JSON.stringify(result)).not.toContain('synthetic-sensitive-error')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
