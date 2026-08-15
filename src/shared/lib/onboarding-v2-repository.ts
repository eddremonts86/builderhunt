/**
 * Reading and advancing onboarding v2 state (plan: phase-2/03-onboarding-segmentado).
 *
 * Sits beside `onboarding.ts` rather than replacing it. The v1 library still owns eligibility, the
 * selected-builder set and the `0..3` step, and this module adds the v2 columns on top of the same
 * row — so a person mid-flow is one record with two readings of it, not two records that can
 * disagree.
 *
 * The segment comes from `user_preferences`, never from the request. That is what makes the route
 * a property of the person rather than of whatever the client last claimed.
 */
import { and, eq } from 'drizzle-orm'
import type { TenantTransaction } from './db/client'
import { onboardingProgress } from './db/schema'
import { getUserPreferences } from './repositories/user-preferences'
import { resolveSegmentPreset, type SegmentPreset } from './user-segments'
import {
  ONBOARDING_FLOW_VERSION,
  activationReached,
  firstStep,
  flowFor,
  isValidTransition,
  nextStep,
  resumeStep,
  type ActivationEvidence,
  type OnboardingActivationType,
  type OnboardingStepKey,
} from './onboarding-v2'
import { legacyStepFor, type OnboardingStatusV2 } from './onboarding-api'

function parseStepKey(raw: string | null): OnboardingStepKey | null {
  if (!raw) return null
  return (flowFor('general').includes(raw as OnboardingStepKey) ||
    flowFor('hiring').includes(raw as OnboardingStepKey) ||
    flowFor('investing').includes(raw as OnboardingStepKey) ||
    flowFor('building').includes(raw as OnboardingStepKey))
    ? (raw as OnboardingStepKey)
    : null
}

function parseActivation(raw: string | null): OnboardingActivationType | null {
  const known: readonly string[] = ['tracked_builders', 'sourcing_sprint', 'saved_search_alert', 'builder_claim']
  return raw && known.includes(raw) ? (raw as OnboardingActivationType) : null
}

export interface OnboardingV2State {
  preset: SegmentPreset
  currentStep: OnboardingStepKey
  activationType: OnboardingActivationType | null
  activatedAt: Date | null
  skipped: boolean
  skippedCount: number
  completed: boolean
}

/**
 * The person's route and where they are on it.
 *
 * A stored step that belongs to a flow they have since left resolves back to the start of the one
 * they are on now — see `resumeStep`. Changing your goal halfway through is allowed, and being
 * stranded on a step your flow does not contain is not a state the interface can render.
 */
export async function getOnboardingV2State(
  transaction: TenantTransaction,
  organizationId: string,
  userId: string,
): Promise<OnboardingV2State> {
  const [preferences, [row]] = await Promise.all([
    getUserPreferences(transaction, userId),
    transaction
      .select()
      .from(onboardingProgress)
      .where(and(eq(onboardingProgress.userId, userId), eq(onboardingProgress.organizationId, organizationId)))
      .limit(1),
  ])

  const preset = resolveSegmentPreset(preferences.primarySegment)
  if (!row) {
    return {
      preset,
      currentStep: firstStep(preset),
      activationType: null,
      activatedAt: null,
      skipped: false,
      skippedCount: 0,
      completed: false,
    }
  }

  return {
    preset,
    currentStep: resumeStep(preset, parseStepKey(row.currentStepKey)),
    activationType: parseActivation(row.activationType),
    activatedAt: row.activatedAt,
    skipped: row.skipped,
    skippedCount: row.skippedCount,
    completed: row.completed,
  }
}

export interface AdvanceResult {
  ok: boolean
  /** Set when the move was refused, so the route can answer 409 with a reason rather than a bare no. */
  reason?: 'stale_step' | 'not_a_valid_transition'
  state: OnboardingV2State
}

/**
 * Moves one step, or refuses.
 *
 * Two distinct refusals, because they mean different things to a client. `stale_step` says "you are
 * not where you think you are" — the answer is to re-read and re-render. `not_a_valid_transition`
 * says the move itself is illegal on this route, which is a bug in the caller rather than a race.
 * Collapsing them into one would make a retry loop indistinguishable from a broken client.
 */
export async function advanceOnboarding(
  transaction: TenantTransaction,
  organizationId: string,
  userId: string,
  from: OnboardingStepKey,
  now: Date = new Date(),
): Promise<AdvanceResult> {
  const state = await getOnboardingV2State(transaction, organizationId, userId)

  if (state.currentStep !== from) {
    return { ok: false, reason: 'stale_step', state }
  }
  const target = nextStep(state.preset, from)
  if (!target || !isValidTransition(state.preset, from, target)) {
    return { ok: false, reason: 'not_a_valid_transition', state }
  }

  const completed = target === 'done'
  await transaction
    .insert(onboardingProgress)
    .values({
      userId,
      organizationId,
      currentStepKey: target,
      flowVersion: ONBOARDING_FLOW_VERSION,
      step: legacyStepFor(target, completed),
      completed,
      completedAt: completed ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [onboardingProgress.userId],
      set: {
        currentStepKey: target,
        flowVersion: ONBOARDING_FLOW_VERSION,
        // The v1 column is kept in step with the v2 one rather than abandoned, so a consumer that
        // has not moved yet keeps reading something true.
        step: legacyStepFor(target, completed),
        completed,
        completedAt: completed ? now : null,
        updatedAt: now,
      },
    })

  return { ok: true, state: { ...state, currentStep: target, completed } }
}

/**
 * Records an activation, once.
 *
 * Idempotent by refusing to overwrite: the first real act is the one that counts, and a second
 * activation of a different kind later would move `activated_at` and quietly corrupt every
 * time-to-activation figure computed from it.
 */
export async function recordActivation(
  transaction: TenantTransaction,
  organizationId: string,
  userId: string,
  evidence: ActivationEvidence,
  refId: string | null = null,
  now: Date = new Date(),
): Promise<OnboardingActivationType | null> {
  const state = await getOnboardingV2State(transaction, organizationId, userId)
  if (state.activationType) return state.activationType

  const reached = activationReached(state.preset, evidence)
  if (!reached) return null

  await transaction
    .update(onboardingProgress)
    .set({ activationType: reached, activationRefId: refId, activatedAt: now, updatedAt: now })
    .where(and(eq(onboardingProgress.userId, userId), eq(onboardingProgress.organizationId, organizationId)))

  return reached
}

/** The wire shape, assembled in one place so the route never builds it by hand. */
export function toStatusV2(state: OnboardingV2State, eligible: boolean): OnboardingStatusV2 {
  return {
    flowVersion: ONBOARDING_FLOW_VERSION,
    preset: state.preset,
    flow: [...flowFor(state.preset)],
    currentStep: state.currentStep,
    activationType: state.activationType,
    activatedAt: state.activatedAt?.toISOString() ?? null,
    skipped: state.skipped,
    skippedCount: state.skippedCount,
    eligible,
    legacy: {
      step: legacyStepFor(state.currentStep, state.completed),
      completed: state.completed,
    },
  }
}
