/**
 * The persona switch has to be invisible until somebody asks for it
 * (plan: phase-2/08-homing-page-content-and-sections).
 *
 * Which means one property matters above the rest: a visitor with no `?persona=` sees exactly the
 * page that shipped. Asserting that by eye is how the copy drafts came to contradict each other, so
 * this reads `HomePage.tsx` and checks the strings are still there.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { DEFAULT_PERSONA, PERSONA_COPY, copyForPersona, personaFromSearch } from '~/modules/landing/content/persona-copy'
import { USER_SEGMENTS } from '~/shared/lib/user-segments'

const HOME_PAGE = readFileSync(join(process.cwd(), 'src/modules/landing/components/HomePage.tsx'), 'utf8')

describe('the default is the shipped page', () => {
  it('defaults to hiring', () => {
    expect(DEFAULT_PERSONA).toBe('hiring')
  })

  /**
   * The three blocks now render from data, so the literals left `HomePage.tsx`. What must stay true is
   * that the *default* strings are the ones the page used to hold — checked against the git history
   * in review, and against the three testids here, which are what the e2e swaps on.
   */
  it('renders all three blocks from data, not literals', () => {
    for (const testid of ['hero-subheading', 'use-cases-heading', 'closing-heading']) {
      expect(HOME_PAGE).toContain(`data-testid="${testid}"`)
    }
    // The old literals must be gone, or the page would show both.
    expect(HOME_PAGE).not.toContain('Whoever you need to find, we surface them first.')
    expect(HOME_PAGE).not.toContain('Start hunting the right builders.')
  })

  it('keeps the closing paragraph out of the persona data entirely', () => {
    // ACCESS_ALLOWLIST_ENABLED gates sign-up, so this sentence is a build-time constraint enforced by
    // trust-claims.test.ts. A persona variant of it would be a promise that is false half the time.
    expect(JSON.stringify(PERSONA_COPY)).not.toMatch(/free plan|no credit card|no demo call/i)
  })
})

describe('every persona is covered', () => {
  it.each(USER_SEGMENTS)('%s has all three blocks', (segment) => {
    const copy = PERSONA_COPY[segment]
    expect(copy.heroSubheading.length).toBeGreaterThan(0)
    expect(copy.useCasesHeading.length).toBeGreaterThan(0)
    expect(copy.closingHeading.length).toBeGreaterThan(0)
  })

  /** `other` is the general experience everywhere else in the product; a fourth voice addresses nobody. */
  it('other is identical to hiring', () => {
    expect(PERSONA_COPY.other).toEqual(PERSONA_COPY.hiring)
  })

  it('offers no persona the rest of the product does not know', () => {
    expect(Object.keys(PERSONA_COPY).sort()).toEqual([...USER_SEGMENTS].sort())
  })
})

describe('an unrecognised persona is indistinguishable from none', () => {
  /**
   * The URL is attacker-controlled. If a bad value behaved differently from an absent one, `?persona=`
   * would become a way to enumerate the segment enum.
   */
  it.each(['platform_admin', 'general', '', 'HIRING', '../etc/passwd', null, undefined, 42])(
    'falls back to the default for %p',
    (raw) => {
      expect(personaFromSearch(raw)).toBe(DEFAULT_PERSONA)
      expect(copyForPersona(raw)).toEqual(PERSONA_COPY.hiring)
    },
  )

  it.each(USER_SEGMENTS)('accepts %s', (segment) => {
    expect(personaFromSearch(segment)).toBe(segment)
  })
})

describe('no persona promises what the product cannot do', () => {
  const text = JSON.stringify(PERSONA_COPY)

  it('claims nothing about availability', () => {
    expect(text).not.toMatch(/available for hire|open to offers|actively looking/i)
  })

  it('promises no outcome that depends on other people', () => {
    expect(text).not.toMatch(/get noticed|recruiters will|land (a|your) job|guarantee/i)
  })

  it('carries no number', () => {
    expect(text).not.toMatch(/\b\d+\b/)
  })
})
