import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  FORBIDDEN_LANDING_CLAIMS,
  SEGMENT_PAGES,
  SEGMENT_PAGE_KEYS,
  segmentPageBySlug,
  segmentPageFor,
} from '~/modules/landing/content/segment-pages'
import { USER_SEGMENTS } from '~/shared/lib/user-segments'

/**
 * The segmented landing content (plan: phase-2/06-landing-segmentada, task 2).
 *
 * A landing page is the one surface where a false statement is never corrected — no empty state
 * qualifies it, no endpoint refuses it, and the person who believed it has already signed up. These
 * tests are the mechanical half of the message matrix: every claim has to name a file that exists,
 * and no page may make a promise the specs forbid by name.
 */

/**
 * What the page *promises*.
 *
 * Deliberately not everything a visitor reads. `limits` and the objection answer exist to say what
 * the product does not do, so they name forbidden things on purpose — "nothing here detects a round"
 * is the opposite of promising funding signals, and the first run of this test flagged it as a
 * violation. Scanning them would train whoever hits it to delete the disclaimer, which is precisely
 * backwards.
 */
function promises(page: (typeof SEGMENT_PAGES)[keyof typeof SEGMENT_PAGES]): string {
  return [
    page.title,
    page.metaDescription,
    page.heading,
    page.subheading,
    ...page.claims.map((claim) => claim.text),
    page.cta.label,
  ].join(' \n ')
}

/** Everything a visitor reads, for the checks that are about copy rather than about promises. */
function prose(page: (typeof SEGMENT_PAGES)[keyof typeof SEGMENT_PAGES]): string {
  return [promises(page), page.objection.question, page.objection.answer, ...page.limits].join(' \n ')
}

describe('every segment with a page has one', () => {
  it('covers hiring, investing and building — and deliberately not `other`', () => {
    expect([...SEGMENT_PAGE_KEYS].sort()).toEqual(['building', 'hiring', 'investing'])
    // `other` is the home page, which is what the rest of the product does with it: the general
    // experience rather than a fourth variant.
    expect(USER_SEGMENTS).toContain('other')
    expect(SEGMENT_PAGE_KEYS as readonly string[]).not.toContain('other')
  })

  it('gives each page a distinct slug and title', () => {
    const pages = Object.values(SEGMENT_PAGES)
    expect(new Set(pages.map((page) => page.slug)).size).toBe(pages.length)
    expect(new Set(pages.map((page) => page.title)).size).toBe(pages.length)
    for (const page of pages) {
      expect(page.slug, page.segment).toMatch(/^[a-z-]+$/)
    }
  })

  it('resolves a page by segment and by slug, and nothing else', () => {
    expect(segmentPageFor('hiring')?.slug).toBe('hiring-teams')
    expect(segmentPageBySlug('investors')?.segment).toBe('investing')
    for (const unknown of [null, undefined, 'other', 'recruiter', '']) {
      expect(segmentPageFor(unknown), String(unknown)).toBeNull()
    }
    expect(segmentPageBySlug('nope')).toBeNull()
  })
})

/**
 * The rule the whole matrix rests on: **every promise links to a feature that exists today, or it is
 * deleted.** Evidence is a path rather than prose so a reviewer can open it — and so this test can.
 */
describe('every claim carries evidence that exists', () => {
  it.each(SEGMENT_PAGE_KEYS)('%s names a real file for every claim', (key) => {
    const page = SEGMENT_PAGES[key]
    expect(page.claims.length).toBeGreaterThanOrEqual(3)

    for (const claim of page.claims) {
      expect(claim.text.length, claim.evidence).toBeGreaterThan(20)
      // A path, not a sentence. "Our search is great" is not evidence of anything.
      expect(claim.evidence, claim.text).toMatch(/^src\/.+\.(ts|tsx)$/)
      expect(existsSync(claim.evidence), `${key}: evidence missing for "${claim.text}"`).toBe(true)
    }
  })

  /** Each page answers the objection its own visitors raise, rather than the easiest one. */
  it.each(SEGMENT_PAGE_KEYS)('%s answers an objection instead of avoiding it', (key) => {
    const page = SEGMENT_PAGES[key]
    expect(page.objection.question).toMatch(/\?$/)
    expect(page.objection.answer.length).toBeGreaterThan(40)
  })

  /**
   * The limits are rendered, not filed as a review note. A caveat that only lives in a comment is a
   * caveat the reader never sees — which makes the page's promise the only thing they read.
   */
  it.each(SEGMENT_PAGE_KEYS)('%s states its own limits', (key) => {
    expect(SEGMENT_PAGES[key].limits.length).toBeGreaterThanOrEqual(2)
    for (const limit of SEGMENT_PAGES[key].limits) {
      expect(limit.length).toBeGreaterThan(30)
    }
  })
})

/**
 * The promises this product would be lying to make. Each is on the list because a spec forbids it by
 * name — "deal flow" until investment is modelled, fabricated visits or opportunities for builders —
 * not because it reads as marketing fluff.
 */
describe('no page makes a forbidden promise', () => {
  it.each(SEGMENT_PAGE_KEYS)('%s is clean', (key) => {
    const text = promises(SEGMENT_PAGES[key])
    for (const { pattern, why } of FORBIDDEN_LANDING_CLAIMS) {
      expect(pattern.test(text), `${key} matches ${pattern} — ${why}`).toBe(false)
    }
  })

  /** The guard has to be able to fire, or it is decoration. */
  it('catches a forbidden promise when one is present', () => {
    const forbidden = 'Our deal flow finds the perfect candidate and recruiters will contact you.'
    const matched = FORBIDDEN_LANDING_CLAIMS.filter(({ pattern }) => pattern.test(forbidden))
    expect(matched.length).toBeGreaterThanOrEqual(3)
  })

  /** Every entry carries the reason it is forbidden, so a future reader can tell rule from taste. */
  it('says why each promise is forbidden', () => {
    for (const entry of FORBIDDEN_LANDING_CLAIMS) {
      expect(entry.why.length, String(entry.pattern)).toBeGreaterThan(10)
    }
  })
})

/**
 * The source count is read from the registry everywhere else, because nine surfaces once claimed
 * "12 sources" for days after two connectors were retired. A landing page written by hand is exactly
 * where that happens again.
 */
describe('nothing hardcodes a number the registry owns', () => {
  /**
   * The copy interpolates `SEARCH_SOURCE_COUNT` rather than writing a number, so this cannot go
   * stale — it is checked anyway because the failure mode is specific and has happened: nine
   * surfaces claimed "12 sources" for days after two connectors were retired, and every one of them
   * was a literal somebody had typed.
   */
  it('states the count the registry states, on every page that states one', async () => {
    const { SEARCH_SOURCE_COUNT } = await import('~/shared/lib/search-connectors')
    const written = Object.values(SEGMENT_PAGES)
      .flatMap((page) => prose(page).match(/\b(\d+)\s+(public\s+)?sources\b/gi) ?? [])

    expect(written.length, 'no page mentions the source count at all').toBeGreaterThan(0)
    for (const found of written) {
      expect(found, 'landing copy states a source count the registry does not').toContain(String(SEARCH_SOURCE_COUNT))
    }
  })
})
