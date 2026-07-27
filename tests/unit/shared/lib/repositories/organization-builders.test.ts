import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const tenantBuilderSurfaces = [
  'src/routes/api/builders/recent/index.ts',
  'src/routes/api/builders/track.ts',
  'src/routes/api/builders/$builderId.ts',
  'src/routes/api/builders/$builderId/notes.ts',
  'src/routes/api/me/builders/index.ts',
  'src/routes/api/export/builders.ts',
  'src/routes/api/dashboard/stats.ts',
  'src/shared/lib/tracked-builders.ts',
]

describe('organization builder repository boundary', () => {
  it.each(tenantBuilderSurfaces)('%s does not access database tables directly', async (path) => {
    const source = await readFile(path, 'utf8')
    expect(source).not.toContain("~/shared/lib/db/index")
    expect(source).not.toContain("~/shared/lib/db/schema")
    expect(source).toContain("~/shared/lib/repositories/organization-builders")
  })

  it.each(tenantBuilderSurfaces.filter((path) => path.startsWith('src/routes/')))('%s derives tenant scope server-side', async (path) => {
    const source = await readFile(path, 'utf8')
    if (path === 'src/routes/api/builders/$builderId.ts') {
      expect(source).toContain('requireTenantPrincipal')
      return
    }
    expect(source).toContain('requireTenantPrincipal')
    expect(source).toContain('withTenantContext')
  })
})
