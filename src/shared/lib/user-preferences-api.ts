/**
 * The wire contract for `/api/me/preferences` (plan: phase-2/02-segmentacion-usuarios).
 *
 * Shared by the route and its callers so the shape is agreed once. The interesting part is what the
 * request body is **not** allowed to contain.
 *
 * ## Why the body cannot name a user
 *
 * The subject is the authenticated principal, resolved on the server from the session. A body that
 * accepted `userId` would create a second source of truth for whose data is being written, and the
 * route would have to remember to ignore it — every time, forever. Row-level security would still
 * refuse the write, so this is not the only defence; it is the one that fails loudly at the edge
 * instead of quietly three layers down.
 *
 * The same reasoning covers `organizationId`, `role` and any entitlement field: none of them are
 * inputs to a preference, and a request that mentions them is a request written against a
 * misunderstanding of what this endpoint does. `.strict()` rejects them by name in the response, so
 * the mistake is visible rather than silently dropped.
 */
import { z } from 'zod'
import { SEGMENT_SOURCES, USER_SEGMENTS, userSegmentSchema } from './user-segments'

/**
 * `null` is a legitimate value, not a missing one — it clears the choice and returns the person to
 * the general preset. `.nullable()` without `.optional()` makes "clear it" explicit and stops an
 * empty body from being read as one.
 */
export const updateUserPreferencesSchema = z
  .object({
    primarySegment: userSegmentSchema.nullable(),
    /**
     * Which surface the change came from. Constrained to the two a person can actually act through:
     * `migration` is written by a migration and `landing` by the pre-auth funnel, and neither can
     * arrive on an authenticated PATCH. Accepting them here would let a client mislabel its own
     * writes and quietly corrupt the only field that explains *why* a segment changed.
     */
    source: z.enum(['onboarding', 'settings']).default('settings'),
  })
  .strict()

export type UpdateUserPreferencesInput = z.infer<typeof updateUserPreferencesSchema>

export const userPreferencesResponseSchema = z
  .object({
    primarySegment: userSegmentSchema.nullable(),
    source: z.enum(SEGMENT_SOURCES).nullable(),
    schemaVersion: z.number().int().nullable(),
    selectedAt: z.string().datetime({ offset: true }).nullable(),
    /** So a client can render a picker without importing the enum or hardcoding the order. */
    available: z.array(userSegmentSchema),
  })
  .strict()

export type UserPreferencesResponse = z.infer<typeof userPreferencesResponseSchema>

/** Field names a request must never carry. Exported so the negative tests cannot drift from the list. */
export const REJECTED_REQUEST_FIELDS = [
  'userId',
  'organizationId',
  'role',
  'platformRole',
  'entitlement',
  'plan',
] as const

export function toUserPreferencesResponse(preferences: {
  primarySegment: string | null
  segmentSource: string | null
  segmentSchemaVersion: number | null
  segmentSelectedAt: Date | null
}): UserPreferencesResponse {
  return {
    primarySegment: preferences.primarySegment as UserPreferencesResponse['primarySegment'],
    source: preferences.segmentSource as UserPreferencesResponse['source'],
    schemaVersion: preferences.segmentSchemaVersion,
    selectedAt: preferences.segmentSelectedAt?.toISOString() ?? null,
    available: [...USER_SEGMENTS],
  }
}
