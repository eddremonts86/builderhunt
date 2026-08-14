import { describe, expect, it } from 'vitest'
import {
  legacyStepFor,
  onboardingActionSchema,
  onboardingStatusV2Schema,
  REJECTED_ONBOARDING_FIELDS,
} from '~/shared/lib/onboarding-api'
import { ONBOARDING_FLOW_VERSION, flowFor } from '~/shared/lib/onboarding-v2'

/**
 * The versioned wire contract.
 *
 * The refusals matter more than the acceptances here: a body that could name a segment or a user
 * would be a second source of truth for who is being onboarded and as what, and the server would
 * have to remember to ignore it on every path, forever.
 */

describe('actions', () => {
  it('accepts the three verbs', () => {
    expect(onboardingActionSchema.safeParse({ action: 'advance', from: 'welcome' }).success).toBe(true)
    expect(onboardingActionSchema.safeParse({ action: 'skip' }).success).toBe(true)
    expect(onboardingActionSchema.safeParse({ action: 'activate', activationType: 'tracked_builders' }).success).toBe(true)
  })

  /**
   * `advance` names the step being *left*. A body that named the destination would be asking to be
   * placed somewhere, and the only safe response to that is to recompute it anyway.
   */
  it('requires the step being left, and has no field for the destination', () => {
    expect(onboardingActionSchema.safeParse({ action: 'advance' }).success).toBe(false)
    expect(onboardingActionSchema.safeParse({ action: 'advance', to: 'goal' }).success).toBe(false)
    expect(onboardingActionSchema.safeParse({ action: 'advance', from: 'not_a_step' }).success).toBe(false)
  })

  it.each(REJECTED_ONBOARDING_FIELDS)('rejects a body carrying %s', (field) => {
    expect(onboardingActionSchema.safeParse({ action: 'skip', [field]: 'anything' }).success).toBe(false)
    expect(onboardingActionSchema.safeParse({ action: 'advance', from: 'welcome', [field]: 'x' }).success).toBe(false)
  })

  it('constrains the activation type to the enumerated set', () => {
    expect(onboardingActionSchema.safeParse({ action: 'activate', activationType: 'searched_for_rust' }).success).toBe(false)
    expect(onboardingActionSchema.safeParse({ action: 'activate' }).success).toBe(false)
  })

  /** Opaque and bounded — an audit handle, not a place to put a query or a name. */
  it('bounds the optional reference id', () => {
    expect(onboardingActionSchema.safeParse({ action: 'activate', activationType: 'builder_claim', refId: 'c1' }).success).toBe(true)
    expect(onboardingActionSchema.safeParse({ action: 'activate', activationType: 'builder_claim', refId: '' }).success).toBe(false)
    expect(onboardingActionSchema.safeParse({
      action: 'activate', activationType: 'builder_claim', refId: 'x'.repeat(129),
    }).success).toBe(false)
  })
})

describe('the status payload', () => {
  const valid = {
    flowVersion: ONBOARDING_FLOW_VERSION,
    preset: 'hiring' as const,
    flow: [...flowFor('hiring')],
    currentStep: 'hiring_search' as const,
    activationType: null,
    activatedAt: null,
    skipped: false,
    skippedCount: 0,
    eligible: true,
    legacy: { step: 2, completed: false },
  }

  it('validates a complete payload', () => {
    expect(onboardingStatusV2Schema.safeParse(valid).success).toBe(true)
  })

  /**
   * The v1 shape is still answered so a consumer that has not moved keeps working across the
   * rollout — which is the entire reason for versioning rather than replacing.
   */
  it('always carries the legacy reading', () => {
    const { legacy: _legacy, ...withoutLegacy } = valid
    expect(onboardingStatusV2Schema.safeParse(withoutLegacy).success).toBe(false)
  })

  it('pins the version so a v1 client can refuse to guess', () => {
    expect(onboardingStatusV2Schema.safeParse({ ...valid, flowVersion: 1 }).success).toBe(false)
  })

  it('rejects an unknown key', () => {
    expect(onboardingStatusV2Schema.safeParse({ ...valid, userId: 'u1' }).success).toBe(false)
  })
})

describe('legacyStepFor', () => {
  /**
   * v1's `0..3` cannot express four routes, so this maps to the nearest honest v1 meaning rather
   * than inventing a precision the old scale never had.
   */
  it('maps the shared steps the way v1 meant them', () => {
    expect(legacyStepFor('welcome', false)).toBe(0)
    expect(legacyStepFor('goal', false)).toBe(1)
    expect(legacyStepFor('confirmation', false)).toBe(3)
    expect(legacyStepFor('done', false)).toBe(3)
  })

  it('treats every segment-specific action step as v1 step 2', () => {
    for (const step of ['hiring_search', 'investing_discovery', 'building_claim', 'general_search']) {
      expect(legacyStepFor(step, false)).toBe(2)
    }
  })

  it('reports 3 once completed, whatever the key says', () => {
    expect(legacyStepFor('welcome', true)).toBe(3)
  })
})
