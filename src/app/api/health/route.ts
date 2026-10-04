import { pool } from '@/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    // Bound this probe's response read after acquiring a client. pg discards
    // the client on timeout; ordinary application queries keep their own limits.
    const query = { text: 'select 1', query_timeout: 2000 }
    await pool.query(query)
    return Response.json({ ok: true })
  } catch {
    return Response.json({ ok: false }, { status: 500 })
  }
}
