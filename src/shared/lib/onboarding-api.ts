/**
 * The versioned wire contract for onboarding (plan: phase-2/03-onboarding-segmentado).
 *
 * ## Why the response says which flow it describes
 *
 * v1 answered with `{ step: 0..3 }`. v2 answers with a step *key* and a segment-specific route, and
 * the two shapes are not interchangeable — a v1 client reading `step: 0` from a v2 row would render
 * the welcome screen to somebody halfway through. `flowVersion` in the payload is what lets a client
 * know which of the two it is holding, so the rollout can be by cohort rather than by migration.
 *
 * The v1 fields are still returned. Dropping them would have forced every consumer to move on the
 * same deploy, which is exactly what a versioned contract exists to avoid.
 *
 * ## Why an action is a verb and not a step number
 *
 * The client says *what it did* — `advance`, `skip`, `activate` — and the server decides what that
 * means for the stored state. A request that named a step would be asking to be placed somewhere,
 * and the only safe answer to that is to re-derive it anyway. `isValidTransition` then refuses
 * anything that is not the single legal successor.
 *
 * Nothing in a request may name a segment, a user or an organisation. The segment comes from
 * `user_preferences` on the server; the identity comes from the session. A body that could carry
 * them would be a second source of truth for who is being onboarded and as what.
 */
import { z } from 'zod'
import { ONBOARDING_STEP_KEYS, ACTIVATION_TYPES, ONBOARDING_FLOW_VERSION } from './onboarding-v2'
import { USER_SEGMENTS } from './user-segments'

export const onboardingStepKeySchema = z.enum(ONBOARDING_STEP_KEYS)
export const onboardingActivationTypeSchema = z.enum(ACTIVATION_TYPES)

/**
 * What a client may ask for.
 *
 * `advance` carries the step it believes it is *leaving*, not the one it wants next. The server
 * computes the successor, so a stale client cannot skip ahead — it can only be told that the step it
 * named is no longer current.
 */
export const onboardingActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('advance'), from: onboardingStepKeySchema }).strict(),
  z.object({ action: z.literal('skip') }).strict(),
  z.object({
    action: z.literal('activate'),
    activationType: onboardingActivationTypeSchema,
    /**
     * The id of the thing that happened — a sprint, a saved search, a claim. Opaque and optional:
     * it makes an activation auditable without the event stream having to carry it.
     */
    refId: z.string().min(1).max(128).optional(),
  }).strict(),
])

export type OnboardingAction = z.infer<typeof onboardingActionSchema>

/** Field names a request must never carry, for the same reason as in `user-preferences-api.ts`. */
export const REJECTED_ONBOARDING_FIELDS = [
  'userId',
  'organizationId',
  'segment',
  'primarySegment',
  'role',
  'flowVersion',
  'activatedAt',
] as const

export const onboardingStatusV2Schema = z.object({
  /** Which contract this payload speaks. A v1 client can look at this and refuse to guess. */
  flowVersion: z.literal(ONBOARDING_FLOW_VERSION),
  /** The route the person is on, resolved from their segment — `general` when they have none. */
  preset: z.enum(['general', ...USER_SEGMENTS]),
  /** The full ordered route, so a client renders progress without hardcoding the machine. */
  flow: z.array(onboardingStepKeySchema),
  currentStep: onboardingStepKeySchema,
  /** `null` until something real happened. Reaching the last step is not activation. */
  activationType: onboardingActivationTypeSchema.nullable(),
  activatedAt: z.string().datetime({ offset: true }).nullable(),
  skipped: z.boolean(),
  skippedCount: z.number().int().nonnegative(),
  eligible: z.boolean(),
  /**
   * The v1 shape, still answered.
   *
   * Kept so a consumer that has not moved yet keeps working across the rollout — the whole point of
   * versioning rather than replacing. It is derived from the v2 state, never stored twice.
   */
  legacy: z.object({
    step: z.number().int().min(0).max(3),
    completed: z.boolean(),
  }),
}).strict()

export type OnboardingStatusV2 = z.infer<typeof onboardingStatusV2Schema>

/**
 * Where a v2 step lands on v1's `0..3`.
 *
 * Coarse on purpose. v1's scale cannot express four routes, so this maps to the nearest honest
 * v1 meaning — "not started", "past welcome", "did the action", "finished" — rather than inventing
 * a precision the old scale never had.
 */
export function legacyStepFor(current: string, completed: boolean): number {
  if (completed || current === 'done') return 3
  if (current === 'welcome') return 0
  if (current === 'goal') return 1
  if (current === 'confirmation' || current === 'next_step') return 3
  return 2
}
