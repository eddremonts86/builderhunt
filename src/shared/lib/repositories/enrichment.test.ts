import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const tenantSurfaces = [
  'src/routes/api/builders/$builderId/evidence-refresh.ts',
  'src/routes/api/builders/$builderId/evidence/index.ts',
  'src/routes/api/builders/$builderId/evidence/$evidenceId.ts',
]

const claimantSurfaces = [
  'src/routes/api/me/builder/$builderId/restrict-processing.ts',
  'src/routes/api/me/builder/$builderId/evidence-provenance.ts',
]

describe('enrichment repository boundary', () => {
  it.each([...tenantSurfaces, ...claimantSurfaces])('%s uses the tenant repository boundary', async (path) => {
    const source = await readFile(path, 'utf8')
    expect(source).not.toContain('~/shared/lib/db/index')
    expect(source).not.toContain('~/shared/lib/db/schema')
    expect(source).toContain('requireTenantPrincipal')
    expect(source).toContain('withTenantContext')
  })

  it.each(claimantSurfaces)('%s checks verified claimant status before acting', async (path) => {
    const source = await readFile(path, 'utf8')
    expect(source).toContain('isVerifiedBuilderClaimant')
  })

  it('the review endpoint restricts to owner/admin roles', async () => {
    const source = await readFile('src/routes/api/builders/$builderId/evidence/$evidenceId.ts', 'utf8')
    expect(source).toMatch(/role !== 'owner' && principal\.role !== 'admin'/)
  })

  it('worker uses the dedicated worker repository, never raw schema', async () => {
    const source = await readFile('src/lib/enrichment/worker.ts', 'utf8')
    expect(source).not.toContain('~/shared/lib/db/index')
    expect(source).not.toContain('~/shared/lib/db/schema')
    expect(source).toContain('~/shared/lib/repositories/enrichment-worker')
  })

  it('the admin run-worker route requires admin auth with no caller-selected target', async () => {
    const source = await readFile('src/routes/api/admin/enrichment/run-worker.ts', 'utf8')
    expect(source).toContain('isAdmin')
    expect(source).not.toContain('params.')
  })
})
