/**
 * The user's primary goal, as a closed contract (plan: phase-2/02-segmentacion-usuarios).
 *
 * ## What this is not
 *
 * `user_segment` **personalises; it never authorises.** Nothing here may reach `can()`, a route
 * guard, `TenantPrincipal`, pricing or entitlement. Organisation permissions stay in
 * `organization_role`, internal tools in `platform_role`, and commercial access in the plan. The
 * phase README states this first among its non-negotiables, and it is the reason a wrong segment is
 * a bad recommendation rather than a security incident.
 *
 * ## Why the taxonomy is provisional and says so
 *
 * These four values are a product hypothesis written down before the research that would confirm
 * them — the interviews moved to phase-5 because they need real users. That is safe precisely
 * because the segment grants nothing. `SEGMENT_SCHEMA_VERSION` exists so a later decision migrates
 * the taxonomy explicitly instead of reinterpreting stored values: a row recorded under version 1
 * means what version 1 meant, forever.
 *
 * `user` is deliberately not a segment. It describes no job and no need — everyone here is a user.
 */
import { z } from 'zod'

export const USER_SEGMENTS = ['hiring', 'investing', 'building', 'other'] as const
export const userSegmentSchema = z.enum(USER_SEGMENTS)
export type UserSegment = z.infer<typeof userSegmentSchema>

/**
 * Bumped only by a migration that changes what the values *mean*.
 *
 * Adding a fifth segment is a bump. Renaming a label is not — labels are presentation and may
 * change freely, which is exactly why they live here and not in the database.
 */
export const SEGMENT_SCHEMA_VERSION = 1

/**
 * Where a selection came from. Recorded so a later analysis can tell a deliberate choice in
 * settings from a click during onboarding, and both from a value a migration assigned.
 */
export const SEGMENT_SOURCES = ['onboarding', 'settings', 'landing', 'migration'] as const
export const segmentSourceSchema = z.enum(SEGMENT_SOURCES)
export type SegmentSource = z.infer<typeof segmentSourceSchema>

/**
 * What a consumer switches on — the segments plus `general`.
 *
 * `general` is not a segment anybody can pick; it is what every consumer must render when the
 * segment is `null`. Every existing account starts `null` and is allowed to stay there, so the
 * unpersonalised path is the default rather than an error case. Keeping it out of `USER_SEGMENTS`
 * means it can never be written to the database or offered in a picker.
 */
export const SEGMENT_PRESETS = ['general', ...USER_SEGMENTS] as const
export type SegmentPreset = (typeof SEGMENT_PRESETS)[number]

/** The only mapping from stored value to rendered behaviour. `null` is not an error. */
export function resolveSegmentPreset(segment: UserSegment | null | undefined): SegmentPreset {
  return segment ?? 'general'
}

export interface UserSegmentCopy {
  /** Shown in the picker. Never the enum value — "Hiring builders", not `hiring`. */
  readonly label: string
  /** One sentence on who this is, in the second person. */
  readonly description: string
}

/**
 * Presentation only, and English only.
 *
 * The phase's plans are written in Spanish by the owner's request; the product's own copy is not
 * translated here, because this repository has no i18n layer yet and a half-translated interface is
 * worse than a consistent one. When i18n arrives these strings become keys.
 */
export const USER_SEGMENT_COPY: Record<UserSegment, UserSegmentCopy> = {
  hiring: {
    label: 'Hiring builders',
    description: 'You are looking for people to join a team — founding, contract or full-time.',
  },
  investing: {
    label: 'Investing or scouting',
    description: 'You are tracking builders, teams and projects to back or to watch.',
  },
  building: {
    label: 'Building',
    description: 'You are a builder here for your own profile, portfolio and reach.',
  },
  other: {
    label: 'Something else',
    description: 'None of these fit. You will see the general experience, and nothing is limited.',
  },
}

/**
 * The reassurance the settings surface has to make, kept beside the contract it describes.
 *
 * The spec requires the interface to say that changing this alters recommendations and nothing
 * else. Keeping the sentence here rather than inside the component means the API docs, the
 * onboarding step and the settings panel cannot drift into three different promises.
 */
export const SEGMENT_SCOPE_NOTICE =
  'This changes what we suggest and prioritise. It does not change your permissions, your plan, or ' +
  'what you can access — and changing it never deletes your searches, saved builders or alerts.'

/** Narrows an unknown value without throwing, for reading a column that may hold anything. */
export function parseUserSegment(raw: unknown): UserSegment | null {
  const parsed = userSegmentSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
