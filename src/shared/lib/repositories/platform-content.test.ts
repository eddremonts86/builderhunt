import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const routes = [
  'src/routes/api/admin/incidents/index.ts',
  'src/routes/api/admin/incidents/$id.ts',
  'src/routes/api/admin/changelog/index.ts',
  'src/routes/api/admin/changelog/$id.ts',
  'src/routes/api/admin/roadmap/index.ts',
  'src/routes/api/admin/roadmap/$id.ts',
]

describe('platform content repository boundary', () => {
  it.each(routes)('%s does not access database tables directly', async (path) => {
    const source = await readFile(path, 'utf8')
    expect(source).not.toContain("~/shared/lib/db/index")
    expect(source).not.toContain("~/shared/lib/db/schema")
    expect(source).toContain("~/shared/lib/repositories/platform-content")
  })
})
