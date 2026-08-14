/**
 * The segment a landing page may suggest (plan: phase-2/03-onboarding-segmentado).
 *
 * ## Why a hint and never a value
 *
 * A link from a segmented landing page can carry `?goal=hiring`, and the onboarding step may
 * **preselect** that option. It may not persist it. The difference matters because the URL is
 * attacker-controlled: anybody can send anybody a link, and a value written from one would be a
 * preference somebody never expressed appearing in their account.
 *
 * So the hint decides which radio starts checked and nothing else. The write still happens when the
 * person confirms, and `source` is then `onboarding` — the honest description of where the choice
 * was made, regardless of which link brought them.
 *
 * ## Why parsing is total
 *
 * `parseSegmentHint` never throws and never propagates a bad value: a manipulated URL produces
 * `null`, which is the same state as arriving with no hint at all. An unrecognised hint must not be
 * distinguishable in the interface from no hint, or the URL becomes a way to probe which values the
 * enum accepts.
 */
import { parseUserSegment, type UserSegment } from './user-segments'

/** The query parameter a landing CTA appends. Named for what it means to a reader, not for the column. */
export const SEGMENT_HINT_PARAM = 'goal'

/**
 * Narrows a hint from a URL, or returns `null`.
 *
 * Accepts a `URLSearchParams`, a raw query string or a full URL, because the callers differ: a route
 * loader holds one, a client component holds another, and forcing each to normalise first is how one
 * of them ends up doing it wrong.
 */
export function parseSegmentHint(input: URLSearchParams | string | null | undefined): UserSegment | null {
  if (!input) return null

  let params: URLSearchParams
  if (typeof input === 'string') {
    /**
     * Everything after the first `?`, whatever the rest is.
     *
     * A full URL, a relative path with a query, or a bare query string all reach here. The first
     * version tried `new URL()` and fell back to parsing the whole string as a query — which turned
     * `/onboarding/goal?goal=hiring` into one key named `/onboarding/goal?goal` and silently
     * returned no hint. A relative path is exactly what a route loader hands over, so the case that
     * broke was the common one.
     */
    const query = input.includes('?') ? input.slice(input.indexOf('?') + 1) : input
    params = new URLSearchParams(query)
  } else {
    params = input
  }

  return parseUserSegment(params.get(SEGMENT_HINT_PARAM))
}

/** Builds the link a segmented landing CTA points at. One place, so the parameter name cannot drift. */
export function onboardingLinkFor(segment: UserSegment, path = '/onboarding/goal'): string {
  return `${path}?${SEGMENT_HINT_PARAM}=${encodeURIComponent(segment)}`
}
