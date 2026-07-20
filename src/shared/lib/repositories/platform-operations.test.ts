import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('platform operations boundary', () => {
  it.each([
    'src/shared/lib/billing.ts',
    'src/routes/api/admin/metrics/index.ts',
    'src/routes/api/admin/plan-requests/index.ts',
  ])('%s does not import the global product database', async (path) => {
    const source = await readFile(path, 'utf8')
    expect(source).not.toContain("~/shared/lib/db/index")
    expect(source).not.toContain("~/shared/lib/db/schema")
  })
})
