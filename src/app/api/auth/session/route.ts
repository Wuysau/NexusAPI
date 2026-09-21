import { NextResponse } from 'next/server'
import { pool } from '@/db'
import { resolveContext, routeError } from '../../_lib/control-plane'
import { sessionPayload } from '../_lib'

export const dynamic = 'force-dynamic'

/**
 * Current session for the dashboard shell. Unauthenticated is a normal state
 * (200 `{ authenticated: false }`) rather than an error: the shell uses it to
 * choose between the login screen and the console, and must not surface a
 * misleading error toast on a first visit.
 */
export async function GET(req: Request) {
  try {
    const ctx = await resolveContext(req)
    const environment = (process.env.NODE_ENV as 'development' | 'test' | 'production' | undefined) ?? 'development'
    if (!ctx) {
      return NextResponse.json(
        { authenticated: false, environment },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
      )
    }

    const user = await pool.query<{ email: string; name: string | null }>(
      'SELECT email, name FROM users WHERE id = $1',
      [ctx.principal.userId],
    )
    const row = user.rows[0]
    return NextResponse.json(sessionPayload(ctx, row?.email ?? '', row?.name ?? null), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return routeError(error)
  }
}
