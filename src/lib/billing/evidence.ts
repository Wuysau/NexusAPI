/** Explicit markers from scripts/seed-dev.mjs, never a guess based on amounts/status. */
export const realGatewayRequest = `NOT coalesce((
  r.id IN ('req-demo-0001','req-demo-0002','req-demo-0003','req-demo-0004')
  AND r.downstream_key_id='key-demo-production'
  AND r.idempotency_key='demo:' || r.id
),false)`
