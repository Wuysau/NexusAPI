export function connectorTestDatabaseURL(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Dedicated local connector_test database required')
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !/^\/connector_test(?:_[a-z0-9]+)*$/.test(url.pathname) ||
    String(value).includes('?') ||
    String(value).includes('#')
  )
    throw new Error('Dedicated local connector_test database required')
  return url
}

export async function assertFixtureDatabase(pool, url) {
  if ((await pool.query('SELECT current_database() AS name')).rows[0]?.name !== url.pathname.slice(1))
    throw new Error('Connected fixture database does not match the explicitly selected database')
}

export function healthRecoveryDatabaseURL(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Exact local storage recovery fixture required')
  }
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.port !== '55439' ||
    url.pathname !== '/gateway_test_health_recovery_round57' ||
    String(value).includes('?') ||
    String(value).includes('#')
  )
    throw new Error('Exact local storage recovery fixture required')
  return url
}
