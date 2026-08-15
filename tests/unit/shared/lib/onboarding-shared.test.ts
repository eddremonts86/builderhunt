import { describe, expect, it } from 'vitest'
import {
  SEARCH_STEP_COPY,
  STARTER_QUERIES,
  STARTER_QUERIES_BY_PRESET,
  searchStepCopyFor,
  starterQueriesFor,
  successStepCopyFor,
} from '~/shared/lib/onboarding-shared'
import { ONBOARDING_PRESETS } from '~/shared/lib/onboarding-v2'

/**
 * The per-route copy and queries.
 *
 * The phase README names the failure mode this has to avoid: personalisation that changes titles
 * rather than workflow. So what is pinned here is that the routes differ in *what they suggest
 * looking for*, that every route is complete, and that anything unexpected lands on the general
 * flow rather than on an empty step.
 */

describe('every route is complete', () => {
  it.each(ONBOARDING_PRESETS)('%s has copy and five starter queries', (preset) => {
    const queries = starterQueriesFor(preset)
    // Five because the step renders them as chips and the layout is built for that count — a route
    // with three would look unfinished beside one with five, and read as a bug rather than a choice.
    expect(queries).toHaveLength(5)
    expect(new Set(queries).size).toBe(5)

    const copy = searchStepCopyFor(preset)
    expect(copy.heading.endsWith('?') || copy.heading.length > 0).toBe(true)
    expect(copy.body.length).toBeGreaterThan(20)
  })

  it('covers exactly the presets the machine knows, with no extras', () => {
    expect(Object.keys(STARTER_QUERIES_BY_PRESET).sort()).toEqual([...ONBOARDING_PRESETS].sort())
    expect(Object.keys(SEARCH_STEP_COPY).sort()).toEqual([...ONBOARDING_PRESETS].sort())
  })
})

describe('the routes actually differ', () => {
  /**
   * If `hiring` and `investing` suggested the same searches, the segmentation would be a change of
   * heading — exactly what the phase forbids.
   */
  it('gives hiring, investing and building different queries', () => {
    const hiring = starterQueriesFor('hiring')
    const investing = starterQueriesFor('investing')
    expect(hiring).not.toEqual(investing)
    expect(hiring.some((q) => /open to work|contract|founding/i.test(q))).toBe(true)
    expect(investing.some((q) => /traction|startups|production/i.test(q))).toBe(true)
  })

  it('gives each route its own heading', () => {
    const headings = new Set(ONBOARDING_PRESETS.map((preset) => searchStepCopyFor(preset).heading))
    // `general` and `other` share one deliberately — `other` *is* the general experience.
    expect(headings.size).toBe(ONBOARDING_PRESETS.length - 1)
    expect(searchStepCopyFor('other')).toEqual(searchStepCopyFor('general'))
  })

  /** The v1 list is still what the general route uses; nobody's experience changed by default. */
  it('leaves the general route on the original queries', () => {
    expect(starterQueriesFor('general')).toEqual(STARTER_QUERIES)
  })
})

/**
 * The last screen (plan: phase-2/03-onboarding-segmentado).
 *
 * It used to tell everybody their radar was live, including somebody who had just claimed a profile
 * and never saved a search. What is pinned here is that each route ends somewhere it can honestly
 * end, and that none of them promises an outcome the product does not produce.
 */
describe('the success step', () => {
  it.each(ONBOARDING_PRESETS)('%s has a heading, a body and a concrete next action', (preset) => {
    const copy = successStepCopyFor(preset)
    expect(copy.heading.length).toBeGreaterThan(0)
    expect(copy.body.length).toBeGreaterThan(20)
    expect(copy.next.length).toBeGreaterThanOrEqual(2)
    expect(copy.primary.to).not.toBe(copy.secondary.to)
  })

  it('sends each route somewhere that matches what they just did', () => {
    expect(successStepCopyFor('building').primary.to).toBe('/me')
    expect(successStepCopyFor('investing').primary.to).toBe('/alerts')
    expect(successStepCopyFor('hiring').primary.to).toBe('/dashboard')
    expect(successStepCopyFor('general')).toEqual(successStepCopyFor('other'))
  })

  /**
   * The spec forbids fabricating visits or opportunities, and forbids "deal flow" until the product
   * models investment. A promise is the easiest thing to add to a success screen and the hardest to
   * notice afterwards, so it is asserted rather than reviewed.
   */
  it('promises no outcome the product does not produce', () => {
    const forbidden = /deal ?flow|opportunit|recruiters will|profile views|get noticed|guarantee/i
    for (const preset of ONBOARDING_PRESETS) {
      const copy = successStepCopyFor(preset)
      const prose = [copy.heading, copy.body, ...copy.next].join(' ')
      expect(prose, preset).not.toMatch(forbidden)
    }
  })
})

describe('anything unexpected falls back', () => {
  /**
   * The step reads its preset from an HTTP response. A value that is not a preset — an older
   * server, a truncated payload — must render the general flow rather than an empty step.
   */
  it('returns the general route for a value that is not a preset', () => {
    const unknown = 'recruiter' as never
    expect(starterQueriesFor(unknown)).toEqual(STARTER_QUERIES)
    expect(searchStepCopyFor(unknown)).toEqual(SEARCH_STEP_COPY.general)
  })
})
