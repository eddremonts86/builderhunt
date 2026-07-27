import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

/**
 * Boundary assertions, matching the convention in `public-content.test.ts` and
 * `platform-content.test.ts`: the routes must go through the repository rather
 * than reaching for a database client or the schema themselves.
 *
 * The behaviour these routes produce is covered end to end in
 * `tests/e2e/seo-indexing.spec.ts` against a real database — a robots directive
 * is only meaningful in a real server-rendered response, which a unit test
 * cannot produce.
 */

const routes = [
  'src/routes/api/admin/seo/index.ts',
  'src/routes/robots[.]txt.ts',
  'src/routes/sitemap[.]xml.ts',
]

describe('surface indexing repository boundary', () => {
  it.each(routes)('%s does not touch the database or schema directly', async (path) => {
    const source = await readFile(path, 'utf8')
    expect(source).not.toContain('~/shared/lib/db/schema')
    expect(source).toContain('~/shared/lib/repositories/public-surface-indexing')
  })

  it('the admin route validates the surface against the registry, never a bare string', async () => {
    const source = await readFile('src/routes/api/admin/seo/index.ts', 'utf8')
    // `z.enum(SEO_SURFACES)` — a `z.string()` here would let an admin create a
    // row for a surface nothing reads, implying a setting that does not exist.
    expect(source).toContain('z.enum(SEO_SURFACES)')
    expect(source).toContain('requirePlatformAdminPrincipal')
    expect(source).toContain('auditPlatformAdminAction')
  })

  it('every governed public route emits the robots tag from the shared helper', async () => {
    // Hand-writing `{ name: 'robots' }` in a route would skip the googlebot
    // override that makes the directive effective for Google.
    const governed = [
      'src/routes/_landing/blog/index.tsx',
      'src/routes/_landing/blog/$slug.tsx',
      'src/routes/_landing/changelog/index.tsx',
      'src/routes/_landing/changelog/$slug.tsx',
      'src/routes/_landing/roadmap.tsx',
    ]
    for (const path of governed) {
      const source = await readFile(path, 'utf8')
      expect(source, path).toContain('robotsMetaTag')
      expect(source, path).toContain('getSurfaceRobotsFn')
    }
  })
})
