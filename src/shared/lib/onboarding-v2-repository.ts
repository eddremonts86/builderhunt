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
import { and, count, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { TenantTransaction } from './db/client'
import { alerts, builderClaims, feedCapabilities, onboardingProgress, savedQueries } from './db/schema'
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

/**
 * Counts what the person has actually done (plan: phase-2/03-onboarding-segmentado).
 *
 * Every number here is a row, read on the server. The route used to derive
 * `savedSearchesWithAlert` from "does a saved query exist" — which was the same fact as
 * `trackedBuilders` wearing a different name, and would have recorded an investing activation for
 * somebody whose search nobody was watching.
 *
 * ## Armed means armed
 *
 * A saved search counts once something delivers it. That is an `alerts` row on the paid path and a
 * minted feed capability on the free one, because a brand-new organization is on `free` and
 * `/api/alerts` answers 402 there — counting only alerts would have made this route's activation
 * rate a measure of conversion to Pro rather than of the route.
 *
 * ## Why attribution is per user
 *
 * A saved search belongs to the organization, but an activation belongs to a person. Both counts are
 * narrowed to rows this user created, so a teammate arming a search does not mark somebody else as
 * activated. `feed_capabilities` has no author column, so the attribution comes from the saved query
 * it points at.
 *
 * `trackedBuilders` is passed in rather than re-counted: v1 already reads
 * `onboarding_selected_builders` for its own status, and a second count here could disagree with it.
 */
export async function countActivationEvidence(
  transaction: TenantTransaction,
  organizationId: string,
  userId: string,
  trackedBuilders: number,
): Promise<ActivationEvidence> {
  const [[alertRow], [feedRow], [claimRow]] = await Promise.all([
    transaction
      .select({ value: count() })
      .from(alerts)
      .where(and(
        eq(alerts.organizationId, organizationId),
        eq(alerts.userId, userId),
        isNotNull(alerts.queryId),
        eq(alerts.enabled, true),
      )),
    transaction
      .select({ value: count() })
      .from(feedCapabilities)
      .innerJoin(savedQueries, eq(feedCapabilities.queryId, savedQueries.id))
      .where(and(
        eq(feedCapabilities.organizationId, organizationId),
        eq(savedQueries.userId, userId),
        isNull(feedCapabilities.revokedAt),
      )),
    transaction
      .select({ value: count() })
      .from(builderClaims)
      .where(and(
        eq(builderClaims.subjectUserId, userId),
        // Pending counts. The spec asks for "claim verified, or — if verification is asynchronous —
        // claim started with a clear next step", and this product's verification is asynchronous.
        inArray(builderClaims.status, ['pending', 'verified']),
      )),
  ])

  return {
    trackedBuilders,
    // No sourcing sprint is created anywhere in onboarding, so reporting one would be inventing
    // evidence. `hiring` activates on tracked builders instead; this stays 0 until a step creates one.
    sourcingSprints: 0,
    savedSearchesWithAlert: (alertRow?.value ?? 0) + (feedRow?.value ?? 0),
    builderClaims: claimRow?.value ?? 0,
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

  /**
   * An upsert, not an update.
   *
   * A route can activate somebody who has no `onboarding_progress` row at all: the investing branch
   * arms a saved search straight from the goal step, and nothing before it has written a step. An
   * `UPDATE` there matched zero rows and reported success — the activation simply vanished, which
   * an e2e caught on its first run.
   *
   * The `if (state.activationType)` guard above still makes this write-once, so the conflict branch
   * can only be reached by a row that has never been activated.
   */
  await transaction
    .insert(onboardingProgress)
    .values({
      userId,
      organizationId,
      step: 0,
      activationType: reached,
      activationRefId: refId,
      activatedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [onboardingProgress.userId],
      set: { activationType: reached, activationRefId: refId, activatedAt: now, updatedAt: now },
    })

  return reached
}

/** The wire shape, assembled in one place so the route never builds it by hand. */
export function toStatusV2(
  state: OnboardingV2State,
  eligible: boolean,
  rollout: { inCohort: boolean; percent: number } = { inCohort: false, percent: 0 },
): OnboardingStatusV2 {
  return {
    rollout,
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
