import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'

const roles = {
  nexus_control: 'DB_CONTROL_PASSWORD',
  nexus_gateway: 'DB_GATEWAY_PASSWORD',
  nexus_worker: 'DB_WORKER_PASSWORD',
  nexus_budget: 'DB_BUDGET_PASSWORD',
}
const passwords = Object.values(roles).map((key) => process.env[key])
if (
  !process.env.DATABASE_ADMIN_URL ||
  passwords.some((value) => !value || value.length < 24) ||
  new Set(passwords).size !== 4
) {
  console.error('Require DATABASE_ADMIN_URL and four distinct workload passwords of at least 24 characters.')
  process.exit(1)
}
const pool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL })
let client
try {
  client = await pool.connect()
  await client.query('BEGIN')
  await client.query(await readFile(new URL('../infra/db-workload-roles.sql', import.meta.url), 'utf8'))
  await client.query(`CREATE FUNCTION pg_temp.set_workload_password(role_name text, secret text) RETURNS void
    LANGUAGE plpgsql AS $$ BEGIN
      IF role_name NOT IN ('nexus_control','nexus_gateway','nexus_worker','nexus_budget') THEN RAISE EXCEPTION 'invalid workload'; END IF;
      EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', role_name, secret);
    END $$`)
  for (const [role, envName] of Object.entries(roles)) {
    await client.query('SELECT pg_temp.set_workload_password($1,$2)', [role, process.env[envName]])
  }
  await client.query('COMMIT')
  console.log('Workload database roles provisioned.')
} catch {
  await client?.query('ROLLBACK').catch(() => {})
  console.error(
    'Workload role provisioning failed; transaction rolled back. Check administrator permissions and schema prerequisites.',
  )
  process.exitCode = 1
} finally {
  client?.release()
  await pool.end()
}
