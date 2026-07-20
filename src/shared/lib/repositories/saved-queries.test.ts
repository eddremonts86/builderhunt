import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('saved query tenant boundary', () => {
  it('requires a tenant principal and transaction-scoped repository', async () => {
    const source = await readFile('src/routes/api/queries/index.ts', 'utf8')

    expect(source).not.toContain("~/shared/lib/db/index")
    expect(source).not.toContain("~/shared/lib/db/schema")
    expect(source).toContain('requireTenantPrincipal')
    expect(source).toContain('withTenantContext')
    expect(source).toContain('executeTenantRead')
    expect(source).toContain('recordMigrationMismatch')
    expect(source).toContain("~/shared/lib/repositories/saved-queries")
    expect(source).not.toContain('organizationId } = body')
  })
})
