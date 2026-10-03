// Invoke the production route in a fresh Node process so native fetch receives
// the fixture CA at startup, including on Node 24.0. Secrets arrive only on stdin.
interface Input {
  cookie: string
  apiKey: string
  model: string
  connectionId: string
}

// Route internals may log unexpected failures. Keep all module logs outside
// this fixture's result protocol, including errors containing private inputs.
const safeWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = () => true
process.stderr.write = () => true

async function main() {
  const database = new URL(process.env.DATABASE_URL ?? '')
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['127.0.0.1', 'localhost'].includes(database.hostname) ||
    database.port !== '55439' ||
    database.search !== '' ||
    !['/connector_test_attribution_round49', '/convergence_ci15'].includes(database.pathname)
  )
    throw new Error('Dedicated attribution fixture required')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 8192) throw new Error('Fixture input limit exceeded')
    chunks.push(Buffer.from(chunk))
  }
  const input: Input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if ([input.cookie, input.apiKey, input.model, input.connectionId].some((value) => typeof value !== 'string'))
    throw new Error('Invalid fixture input')
  const { pool } = await import('../../src/db/index')
  try {
    if ((await pool.query('SELECT current_database() AS name')).rows[0].name !== database.pathname.slice(1))
      throw new Error('Unexpected attribution fixture')
    const { POST } = await import('../../src/app/api/connections/[id]/connector/test/route')
    const response = await POST(
      new Request(`http://localhost/api/connections/${input.connectionId}/connector/test`, {
        method: 'POST',
        headers: {
          cookie: `${input.cookie}; nexus_csrf=attribution-csrf`,
          'x-csrf-token': 'attribution-csrf',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ apiKey: input.apiKey, model: input.model }),
      }),
      { params: Promise.resolve({ id: input.connectionId }) },
    )
    const body = await response.json()
    // Never forward arbitrary route/Gateway body strings, cookies or credentials.
    const requestId =
      typeof body.requestId === 'string' && /^req_(?:[0-9a-f]{32}|[0-9]{1,20})$/.test(body.requestId)
        ? body.requestId
        : null
    safeWrite(
      JSON.stringify({
        status: response.status,
        ok: body.ok === true,
        code: body.error?.code === 'different_channel_selected' ? body.error.code : null,
        requestId,
        modelMatches: body.model === input.model,
      }) + '\n',
    )
  } finally {
    await pool.end()
  }
}

main().catch(() => {
  safeWrite(JSON.stringify({ status: 0, code: 'fixture_invocation_failed' }) + '\n')
  process.exitCode = 1
})
