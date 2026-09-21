// ADR-0009: provider plaintext never crosses a Control Plane HTTP boundary.
// This endpoint stays retired in every environment, including local development.
export const dynamic = 'force-dynamic'

export async function POST(_req: Request): Promise<Response> {
  return Response.json(
    {
      error: { code: 'secret_workload_moved', message: 'Use the independently enrolled Gateway credential registry.' },
    },
    { status: 410, headers: { 'cache-control': 'no-store' } },
  )
}
