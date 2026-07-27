import { access, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('landing layout', () => {
  it('reserves space for the floating header on landing subpages', async () => {
    const source = await readFile('src/routes/_landing/route.tsx', 'utf8')

    expect(source).toContain("location.pathname === '/' ? '' : 'pt-20'")
  })

  it('owns the public changelog routes', async () => {
    await expect(access('src/routes/_landing/changelog.tsx')).resolves.toBeUndefined()
    await expect(access('src/routes/_landing/changelog/index.tsx')).resolves.toBeUndefined()
    await expect(access('src/routes/_landing/changelog/$slug.tsx')).resolves.toBeUndefined()
  })
})
