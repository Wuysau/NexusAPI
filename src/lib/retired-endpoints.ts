// Permanent, side-effect-free tombstones. Never redirect a credential-bearing
// request to a URL supplied by the caller or by mutable control-plane config.
export function retiredDataPlane(req: Request) {
  const requestId = req.headers.get('x-request-id') || 'req_' + crypto.randomUUID()
  return Response.json(
    {
      error: {
        code: 'data_plane_moved',
        type: 'invalid_request_error',
        param: null,
        request_id: requestId,
        message: 'Model requests must use the Go Gateway base URL. This Control Plane endpoint is retired.',
      },
    },
    { status: 410, headers: { 'cache-control': 'no-store', 'x-request-id': requestId } },
  )
}

export function retiredAdmin(req: Request) {
  const requestId = req.headers.get('x-request-id') || 'req_' + crypto.randomUUID()
  return Response.json(
    {
      error: {
        code: 'legacy_admin_retired',
        type: 'invalid_request_error',
        param: null,
        request_id: requestId,
        message: 'Use the authenticated /api/keys, /api/channels and other typed Control Plane APIs.',
      },
    },
    { status: 410, headers: { 'cache-control': 'no-store', 'x-request-id': requestId } },
  )
}
