/**
 * Onboarding v2 — one framework, four routes through it (plan: phase-2/03-onboarding-segmentado).
 *
 * ## Why the server owns the step
 *
 * v1 stored a number, `0..3`, and the client asked to advance it. That works while there is one
 * path; with four it becomes a way to reach a step that does not belong to your segment — and, worse,
 * a way to report an activation you did not earn. Here the step is a **key**, the valid successor is
 * computed from `(segment, current)`, and `isValidTransition` is the only thing that decides. A
 * client that asks for anything else gets refused rather than obeyed.
 *
 * ## Why `general` is a real flow and not an error path
 *
 * Somebody who picks `other`, or who never answers, gets the search-first flow v1 already had. The
 * spec is explicit that onboarding never blocks the dashboard, so "no segment" has to be a route
 * through the machine rather than a state it cannot represent.
 *
 * ## What activation means here
 *
 * Each segment activates on a different act, and none of them is "saw a screen". The activation
 * predicate is separate from the step: reaching the last step is not activation, doing the thing is.
 * That distinction is the whole reason this plan exists — v1 counted a completed flow as an
 * activated user, which is why its activation rate described the flow rather than the product.
 */
import { USER_SEGMENTS, type SegmentPreset, type UserSegment } from './user-segments'

export const ONBOARDING_FLOW_VERSION = 2

/**
 * Every step any route can visit.
 *
 * Prefixed by segment where the step is segment-specific, so a stored key says which flow wrote it
 * without needing the segment beside it — a row that says `hiring_search` cannot be misread as
 * belonging to the investing flow after a taxonomy change.
 */
export const ONBOARDING_STEP_KEYS = [
  'welcome',
  'goal',
  'hiring_criteria',
  'hiring_search',
  'hiring_save',
  'investing_thesis',
  'investing_discovery',
  'investing_save',
  'building_locate',
  'building_claim',
  'building_enrich',
  'general_search',
  'general_save',
  'confirmation',
  'next_step',
  'done',
] as const
export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number]

/**
 * The ordered route for each preset. `general` is the v1 flow, kept intact.
 *
 * `done` terminates every route. It is a state and not a step: nothing renders it, and it exists so
 * "finished" is representable without a boolean that could disagree with the key.
 */
const FLOWS: Record<SegmentPreset, readonly OnboardingStepKey[]> = {
  hiring: ['welcome', 'goal', 'hiring_criteria', 'hiring_search', 'hiring_save', 'confirmation', 'next_step', 'done'],
  investing: ['welcome', 'goal', 'investing_thesis', 'investing_discovery', 'investing_save', 'confirmation', 'next_step', 'done'],
  building: ['welcome', 'goal', 'building_locate', 'building_claim', 'building_enrich', 'confirmation', 'next_step', 'done'],
  other: ['welcome', 'goal', 'general_search', 'general_save', 'confirmation', 'next_step', 'done'],
  general: ['welcome', 'goal', 'general_search', 'general_save', 'confirmation', 'next_step', 'done'],
}

export function flowFor(preset: SegmentPreset): readonly OnboardingStepKey[] {
  return FLOWS[preset]
}

export function firstStep(preset: SegmentPreset): OnboardingStepKey {
  return FLOWS[preset][0]
}

/** `null` at the end of a flow — there is no step after `done`. */
export function nextStep(preset: SegmentPreset, current: OnboardingStepKey): OnboardingStepKey | null {
  const flow = FLOWS[preset]
  const index = flow.indexOf(current)
  if (index === -1 || index === flow.length - 1) return null
  return flow[index + 1]
}

/**
 * The only thing that may advance a stored step.
 *
 * Forward by exactly one, within the flow the person is actually on. Not two — skipping a step is
 * how an activation gets reported for work nobody did. Not backwards — `resume` handles returning,
 * and allowing it here would let a client rewind to re-trigger a one-time event.
 */
export function isValidTransition(
  preset: SegmentPreset,
  from: OnboardingStepKey,
  to: OnboardingStepKey,
): boolean {
  return nextStep(preset, from) === to
}

/** Whether a step belongs to a flow at all — the check that keeps a client off another segment's route. */
export function stepBelongsTo(preset: SegmentPreset, step: OnboardingStepKey): boolean {
  return FLOWS[preset].includes(step)
}

/**
 * Where somebody resumes.
 *
 * A stored step from a different flow is not an error to throw on: a person may change their segment
 * halfway through, and the honest answer is to restart them on the route they now belong to rather
 * than to strand them on a step their flow does not contain, or to crash the page they return to.
 */
export function resumeStep(preset: SegmentPreset, stored: OnboardingStepKey | null): OnboardingStepKey {
  if (!stored || !stepBelongsTo(preset, stored)) return firstStep(preset)
  return stored
}

/** Coarse and enumerated — what kind of first value, never which search or which builder. */
export const ACTIVATION_TYPES = ['tracked_builders', 'sourcing_sprint', 'saved_search_alert', 'builder_claim'] as const
export type OnboardingActivationType = (typeof ACTIVATION_TYPES)[number]

/**
 * What each route counts as having arrived.
 *
 * Deliberately not "completed the flow". v1 counted a finished flow as an activated user, so its
 * activation rate measured the flow rather than the product — somebody could click through every
 * screen and have done nothing.
 */
const ACTIVATION_BY_PRESET: Record<SegmentPreset, readonly OnboardingActivationType[]> = {
  hiring: ['tracked_builders', 'sourcing_sprint'],
  investing: ['saved_search_alert'],
  building: ['builder_claim'],
  other: ['tracked_builders'],
  general: ['tracked_builders'],
}

export function activationTypesFor(preset: SegmentPreset): readonly OnboardingActivationType[] {
  return ACTIVATION_BY_PRESET[preset]
}

export interface ActivationEvidence {
  trackedBuilders: number
  sourcingSprints: number
  savedSearchesWithAlert: number
  builderClaims: number
}

/** `hiring` needs three tracked builders; the others need one of the thing that counts for them. */
const TRACKED_BUILDERS_FOR_HIRING = 3

/**
 * Whether the evidence amounts to activation, and of which kind.
 *
 * Returns the type rather than a boolean so the caller records *what* happened. Two people can both
 * be "activated" for different reasons, and a rate that cannot tell them apart cannot tell you which
 * route is working.
 */
export function activationReached(
  preset: SegmentPreset,
  evidence: ActivationEvidence,
): OnboardingActivationType | null {
  for (const type of ACTIVATION_BY_PRESET[preset]) {
    if (type === 'tracked_builders' && evidence.trackedBuilders >= TRACKED_BUILDERS_FOR_HIRING) return type
    if (type === 'sourcing_sprint' && evidence.sourcingSprints >= 1) return type
    if (type === 'saved_search_alert' && evidence.savedSearchesWithAlert >= 1) return type
    if (type === 'builder_claim' && evidence.builderClaims >= 1) return type
  }
  return null
}

/** Every preset has a flow and an activation rule — asserted in tests, so a fifth segment cannot land without both. */
export const ONBOARDING_PRESETS: readonly SegmentPreset[] = ['general', ...USER_SEGMENTS] as const

export type { UserSegment }
