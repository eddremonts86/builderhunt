import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { globSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { pageMeta } from '~/shared/lib/page-meta'

/**
 * A route that sets a `<title>` must also set the Open Graph and Twitter copies
 * of its title and description.
 *
 * This is a shape test rather than a behaviour test because the failure is
 * invisible at runtime: the page renders, the tab title is right, the
 * `<meta name="description">` is right, and Google reads both. The only broken
 * thing is the *social* preview, which silently inherits the root route's
 * "BuilderHunt — Discover Active Builders Across the Open Web". Nobody notices
 * until a link is pasted somewhere public.
 *
 * Found 2026-08-05 on eleven public routes at once, `/pricing` among them —
 * every shared link previewed as the homepage. Nothing failed, which is exactly
 * why it needs pinning here.
 */

const ROUTES_DIR = resolve(import.meta.dirname, '../../../src/routes')

/**
 * Routes that must NOT carry social previews, with the reason.
 *
 * `schedule/$invitationId` is a candidate's private interview invitation. It is
 * `noindex, nofollow, noarchive` with `referrer: no-referrer` deliberately;
 * giving it og tags would hand the invitation to any chat client that unfurls
 * links. Its title is a fixed string with no candidate data in it.
 */
const NO_PREVIEW_BY_DESIGN = new Map([
  ['schedule/$invitationId.tsx', 'private candidate invitation — noindex/no-referrer on purpose'],
])

function routeFiles(): string[] {
  return globSync('**/*.tsx', { cwd: ROUTES_DIR }).sort()
}

describe('social preview metadata', () => {
  it('finds route files to check (the glob itself must not silently match nothing)', () => {
    expect(routeFiles().length).toBeGreaterThan(50)
  })

  it('every route that sets a title also sets og:title and og:description', () => {
    const offenders: string[] = []

    for (const rel of routeFiles()) {
      const source = readFileSync(resolve(ROUTES_DIR, rel), 'utf8')
      if (!source.includes('head:')) continue
      if (!/\{\s*title:/.test(source)) continue
      if (NO_PREVIEW_BY_DESIGN.has(rel)) continue

      // `pageMeta()` emits the pair; a route may also spell them out directly.
      const viaHelper = source.includes('pageMeta')
      const spelledOut = source.includes('og:title') && source.includes('og:description')
      if (!viaHelper && !spelledOut) offenders.push(rel)
    }

    expect(
      offenders,
      `these routes set a <title> but leave the root route's og:title/og:description in place, so `
      + `sharing their URL previews the homepage. Use pageMeta() from ~/shared/lib/page-meta, or add `
      + `the route to NO_PREVIEW_BY_DESIGN with a reason:\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })

  it('the deliberately-excluded routes still exist and are still noindex', () => {
    // If one of these is ever renamed the allowlist silently stops applying, and
    // the exclusion becomes a hole rather than a decision.
    for (const [rel, reason] of NO_PREVIEW_BY_DESIGN) {
      const source = readFileSync(resolve(ROUTES_DIR, rel), 'utf8')
      expect(source, `${rel} is excluded because: ${reason}`).toContain('noindex')
      expect(source).not.toContain('og:title')
    }
  })
})

describe('pageMeta', () => {
  it('emits the title and description in all four places', () => {
    const meta = pageMeta({ title: 'T', description: 'D' })
    expect(meta).toEqual([
      { title: 'T' },
      { name: 'description', content: 'D' },
      { property: 'og:title', content: 'T' },
      { property: 'og:description', content: 'D' },
      { name: 'twitter:title', content: 'T' },
      { name: 'twitter:description', content: 'D' },
    ])
  })

  it('omits image and url rather than emitting empty tags', () => {
    const keys = pageMeta({ title: 'T', description: 'D' }).flatMap((m) => Object.values(m))
    expect(keys).not.toContain('og:image')
    expect(keys).not.toContain('og:url')
  })

  it('resolves a path against SITE_URL but leaves an absolute URL alone', () => {
    const withPath = pageMeta({ title: 'T', description: 'D', image: '/brand/og.png' })
    const image = withPath.find((m) => m.property === 'og:image')?.content
    expect(image).toMatch(/^https?:\/\/.+\/brand\/og\.png$/)

    const absolute = pageMeta({ title: 'T', description: 'D', image: 'https://cdn.example/x.png' })
    expect(absolute.find((m) => m.property === 'og:image')?.content).toBe('https://cdn.example/x.png')
  })

  it('carries a query string through to og:url — the /explore duplicate-canonical bug', () => {
    const meta = pageMeta({ title: 'T', description: 'D', url: '/explore?q=react' })
    expect(meta.find((m) => m.property === 'og:url')?.content).toMatch(/\/explore\?q=react$/)
  })
})
