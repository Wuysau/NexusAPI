import { NextResponse } from 'next/server'
import { revokeSession, parseSessionCookie } from '@/lib/auth/sessions'
import { clientIp, routeError } from '../../_lib/control-plane'
import { clearAuthCookies } from '../_lib'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const token = parseSessionCookie(req.headers.get('cookie'))
    await revokeSession(token, { ip: clientIp(req) })
    const res = NextResponse.json({ ok: true }, { status: 200 })
    clearAuthCookies(res)
    res.headers.set('Cache-Control', 'no-store')
    return res
  } catch (error) {
    return routeError(error)
  }
}
