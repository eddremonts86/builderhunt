import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

async function tsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return tsFiles(path)
    if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.test.tsx')) return [path]
    return []
  }))
  return files.flat()
}

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

  // Full sweep, not a fixed file list: the Stripe secret key lives behind
  // this module (src/shared/lib/billing/stripe-client.ts), and any future
  // route/component file importing it — even transitively via another
  // billing module re-exporting it — would ship the key's *code path* (and
  // risk the key itself, if ever inlined) into the browser bundle.
  it('keeps every route and module component free of the server-only Stripe client', async () => {
    const files = [...await tsFiles('src/routes'), ...await tsFiles('src/modules')]
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      expect(source, `${file} must not import the server-only Stripe client`).not.toMatch(
        /from ['"]~\/shared\/lib\/billing\/stripe-client['"]/,
      )
      expect(source, `${file} must not dynamically import the server-only Stripe client`).not.toMatch(
        /import\(\s*['"]~\/shared\/lib\/billing\/stripe-client['"]\s*\)/,
      )
    }
  })
})
