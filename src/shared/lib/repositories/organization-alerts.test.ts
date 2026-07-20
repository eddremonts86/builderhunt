import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const tenantSurfaces = [
  'src/routes/api/alerts/index.ts',
  'src/routes/api/alerts/test-trigger.ts',
  'src/routes/api/alerts/triggers/index.ts',
  'src/routes/api/alerts/triggers/$id.ts',
  'src/shared/lib/alerts.ts',
]

describe('organization alerts repository boundary', () => {
  it.each(tenantSurfaces)('%s uses the tenant repository boundary', async (path) => {
    const source = await readFile(path, 'utf8')
    expect(source).not.toContain("~/shared/lib/db/index")
    expect(source).not.toContain("~/shared/lib/db/schema")
    expect(source).toContain("~/shared/lib/repositories/organization-alerts")
  })

  it.each(tenantSurfaces.filter((path) => path.startsWith('src/routes/')))('%s derives tenant context', async (path) => {
    const source = await readFile(path, 'utf8')
    expect(source).toContain('requireTenantPrincipal')
    expect(source).toContain('withTenantContext')
  })

  it('worker uses the dedicated worker repository', async () => {
    const source = await readFile('src/lib/alerts/worker.ts', 'utf8')
    expect(source).not.toContain("~/shared/lib/db/index")
    expect(source).not.toContain("~/shared/lib/db/schema")
    expect(source).toContain("~/shared/lib/repositories/alerts-worker")
  })
})
