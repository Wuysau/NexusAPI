import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('owned access control-plane contracts', () => {
  const schema = readFileSync(join(process.cwd(), 'src/db/schema.ts'), 'utf8')
  const projectsApi = readFileSync(join(process.cwd(), 'src/app/api/projects/route.ts'), 'utf8')
  const connectionsApi = readFileSync(join(process.cwd(), 'src/app/api/connections/[id]/route.ts'), 'utf8')
  const keysApi = readFileSync(join(process.cwd(), 'src/app/api/keys/route.ts'), 'utf8')
  const workspaceAccess = readFileSync(join(process.cwd(), 'src/lib/workspace/management.ts'), 'utf8')
  it('declares tenant scope and project binding for owned entities', () => {
    expect(schema).toContain("'projects'")
    expect(schema).toContain("'owned_connections'")
    expect(schema).toContain("'connector_leases'")
    expect(schema).toContain("'quota_snapshots'")
    expect(schema).toContain("projectId: text('project_id').references(() => projects.id)")
  })
  it('keeps mutating routes tenant-scoped and audited', () => {
    expect(projectsApi).toContain('${projectVisibility}')
    expect(projectsApi).toContain('workspaceParams(ctx)')
    expect(workspaceAccess).toContain('p.tenant_id=$1 AND p.organization_id=$2')
    expect(workspaceAccess).toContain('access.user_id=$3')
    expect(projectsApi).toContain('auditControlPlane')
    expect(connectionsApi).toContain('tenant_id=$2')
    expect(connectionsApi).toContain('connector_leases')
    expect(keysApi).toContain('project_not_found')
  })
  it('does not return credential secret fields from connection API', () => {
    expect(connectionsApi).not.toContain('encryptedSecret')
    expect(connectionsApi).not.toContain('secret')
  })
})
