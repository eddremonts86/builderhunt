import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const surfaces = [
  'src/routes/api/builders/$builderId/claim.ts',
  'src/routes/api/builders/claim/verify.ts',
  'src/routes/api/me/builder/index.ts',
  'src/routes/api/me/builder/$builderId.ts',
]

describe('verified builder claim boundary', () => {
  it.each(surfaces)('%s uses hashed normalized claims', async (path) => {
    const source = await readFile(path, 'utf8')
    expect(source).not.toContain("~/shared/lib/db/index")
    expect(source).not.toContain('builderClaimRequests')
    expect(source).toContain("~/shared/lib/repositories/builder-claims")
    expect(source).toContain('requireTenantPrincipal')
    expect(source).toContain('withTenantContext')
  })

  it('never stores or queries a plaintext verification token', async () => {
    const repository = await readFile('src/shared/lib/repositories/builder-claims.ts', 'utf8')
    expect(repository).toContain('verificationSecretHash')
    expect(repository).not.toMatch(/verificationSecret:\s/)
  })
})
