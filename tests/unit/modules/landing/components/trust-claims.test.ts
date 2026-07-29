import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Regression guard for plans/phase-1/52-audit-trust: every one of these was a
 * real, live claim on the landing page that didn't match runtime behavior
 * (a fabricated JSON-LD rating, an invented user quote, unverifiable scale
 * numbers, a submit-less email form, and copy describing a user-suppliable
 * GitHub token that no UI anywhere lets a user supply). Source-level checks
 * so a future edit can't silently reintroduce any of them without a reviewer
 * noticing the failing test.
 */
const HOME_PAGE = readFileSync(
  join(process.cwd(), 'src/modules/landing/components/HomePage.tsx'),
  'utf8',
)
const FAQ_SECTION = readFileSync(
  join(process.cwd(), 'src/modules/landing/components/FAQSection.tsx'),
  'utf8',
)
const ROOT_ROUTE = readFileSync(join(process.cwd(), 'src/routes/__root.tsx'), 'utf8')

describe('landing page never republishes unsupported trust claims', () => {
  it('root JSON-LD has no aggregateRating (no review corpus exists to back one)', () => {
    expect(ROOT_ROUTE).not.toContain('aggregateRating')
  })

  it('HomePage has no fabricated testimonial or star rating', () => {
    expect(HOME_PAGE).not.toMatch(/paid for itself/i)
    expect(HOME_PAGE).not.toMatch(/beta user/i)
    expect(HOME_PAGE).not.toMatch(/5 out of 5 stars/i)
  })

  it('HomePage has no dead email-capture form', () => {
    expect(HOME_PAGE).not.toMatch(/join alerts/i)
    expect(HOME_PAGE).not.toMatch(/newsletter email input/i)
  })

  it('HomePage has no unverifiable scale numbers for source platforms', () => {
    expect(HOME_PAGE).not.toMatch(/\d+M\+/)
    expect(HOME_PAGE).not.toMatch(/\d+K\+ dev/i)
    expect(HOME_PAGE).not.toMatch(/\+128 stars/)
  })

  it('HomePage and FAQSection never describe a user-suppliable GitHub token', () => {
    for (const source of [HOME_PAGE, FAQ_SECTION]) {
      expect(source).not.toMatch(/personal access token/i)
      expect(source).not.toMatch(/add a github token/i)
    }
  })
})
