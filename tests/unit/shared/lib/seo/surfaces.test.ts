import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DIRECTIVES,
  isHiddenFromSitemap,
  isSeoSurface,
  robotsMetaContent,
  robotsMetaTag,
  SEO_SURFACES,
  SEO_SURFACE_DEFINITIONS,
} from '~/shared/lib/seo/surfaces'

describe('the surface registry', () => {
  it('defines the three admin-toggleable content surfaces', () => {
    expect([...SEO_SURFACES]).toEqual(['blog', 'changelog', 'roadmap'])
  })

  it('gives every surface a definition with a label, a scope note and at least one path', () => {
    for (const surface of SEO_SURFACES) {
      const definition = SEO_SURFACE_DEFINITIONS[surface]
      expect(definition.surface).toBe(surface)
      expect(definition.label.length).toBeGreaterThan(0)
      expect(definition.scope.length).toBeGreaterThan(0)
      expect(definition.paths.length).toBeGreaterThan(0)
      // robots.txt writes these verbatim; a path without a leading slash would
      // silently match nothing.
      for (const path of definition.paths) expect(path.startsWith('/')).toBe(true)
    }
  })

  it('rejects anything that is not a known surface', () => {
    expect(isSeoSurface('blog')).toBe(true)
    expect(isSeoSurface('pricing')).toBe(false)
    expect(isSeoSurface(undefined)).toBe(false)
    expect(isSeoSurface(42)).toBe(false)
  })
})

describe('the default directives', () => {
  it('launches indexable — blog, changelog, roadmap are all index, follow by default', () => {
    // Decision (plan 45, 2026-07-30): the surfaces in this registry are public
    // marketing/product pages whose product-spec default is "indexable". A
    // noindex default would silently defeat plan 46 (content-marketing) and
    // the public roadmap feature. The full rationale is in the constant's
    // docstring and in `docs/operations/seo-surfaces-indexing.md`.
    expect(DEFAULT_DIRECTIVES).toEqual({ noindex: false, nofollow: false })
  })
})

describe('robotsMetaContent', () => {
  it('joins the directives that are set', () => {
    expect(robotsMetaContent({ noindex: true, nofollow: true })).toBe('noindex, nofollow')
    expect(robotsMetaContent({ noindex: true, nofollow: false })).toBe('noindex')
    expect(robotsMetaContent({ noindex: false, nofollow: true })).toBe('nofollow')
  })

  it('returns null when nothing needs saying', () => {
    // No robots tag is the same instruction as `index, follow`, and emitting the
    // positive form would flatten the root route's richer max-preview values.
    expect(robotsMetaContent({ noindex: false, nofollow: false })).toBeNull()
  })
})

describe('robotsMetaTag', () => {
  it('overrides googlebot as well as robots', () => {
    // __root.tsx sets `googlebot: index, follow`, and Google honours its own
    // named tag over the generic one — overriding only `robots` would leave the
    // crawler that matters most still indexing the page.
    expect(robotsMetaTag({ noindex: true, nofollow: true })).toEqual([
      { name: 'robots', content: 'noindex, nofollow' },
      { name: 'googlebot', content: 'noindex, nofollow' },
    ])
  })

  it('emits nothing for an indexable surface, leaving the root directives intact', () => {
    expect(robotsMetaTag({ noindex: false, nofollow: false })).toEqual([])
  })

  it('carries a nofollow-only surface through to both tags', () => {
    expect(robotsMetaTag({ noindex: false, nofollow: true })).toEqual([
      { name: 'robots', content: 'nofollow' },
      { name: 'googlebot', content: 'nofollow' },
    ])
  })
})

describe('sitemap membership', () => {
  it('is governed by noindex alone', () => {
    expect(isHiddenFromSitemap({ noindex: true, nofollow: false })).toBe(true)
    expect(isHiddenFromSitemap({ noindex: true, nofollow: true })).toBe(true)
    // A nofollow-but-indexable page is still a page we want crawled and listed;
    // dropping it from the sitemap would be a second, unasked-for restriction.
    expect(isHiddenFromSitemap({ noindex: false, nofollow: true })).toBe(false)
    expect(isHiddenFromSitemap({ noindex: false, nofollow: false })).toBe(false)
  })
})
