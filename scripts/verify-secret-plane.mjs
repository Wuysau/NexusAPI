import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { request } from 'node:https'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const root = resolve('.test-artifacts/vault-reference')
const tls = resolve(root, 'tls'),
  identity = resolve(root, 'identity')
const container = 'nexus-vault-tls-convergence'
const image = 'hashicorp/vault@sha256:4e33b126a59c0c333b76fb4e894722462659a6bec7c48c9ee8cea56fccfd2569'
const base = 'https://127.0.0.1:58201/v1/'
const checks = {},
  policyDigests = {}
let stage = 'fixture startup'
const hash = (value) => createHash('sha256').update(value).digest('hex')
const command = (bin, args) => {
  stage = `${bin} ${args[0]}`
  return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
}
const requireCheck = (name, condition) => {
  if (!condition) {
    stage = `check ${name}`
    throw new Error(name)
  }
  checks[name] = 'passed'
}
let ca, admin
async function call(path, body, token, expected = 200, headers = {}) {
  stage = `Vault API ${path}`
  const result = await new Promise((accept, reject) => {
    const req = request(
      new URL(path, base),
      {
        ca,
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-vault-token': token } : {}), ...headers },
        timeout: 10000,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            accept({ status: res.statusCode, body: data ? JSON.parse(data) : {} })
          } catch {
            reject(new Error('Invalid Vault response'))
          }
        })
      },
    )
    req.on('error', () => reject(new Error('Vault TLS connection failed')))
    req.on('timeout', () => req.destroy())
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  if (result.status !== expected) throw new Error(`Unexpected Vault status for ${path}: ${result.status}`)
  return result.body
}
async function policy(name, text) {
  await call(`sys/policies/acl/${name}`, { policy: text }, admin, 204)
  policyDigests[name] = hash(text)
}
async function login(role) {
  const roleID = (await call(`auth/approle/role/${role}/role-id`, undefined, admin)).data.role_id
  const wrapped = await call(`auth/approle/role/${role}/secret-id`, {}, admin, 200, { 'x-vault-wrap-ttl': '60s' })
  requireCheck(`${role}:response_wrapped`, wrapped.wrap_info?.creation_path === `auth/approle/role/${role}/secret-id`)
  const secret = (await call('sys/wrapping/unwrap', {}, wrapped.wrap_info.token)).data.secret_id
  await call('sys/wrapping/unwrap', {}, wrapped.wrap_info.token, 400)
  checks[`${role}:wrapping_single_use`] = 'passed'
  const auth = (await call('auth/approle/login', { role_id: roleID, secret_id: secret })).auth
  await call('auth/approle/login', { role_id: roleID, secret_id: secret }, undefined, 400)
  checks[`${role}:secret_id_single_use`] = 'passed'
  requireCheck(
    `${role}:bounded_role_token`,
    auth.policies.length === 1 && auth.policies[0] === role && auth.lease_duration <= 1800,
  )
  return auth.client_token
}
async function agentLogin(role) {
  const directory = resolve(root, 'gateway-agent')
  await mkdir(directory, { recursive: true })
  const roleID = (await call(`auth/approle/role/${role}/role-id`, undefined, admin)).data.role_id
  const wrapped = await call(`auth/approle/role/${role}/secret-id`, {}, admin, 200, { 'x-vault-wrap-ttl': '60s' })
  await writeFile(resolve(directory, 'role-id'), roleID, { mode: 0o600 })
  await writeFile(resolve(directory, 'wrapped-secret-id'), wrapped.wrap_info.token, { mode: 0o600 })
  await writeFile(resolve(directory, 'ca.pem'), ca)
  await writeFile(
    resolve(directory, 'agent.hcl'),
    `disable_mlock=true\nvault {\naddress="https://nexus-vault-tls-convergence:8200"\nca_cert="/bootstrap/ca.pem"\n}\nauto_auth {\nmethod "approle" {\nmount_path="auth/approle"\nconfig={ role_id_file_path="/bootstrap/role-id" secret_id_file_path="/bootstrap/wrapped-secret-id" secret_id_response_wrapping_path="auth/approle/role/${role}/secret-id" remove_secret_id_file_after_reading=false }\n}\nsink "file" { config={ path="/run/identity/gateway-token" mode=0600 } }\n}\n`,
  )
  try {
    command('docker', ['network', 'inspect', 'nexus13-reference'])
  } catch {
    command('docker', ['network', 'create', 'nexus13-reference'])
  }
  const network = JSON.parse(command('docker', ['inspect', container]))[0].NetworkSettings.Networks
  if (!network['nexus13-reference']) command('docker', ['network', 'connect', 'nexus13-reference', container])
  const agent = 'nexus-vault-agent-convergence'
  try {
    command('docker', ['inspect', agent])
    command('docker', ['rm', '-f', agent])
  } catch {
    /* Only named disposable Agent is replaced. */
  }
  command('docker', [
    'run',
    '-d',
    '--name',
    agent,
    '--network',
    'nexus13-reference',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/run/identity:rw,noexec,nosuid,mode=0700',
    '--user',
    '0',
    '--entrypoint',
    'vault',
    '--mount',
    `type=bind,source=${directory},target=/bootstrap,readonly`,
    image,
    'agent',
    '-config=/bootstrap/agent.hcl',
  ])
  let token
  for (let n = 0; n < 100; n++) {
    try {
      token = command('docker', ['exec', agent, 'cat', '/run/identity/gateway-token']).trim()
      if (token) break
    } catch {
      /* Wait for auto-auth without printing logs or token. */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  if (!token) {
    let status = 'unknown'
    let exitCode = 'unknown'
    try {
      const detail = JSON.parse(command('docker', ['inspect', agent]))[0]
      status = detail.State.Status
      exitCode = detail.State.ExitCode
    } catch {
      /* Keep the failure report safe if the disposable container vanished. */
    }
    const result = spawnSync('docker', ['logs', agent], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const logs = `${result.stdout || ''}\n${result.stderr || ''}`
    const permissionLines = logs.split(/\r?\n/).filter((line) => /permission denied/i.test(line))
    const access = [
      ['role-id', '/bootstrap/role-id', '-r'],
      ['wrapped-id', '/bootstrap/wrapped-secret-id', '-r'],
      ['ca', '/bootstrap/ca.pem', '-r'],
      ['sink', '/run/identity', '-w'],
    ]
      .map(([name, path, flag]) => {
        const probe = spawnSync('docker', ['exec', agent, 'test', flag, path], {
          stdio: 'ignore',
          windowsHide: true,
        })
        return `${name}:${probe.status === 0 ? 'yes' : 'no'}`
      })
      .join(',')
    const processStatus = spawnSync('docker', ['exec', agent, 'cat', '/proc/1/status'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const processUid = /^Uid:\s+(\d+)/m.exec(processStatus.stdout || '')?.[1] || 'unknown'
    const bootstrapStats = ['/bootstrap/role-id', '/bootstrap/wrapped-secret-id', '/bootstrap/ca.pem']
      .map((path) => {
        const probe = spawnSync('docker', ['exec', agent, 'stat', '-c', '%u:%a', path], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        return probe.status === 0 ? probe.stdout.trim() : 'unknown'
      })
      .join(',')
    const signals = [
      ['tls', /x509|certificate|tls handshake/i],
      ['network', /no such host|connection refused|dial tcp|lookup /i],
      ['permission', /permission denied|operation not permitted/i],
      ['api-403', /error making api request|code:\s*403|status code:\s*403/i],
      ['wrapped-secret', /wrapping token|wrapped secret|secret.id/i],
      ['config', /error parsing|invalid configuration|unknown field/i],
      ['auth', /error authenticating|invalid role|login failed/i],
    ]
      .filter(([, pattern]) => pattern.test(logs))
      .map(([name]) => name)
    const deniedAt = [
      ['role-id', /\/bootstrap\/role-id/i],
      ['wrapped-id', /\/bootstrap\/wrapped-secret-id/i],
      ['ca', /\/bootstrap\/ca\.pem/i],
      ['bootstrap-other', /\/bootstrap(?!\/(?:role-id|wrapped-secret-id|ca\.pem))/i],
      ['sink', /run\/identity|gateway-token|sink/i],
      ['Vault API', /auth\/approle|api request|status code|code:\s*403/i],
    ]
      .filter(([, pattern]) => permissionLines.some((line) => pattern.test(line)))
      .map(([name]) => name)
    stage = `Vault Agent token bootstrap timeout (container=${status}, exit=${exitCode}, uid=${processUid}, bootstrap=${bootstrapStats}, access=${access}, signals=${signals.join(',') || 'none'}, deniedAt=${deniedAt.join(',') || 'unknown'})`
    throw new Error('Agent identity bootstrap failed')
  }
  await call('sys/wrapping/unwrap', {}, wrapped.wrap_info.token, 400)
  requireCheck('agent_consumed_single_use_wrapped_secret', true)
  const detail = JSON.parse(command('docker', ['inspect', agent]))[0]
  requireCheck(
    'agent_sink_private_tmpfs',
    detail.HostConfig.Tmpfs['/run/identity'].includes('mode=0700') && detail.HostConfig.ReadonlyRootfs,
  )
  requireCheck(
    'agent_no_admin_or_docker_mount',
    detail.Mounts.every(
      (m) =>
        m.Destination === '/bootstrap' ||
        (m.Type === 'volume' && ['/vault/logs', '/vault/file'].includes(m.Destination)),
    ),
  )
  const sinkMode = command('docker', ['exec', agent, 'stat', '-c', '%a', '/run/identity/gateway-token']).trim()
  requireCheck('agent_token_mode_0600', sinkMode === '600')
  let denied = false
  try {
    command('docker', ['exec', '--user', '65534:65534', agent, 'cat', '/run/identity/gateway-token'])
  } catch {
    denied = true
  }
  requireCheck('unprivileged_process_cannot_read_agent_sink', denied)
  requireCheck('agent_logs_no_token', !command('docker', ['logs', agent]).includes(token))
  return token
}
async function main() {
  await mkdir(tls, { recursive: true })
  await mkdir(identity, { recursive: true })
  let exists = true
  try {
    command('docker', ['inspect', container])
  } catch {
    exists = false
  }
  if (!exists) {
    command('go', ['run', 'infra/vault-reference/certificates.go', tls])
    await writeFile(
      resolve(tls, 'vault.hcl'),
      `ui=false\ndisable_mlock=false\nstorage "file" { path="/vault/file/data" }\nlistener "tcp" {\naddress="0.0.0.0:8200"\ntls_cert_file="/fixture/server.pem"\ntls_key_file="/fixture/server-key.pem"\n}\napi_addr="https://nexus-vault-tls-convergence:8200"\n`,
    )
    command('docker', [
      'run',
      '-d',
      '--name',
      container,
      '--cap-add=IPC_LOCK',
      '--user',
      '0',
      '--entrypoint',
      'vault',
      '-p',
      '127.0.0.1:58201:8200',
      '--mount',
      `type=bind,source=${tls},target=/fixture,readonly`,
      image,
      'server',
      '-config=/fixture/vault.hcl',
    ])
  }
  ca = await readFile(resolve(tls, 'ca.pem'))
  let initialized
  for (let n = 0; n < 30; n++) {
    try {
      initialized = await call('sys/init')
      break
    } catch {
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  if (!initialized) throw new Error('Vault TLS fixture did not start')
  let custody
  if (!initialized.initialized) {
    custody = await call('sys/init', { secret_shares: 1, secret_threshold: 1 })
    await writeFile(resolve(tls, 'admin-secrets.json'), JSON.stringify(custody), { mode: 0o600 })
  } else custody = JSON.parse(await readFile(resolve(tls, 'admin-secrets.json'), 'utf8'))
  admin = custody.root_token
  const seal = await call('sys/seal-status')
  if (seal.sealed) await call('sys/unseal', { key: custody.keys_base64[0] })
  const health = await call('sys/health')
  requireCheck('tls_validated', health.sealed === false)
  const wrongNameRefused = await new Promise((accept) => {
    const req = request(
      base + 'sys/health',
      { ca, servername: 'not-the-vault-fixture.invalid', timeout: 5000 },
      (res) => {
        res.resume()
        accept(false)
      },
    )
    req.on('error', () => accept(true))
    req.on('timeout', () => req.destroy())
    req.end()
  })
  requireCheck('tls_wrong_server_name_refused', wrongNameRefused)
  const trustedCA = ca
  ca = undefined
  try {
    await call('sys/health')
    throw new Error('Untrusted TLS unexpectedly accepted')
  } catch (error) {
    requireCheck('tls_unknown_ca_refused', error.message === 'Vault TLS connection failed')
  } finally {
    ca = trustedCA
  }
  const mounts = await call('sys/mounts', undefined, admin)
  if (!mounts['transit/']) await call('sys/mounts/transit', { type: 'transit' }, admin, 204)
  const auth = await call('sys/auth', undefined, admin)
  if (!auth['approle/']) await call('sys/auth/approle', { type: 'approle' }, admin, 204)
  await call(
    'transit/keys/nexus-provider-v1',
    { type: 'aes256-gcm96', derived: true, exportable: false, allow_plaintext_backup: false },
    admin,
  )
  const contexts = [1, 2].map((v) =>
    Buffer.from(
      JSON.stringify(['nexus.provider-credential.v1', 'fixture-tenant', 'fixture-credential', v, 'fixture-provider']),
    ).toString('base64'),
  )
  const roles = {
    encryptor: 'nexus13-encryptor',
    gateway: 'nexus13-gateway',
    control: 'nexus13-control',
    rotation: 'nexus13-rotation',
  }
  await policy(roles.rotation, 'path "transit/keys/nexus-provider-v1/rotate" { capabilities=["update"] }')
  await policy(
    roles.encryptor,
    `path "transit/encrypt/nexus-provider-v1" { capabilities=["update"] required_parameters=["context","plaintext"] allowed_parameters={ "context"=${JSON.stringify(contexts)} "plaintext"=[] } }`,
  )
  await policy(
    roles.gateway,
    `path "transit/decrypt/nexus-provider-v1" { capabilities=["update"] required_parameters=["context","ciphertext"] allowed_parameters={ "context"=${JSON.stringify(contexts)} "ciphertext"=[] } }`,
  )
  await policy(
    roles.control,
    'path "transit/*" { capabilities=["deny"] }\npath "auth/token/*" { capabilities=["deny"] }\npath "auth/approle/role/*" { capabilities=["deny"] }\npath "sys/*" { capabilities=["deny"] }',
  )
  for (const role of Object.values(roles))
    await call(
      `auth/approle/role/${role}`,
      {
        token_policies: [role],
        token_no_default_policy: true,
        secret_id_num_uses: 1,
        secret_id_ttl: '60s',
        token_ttl: '30m',
        token_max_ttl: '30m',
        token_explicit_max_ttl: '30m',
        token_num_uses: 0,
      },
      admin,
      204,
    )
  const tokens = {}
  for (const [name, role] of Object.entries(roles)) {
    tokens[name] = await login(role)
    await writeFile(resolve(identity, `${name}-token`), tokens[name], { mode: 0o600 })
  }
  const directGateway = tokens.gateway
  tokens.gateway = await agentLogin(roles.gateway)
  requireCheck('agent_uses_distinct_approle_token', tokens.gateway !== directGateway && tokens.gateway !== admin)
  await writeFile(resolve(identity, 'gateway-token'), tokens.gateway, { mode: 0o600 })
  requireCheck(
    'distinct_approle_workload_tokens',
    new Set(Object.values(tokens)).size === Object.keys(roles).length && !Object.values(tokens).includes(admin),
  )
  const canary = randomBytes(32),
    plaintext = canary.toString('base64'),
    context = contexts[0]
  const encrypted = (await call('transit/encrypt/nexus-provider-v1', { plaintext, context }, tokens.encryptor)).data
    .ciphertext
  const decoded = (await call('transit/decrypt/nexus-provider-v1', { ciphertext: encrypted, context }, tokens.gateway))
    .data.plaintext
  requireCheck('gateway_decrypt_canary_matches', timingSafeEqual(Buffer.from(decoded, 'base64'), canary))
  for (const [name, path, body, token] of [
    [
      'encryptor_decrypt_denied',
      'transit/decrypt/nexus-provider-v1',
      { ciphertext: encrypted, context },
      tokens.encryptor,
    ],
    ['gateway_encrypt_denied', 'transit/encrypt/nexus-provider-v1', { plaintext, context }, tokens.gateway],
    ['gateway_export_denied', 'transit/export/encryption-key/nexus-provider-v1', undefined, tokens.gateway],
    ['gateway_rotate_denied', 'transit/keys/nexus-provider-v1/rotate', {}, tokens.gateway],
    [
      'rotation_decrypt_denied',
      'transit/decrypt/nexus-provider-v1',
      { ciphertext: encrypted, context },
      tokens.rotation,
    ],
    ['rotation_identity_mint_denied', 'auth/token/create', {}, tokens.rotation],
    ['encryptor_identity_mint_denied', 'auth/token/create', { policies: [roles.gateway] }, tokens.encryptor],
    ['gateway_identity_mint_denied', `auth/approle/role/${roles.gateway}/secret-id`, {}, tokens.gateway],
    [
      'wrong_context_denied',
      'transit/decrypt/nexus-provider-v1',
      { ciphertext: encrypted, context: Buffer.from('wrong').toString('base64') },
      tokens.gateway,
    ],
    ['missing_context_denied', 'transit/decrypt/nexus-provider-v1', { ciphertext: encrypted }, tokens.gateway],
    [
      'batch_bypass_denied',
      'transit/decrypt/nexus-provider-v1',
      { ciphertext: encrypted, context, batch_input: [{ ciphertext: encrypted, context }] },
      tokens.gateway,
    ],
    ['control_decrypt_denied', 'transit/decrypt/nexus-provider-v1', { ciphertext: encrypted, context }, tokens.control],
    ['control_encrypt_denied', 'transit/encrypt/nexus-provider-v1', { plaintext, context }, tokens.control],
    ['control_key_read_denied', 'transit/keys/nexus-provider-v1', undefined, tokens.control],
    ['control_token_mint_denied', 'auth/token/create', { policies: [roles.gateway] }, tokens.control],
    ['control_secret_id_mint_denied', `auth/approle/role/${roles.gateway}/secret-id`, {}, tokens.control],
    ['control_role_id_read_denied', `auth/approle/role/${roles.gateway}/role-id`, undefined, tokens.control],
    [
      'control_policy_mutation_denied',
      `sys/policies/acl/${roles.gateway}`,
      { policy: 'path "*" { capabilities=["sudo"] }' },
      tokens.control,
    ],
  ]) {
    await call(path, body, token, 403)
    checks[name] = 'passed'
  }
  await call('transit/decrypt/nexus-provider-v1', { ciphertext: encrypted, context: contexts[1] }, tokens.gateway, 400)
  checks.allowed_context_swap_crypto_rejected = 'passed'
  await call('transit/keys/nexus-provider-v1/rotate', {}, tokens.rotation)
  checks.rotation_uses_independent_approle = 'passed'
  await call('auth/token/revoke', { token: tokens.rotation }, admin, 204)
  await call('transit/keys/nexus-provider-v1/rotate', {}, tokens.rotation, 403)
  checks.rotation_token_revoked_after_operation = 'passed'
  const after = (await call('transit/decrypt/nexus-provider-v1', { ciphertext: encrypted, context }, tokens.gateway))
    .data.plaintext
  requireCheck('rotation_preserves_old_ciphertext', timingSafeEqual(Buffer.from(after, 'base64'), canary))
  const fresh = (await call('transit/encrypt/nexus-provider-v1', { plaintext, context: contexts[1] }, tokens.encryptor))
    .data.ciphertext
  requireCheck('rotation_new_version_used', fresh.split(':')[1] !== encrypted.split(':')[1])
  requireCheck(
    'rotation_new_ciphertext_decrypts',
    (await call('transit/decrypt/nexus-provider-v1', { ciphertext: fresh, context: contexts[1] }, tokens.gateway)).data
      .plaintext === plaintext,
  )
  const revoked = await login(roles.gateway)
  await call('auth/token/revoke', { token: revoked }, admin, 204)
  await call('transit/decrypt/nexus-provider-v1', { ciphertext: encrypted, context }, revoked, 403)
  checks.revoked_gateway_token_denied = 'passed'
  const noMount = JSON.parse(command('docker', ['inspect', container]))[0]
  requireCheck('vault_no_docker_socket_mount', !noMount.Mounts.some((m) => m.Destination.includes('docker.sock')))
  // Separate unprivileged CP execution has neither the private identity bind nor host/Docker capabilities.
  const cpOutput = command('docker', [
    'run',
    '--rm',
    '--read-only',
    '--network',
    'none',
    '--cap-drop=ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '65534:65534',
    '--entrypoint',
    'sh',
    image,
    '-c',
    'test ! -e /run/identity/gateway-token && test ! -e /var/run/docker.sock && test ! -e /fixture/admin-secrets.json && echo isolated',
  ])
  requireCheck('isolated_cp_identity_mount_absent', cpOutput.trim() === 'isolated')
  const logs = command('docker', ['logs', container])
  requireCheck(
    'vault_logs_no_canary_or_tokens',
    [plaintext, canary.toString('hex'), ...Object.values(tokens), admin].every((secret) => !logs.includes(secret)),
  )
  canary.fill(0)
  const receipt = {
    format: 'nexus.secret-plane.fixture.v1',
    recordedAt: new Date().toISOString(),
    revision: command('git', ['rev-parse', 'HEAD']).trim(),
    vaultVersion: health.version,
    imageDigest: image.split('@')[1],
    listener: 'TLS verified loopback:58201',
    principals: Object.values(roles),
    policyDigests,
    checks,
    checksPassed: Object.keys(checks).length,
    limitations: [
      'Disposable single-node manual-unseal fixture; not HA/production deployment acceptance',
      'Host operator controls Docker and ignored identity files; host root is outside CP containment claim',
      'Token files copied into ignored host fixture for separate Go/intake tests; no production identity delivery claim',
      'Actual Vault Agent bootstrap/private tmpfs sink proven; long-duration renewal and operator reissuance after bounded token expiry not measured',
      'No browser/provider canary or registry/cache/revocation timing claim; separate runtime tests required',
    ],
  }
  await writeFile(resolve(root, 'approle-tls-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt, null, 2))
}
main().catch((error) => {
  const exit = Number.isInteger(error.status) ? ` (exit ${error.status})` : ''
  console.error(
    `Secret Plane fixture failed at ${stage}${exit}: ${error.message.startsWith('Unexpected Vault status') ? error.message : 'check or prerequisite failed; sensitive diagnostic output suppressed'}`,
  )
  process.exitCode = 1
})
