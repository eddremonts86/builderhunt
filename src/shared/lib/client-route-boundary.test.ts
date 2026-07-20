import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('client route boundary', () => {
  it('keeps the pricing route free of server-only billing modules', async () => {
    const source = await readFile('src/routes/_landing/pricing.tsx', 'utf8')

    expect(source).not.toContain("import('~/shared/lib/billing')")
    expect(source).not.toContain("from '~/shared/lib/billing'")
  })

  it('keeps the public builder route free of database modules', async () => {
    const source = await readFile('src/routes/builders/$builderId.tsx', 'utf8')

    expect(source).not.toContain("import('~/shared/lib/db/index')")
    expect(source).not.toContain("import('~/shared/lib/db/schema')")
  })

  it('keeps the explore route free of the server-side search implementation', async () => {
    const source = await readFile('src/routes/_landing/explore/index.tsx', 'utf8')

    expect(source).not.toContain("from '~/lib/search'")
  })

  it.each([
    'src/routes/_landing/blog/index.tsx',
    'src/routes/_landing/blog/$slug.tsx',
  ])('keeps %s free of the server-side markdown implementation', async (path) => {
    const source = await readFile(path, 'utf8')

    expect(source).not.toContain("from '~/shared/lib/blog'")
  })
})
