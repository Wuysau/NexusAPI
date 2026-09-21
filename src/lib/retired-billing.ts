/** The private accounting workload owns reservations; Worker owns final usage. */
export function retiredBilling(req: Request): Response {
  const id = req.headers.get('x-request-id') || 'req_' + crypto.randomUUID()
  return Response.json(
    {
      error: {
        code: 'billing_endpoint_retired',
        type: 'invalid_request_error',
        param: null,
        request_id: id,
        message: 'Use the independent budget service for authorization and the durable outbox for final usage.',
      },
    },
    { status: 410, headers: { 'cache-control': 'no-store', 'x-request-id': id } },
  )
}
