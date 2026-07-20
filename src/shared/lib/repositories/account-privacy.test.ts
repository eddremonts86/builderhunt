import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const accountRoutes = [
  'src/routes/api/consent/index.ts',
  'src/routes/api/me/data-export/index.ts',
  'src/routes/api/me/data-export/$id.ts',
  'src/routes/api/me/plan-changes/index.ts',
  'src/shared/lib/legal.ts',
]

describe('account privacy repository boundary', () => {
  it.each(accountRoutes)('%s does not access database tables directly', async (path) => {
    const source = await readFile(path, 'utf8')
    expect(source).not.toContain("~/shared/lib/db/index")
    expect(source).not.toContain("~/shared/lib/db/schema")
    expect(source).toContain("~/shared/lib/repositories/account-privacy")
  })
})
