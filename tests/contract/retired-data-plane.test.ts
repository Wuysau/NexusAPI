import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import * as chat from '@/app/v1/chat/completions/route'
import * as models from '@/app/v1/models/route'
import * as admin from '@/app/api/admin/route'
import * as other from '@/app/v1/[...path]/route'

vi.mock('@/db', () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error('Retired endpoint accessed the database')
      },
    },
  ),
}))

type Handler = (req: Request) => Response | Promise<Response>

afterEach(() => vi.unstubAllEnvs())

describe('retired Next.js data plane', () => {
  for (const environment of ['production', 'development']) {
    for (const stream of [false, true]) {
      it(`${environment} chat stream=${stream} returns 410 without reading input or calling a provider`, async () => {
        vi.stubEnv('NODE_ENV', environment)
        const provider = vi.fn(() => {
          throw new Error('Unexpected provider call')
        })
        vi.stubGlobal('fetch', provider)
        try {
          const req = new Request('http://control.test/v1/chat/completions', {
            method: 'POST',
            body: JSON.stringify({ model: 'gpt-4o', stream }),
            headers: { authorization: 'Bearer synthetic-client-credential' },
          })
          const response = await (chat.POST as Handler)(req)
          expect(response.status).toBe(410)
          expect(response.headers.get('cache-control')).toBe('no-store')
          expect(response.headers.get('location')).toBeNull()
          expect(await response.json()).toMatchObject({ error: { code: 'data_plane_moved' } })
          expect(req.bodyUsed).toBe(false)
          expect(provider).not.toHaveBeenCalled()
        } finally {
          vi.unstubAllGlobals()
        }
      })
    }
  }

  it('retires models and the legacy admin writer even without authentication', async () => {
    for (const handler of [models.GET, admin.GET, admin.POST] as Handler[]) {
      const response = await handler(new Request('http://control.test/api/admin'))
      expect(response.status).toBe(410)
    }
  })

  it('removes the legacy server and demo-price compatibility source', () => {
    for (const path of ['src/lib/server.ts', 'src/lib/catalog.ts', 'src/lib/catalog/legacy.ts']) {
      expect(existsSync(path), path).toBe(false)
    }
  })

  it('tombstones unsupported compatibility paths and preserves error correlation', async () => {
    for (const handler of Object.values(other) as Handler[]) {
      const response = await handler(
        new Request('http://control.test/v1/responses', {
          headers: { 'x-request-id': 'request-correlation-fixture' },
        }),
      )
      expect(response.status).toBe(410)
      expect(response.headers.get('x-request-id')).toBe('request-correlation-fixture')
      expect(await response.json()).toMatchObject({ error: { request_id: 'request-correlation-fixture', param: null } })
    }
    const response = await (chat.POST as Handler)(new Request('http://control.test/v1/chat/completions'))
    expect((await response.json()).error.request_id).toBeTruthy()
  })

  it('keeps retired model and accounting handlers and their transitive dependencies free of IO', () => {
    const root = resolve('src/app/v1')
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('route.ts'))
      .map((file) => resolve(root, file))
    expect(files.length).toBeGreaterThanOrEqual(2)
    files.push(
      resolve('src/app/api/internal/gateway/reserve/route.ts'),
      resolve('src/app/api/internal/gateway/settle/route.ts'),
    )
    const visited = new Set<string>()
    const visit = (file: string) => {
      if (visited.has(file)) return
      visited.add(file)
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      const walk = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          const spec = node.moduleSpecifier
          if (spec && ts.isStringLiteral(spec)) {
            expect(spec.text.startsWith('.') || spec.text.startsWith('@/'), file).toBe(true)
            const target = spec.text.startsWith('@/')
              ? resolve('src', spec.text.slice(2))
              : resolve(dirname(file), spec.text)
            visit(target + '.ts')
          }
        }
        if (ts.isCallExpression(node)) {
          // Retirement handlers may construct a JSON response, never invoke an
          // imported proxy, dynamic loader, database, fetch, or HTTP client.
          expect(['Response.json', 'req.headers.get', 'crypto.randomUUID'], file).toContain(
            node.expression.getText(source),
          )
        }
        if (ts.isNewExpression(node)) throw new Error(`Unexpected constructor in retired route: ${file}`)
        ts.forEachChild(node, walk)
      }
      walk(source)
    }
    for (const file of files) visit(file)
  })
})
