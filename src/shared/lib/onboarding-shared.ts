/**
 * Client-safe onboarding constants — split out from `onboarding.ts` because
 * that file also pulls in drizzle-orm/db schema for its server-only
 * functions, and importing anything from it (even a plain constant) drags
 * that whole server module graph into the client bundle, which fails at
 * runtime ("crypto has been externalized for browser compatibility").
 *
 * The same rule applies to everything added here for v2: presentation only, no imports that reach
 * the database layer.
 */
import type { SegmentPreset } from './user-segments'

/**
 * The v1 list, kept as the general route's queries.
 *
 * Still exported under its original name because `search.tsx` and its e2e both reference it, and
 * renaming a constant to express that it is now one of five would have been a rename with no
 * behavioural meaning.
 */
export const STARTER_QUERIES = [
  'rust async runtime',
  'indie hackers in EU',
  'AI agents in production',
  'react performance',
  'python ML engineers',
] as const

export const TOTAL_STEPS = 3

/**
 * What each route suggests searching for (plan: phase-2/03-onboarding-segmentado).
 *
 * Five queries each, because the step renders them as chips and the layout is built for that count
 * — a route with three would look unfinished beside one with five, and the difference would read as
 * a bug rather than as a choice.
 *
 * The queries differ by *what the person is looking for*, not by tone. Somebody hiring wants people
 * available for a role; somebody investing wants what is being built and by whom; a builder wants to
 * find themselves. Rewriting the same five queries in four voices would have been personalisation
 * that changes titles rather than workflow, which the phase README names as the failure mode.
 */
export const STARTER_QUERIES_BY_PRESET: Record<SegmentPreset, readonly string[]> = {
  general: STARTER_QUERIES,
  other: STARTER_QUERIES,
  hiring: [
    'senior rust engineers open to work',
    'react developers in EU',
    'ML engineers with production experience',
    'founding engineers',
    'devops open to contract',
  ],
  investing: [
    'AI agents in production',
    'developer tools with traction',
    'open source maintainers shipping weekly',
    'infrastructure startups',
    'climate tech builders',
  ],
  building: [
    'rust async runtime',
    'react performance',
    'python ML engineers',
    'open source maintainers',
    'indie hackers in EU',
  ],
}

export interface OnboardingStepCopy {
  heading: string
  body: string
}

/**
 * The heading and subtitle of the search step, per route.
 *
 * Deliberately the only copy that varies. The rest of the step — the input, the chips, the source
 * count — is the same product doing the same thing, and changing more would be dressing rather than
 * difference.
 */
export const SEARCH_STEP_COPY: Record<SegmentPreset, OnboardingStepCopy> = {
  general: {
    heading: 'What are you looking for?',
    body: 'Pick a starter query or type your own.',
  },
  other: {
    heading: 'What are you looking for?',
    body: 'Pick a starter query or type your own.',
  },
  hiring: {
    heading: 'Who are you looking to hire?',
    body: 'Start with a role, a stack or a location. Save the people worth a conversation.',
  },
  investing: {
    heading: 'What are you tracking?',
    body: 'Start with a technology, a space or a kind of builder. Save the search to keep watching it.',
  },
  building: {
    heading: 'Find yourself',
    body: 'Search for your own handle, your projects or your stack — then claim the profile.',
  },
}

/** One place, so a caller never indexes a record with a value that might not be a key. */
export function starterQueriesFor(preset: SegmentPreset): readonly string[] {
  return STARTER_QUERIES_BY_PRESET[preset] ?? STARTER_QUERIES
}

export function searchStepCopyFor(preset: SegmentPreset): OnboardingStepCopy {
  return SEARCH_STEP_COPY[preset] ?? SEARCH_STEP_COPY.general
}
