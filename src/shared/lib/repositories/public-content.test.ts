import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const publicRoutes = [
  'src/routes/api/incidents/index.ts',
  'src/routes/api/changelog/index.ts',
  'src/routes/api/changelog/$slug.ts',
  'src/routes/api/roadmap/index.ts',
]

describe('public repository boundaries', () => {
  it.each(publicRoutes)('%s does not access the global database directly', async (path) => {
    const source = await readFile(path, 'utf8')

    expect(source).not.toContain("~/shared/lib/db/index")
    expect(source).not.toContain("~/shared/lib/db/schema")
    expect(source).toContain("~/shared/lib/repositories/public-content")
  })
})
