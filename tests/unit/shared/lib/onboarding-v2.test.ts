import { describe, expect, it } from 'vitest'
import {
  activationReached,
  activationTypesFor,
  firstStep,
  flowFor,
  isValidTransition,
  nextStep,
  ONBOARDING_FLOW_VERSION,
  ONBOARDING_PRESETS,
  resumeStep,
  stepBelongsTo,
  type OnboardingStepKey,
} from '~/shared/lib/onboarding-v2'
import type { SegmentPreset } from '~/shared/lib/user-segments'

/**
 * The machine that replaces v1's `0..3`.
 *
 * v1 stored a number the client asked to increment. With one path that is fine; with four it is a
 * way to reach a step that is not yours and — worse — to report an activation you did not earn.
 * Most of what is pinned here is a refusal.
 */

const noEvidence = { trackedBuilders: 0, sourcingSprints: 0, savedSearchesWithAlert: 0, builderClaims: 0 }

describe('every preset is a complete route', () => {
  it.each(ONBOARDING_PRESETS)('%s starts at welcome and ends at done', (preset) => {
    const flow = flowFor(preset)
    expect(flow[0]).toBe('welcome')
    expect(flow[flow.length - 1]).toBe('done')
    expect(firstStep(preset)).toBe('welcome')
  })

  /** A fifth segment cannot land without a flow and an activation rule; this is what would catch it. */
  it.each(ONBOARDING_PRESETS)('%s has at least one activation type', (preset) => {
    expect(activationTypesFor(preset).length).toBeGreaterThan(0)
  })

  it('asks everybody their goal before branching', () => {
    for (const preset of ONBOARDING_PRESETS) {
      expect(flowFor(preset)[1]).toBe('goal')
    }
  })

  /**
   * `other` and "never answered" get the search-first flow v1 already had. The spec is explicit that
   * onboarding never blocks the dashboard, so no segment has to be a route rather than a gap.
   */
  it('gives `other` and `general` the same general route', () => {
    expect(flowFor('other')).toEqual(flowFor('general'))
    expect(flowFor('general')).toContain('general_search')
  })
})

describe('transitions', () => {
  it('walks each route forward, one step at a time', () => {
    for (const preset of ONBOARDING_PRESETS) {
      const flow = flowFor(preset)
      for (let i = 0; i < flow.length - 1; i += 1) {
        expect(isValidTransition(preset, flow[i], flow[i + 1])).toBe(true)
      }
    }
  })

  /** Skipping a step is how an activation gets reported for work nobody did. */
  it('refuses a jump of two', () => {
    expect(isValidTransition('hiring', 'welcome', 'hiring_criteria')).toBe(false)
    expect(isValidTransition('hiring', 'goal', 'hiring_search')).toBe(false)
  })

  /** `resume` handles returning; allowing backwards here would let a client rewind to re-fire events. */
  it('refuses going backwards', () => {
    expect(isValidTransition('hiring', 'hiring_search', 'hiring_criteria')).toBe(false)
    expect(isValidTransition('hiring', 'goal', 'welcome')).toBe(false)
  })

  it('has nothing after done', () => {
    for (const preset of ONBOARDING_PRESETS) {
      expect(nextStep(preset, 'done')).toBeNull()
    }
  })

  /** The check that keeps a client off another segment's route. */
  it('refuses a step from a different flow', () => {
    expect(isValidTransition('hiring', 'goal', 'investing_thesis')).toBe(false)
    expect(stepBelongsTo('hiring', 'investing_thesis')).toBe(false)
    expect(stepBelongsTo('investing', 'investing_thesis')).toBe(true)
    expect(nextStep('hiring', 'building_claim')).toBeNull()
  })
})

describe('resuming', () => {
  it('returns somebody to where they were', () => {
    expect(resumeStep('hiring', 'hiring_search')).toBe('hiring_search')
  })

  it('starts them over when they have never begun', () => {
    expect(resumeStep('hiring', null)).toBe('welcome')
  })

  /**
   * Somebody may change their segment halfway through. Restarting them on the route they now belong
   * to is the honest answer — stranding them on a step their flow does not contain would be a page
   * that cannot render, and throwing would be a crash on return.
   */
  it('restarts them when their stored step belongs to a flow they left', () => {
    expect(resumeStep('investing', 'hiring_search' as OnboardingStepKey)).toBe('welcome')
  })
})

describe('activation', () => {
  /**
   * The point of the whole plan. v1 counted a finished flow as an activated user, so its activation
   * rate described the flow rather than the product — somebody could click every screen and have
   * done nothing.
   */
  it('is not reached by walking to the end of the flow', () => {
    for (const preset of ONBOARDING_PRESETS) {
      expect(activationReached(preset, noEvidence)).toBeNull()
    }
  })

  it('hiring activates on three tracked builders, not one', () => {
    expect(activationReached('hiring', { ...noEvidence, trackedBuilders: 2 })).toBeNull()
    expect(activationReached('hiring', { ...noEvidence, trackedBuilders: 3 })).toBe('tracked_builders')
  })

  it('hiring also activates on a first sourcing sprint', () => {
    expect(activationReached('hiring', { ...noEvidence, sourcingSprints: 1 })).toBe('sourcing_sprint')
  })

  it('investing activates on a saved search with an alert', () => {
    expect(activationReached('investing', { ...noEvidence, savedSearchesWithAlert: 1 })).toBe('saved_search_alert')
    // Tracked builders are not investing activation — the routes measure different things.
    expect(activationReached('investing', { ...noEvidence, trackedBuilders: 10 })).toBeNull()
  })

  it('building activates on a claim', () => {
    expect(activationReached('building', { ...noEvidence, builderClaims: 1 })).toBe('builder_claim')
    expect(activationReached('building', { ...noEvidence, trackedBuilders: 10 })).toBeNull()
  })

  /**
   * Returns the type rather than a boolean, so the caller records *what* happened. Two people can be
   * activated for different reasons, and a rate that cannot tell them apart cannot say which route
   * is working.
   */
  it('names which kind of activation was reached', () => {
    const both = { ...noEvidence, trackedBuilders: 5, sourcingSprints: 1 }
    expect(activationReached('hiring', both)).toBe('tracked_builders')
    expect(activationTypesFor('hiring')).toEqual(['tracked_builders', 'sourcing_sprint'])
  })
})

describe('the flow version', () => {
  it('is 2, and is what tells a stored row which machine wrote it', () => {
    expect(ONBOARDING_FLOW_VERSION).toBe(2)
  })
})

describe('presets cover the taxonomy', () => {
  it('is general plus every segment, and nothing else', () => {
    const expected: SegmentPreset[] = ['general', 'hiring', 'investing', 'building', 'other']
    expect([...ONBOARDING_PRESETS].sort()).toEqual(expected.sort())
  })
})
