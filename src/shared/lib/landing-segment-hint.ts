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
 *
 * ## Why it needs somewhere to wait (plan: phase-2/06-landing-segmentada)
 *
 * Somebody reading `/for/investors` who presses "Create an account" leaves the query behind at the
 * sign-up form and arrives at the goal step with nothing. So the hint is stashed while they fill the
 * form in, and read once on the other side.
 *
 * Everything about that stash is chosen to keep it a hint:
 *
 * - **`sessionStorage`, not a cookie.** First-party and same-tab. A cookie would be sent to the
 *   server on every request, which turns a presentation nicety into something the backend can read
 *   and act on — and the whole point is that this value never reaches a decision.
 * - **Not `localStorage`.** It would outlive the visit and decide an onboarding somebody starts
 *   weeks later from a link they no longer remember clicking.
 * - **A TTL, written into the value.** Storage that a browser keeps is storage that outlives what
 *   the hint was about; `SEGMENT_HINT_TTL_MS` bounds it whatever the browser decides to keep.
 * - **One-shot.** `consumeSegmentHint` removes before it validates, so a hint decides exactly one
 *   screen even if it turns out to be unusable.
 * - **Re-validated on read.** `sessionStorage` is writable by anything running on the origin, so
 *   what comes out is treated as no more trustworthy than what came out of the URL.
 */
import { parseUserSegment, type UserSegment } from './user-segments'

/** The query parameter a landing CTA appends. Named for what it means to a reader, not for the column. */
export const SEGMENT_HINT_PARAM = 'goal'

/** Where the hint waits while somebody fills in the sign-up form. */
export const SEGMENT_HINT_STORAGE_KEY = 'bh-segment-hint'

/**
 * Long enough to create an account; short enough that it cannot decide a later one.
 *
 * Thirty minutes covers reading the page, filling the form and a wrong password or two. It is not
 * meant to survive a coffee break, because a hint that survives one is no longer describing why this
 * person is here — it is describing a page they have forgotten reading.
 */
export const SEGMENT_HINT_TTL_MS = 30 * 60 * 1000

/** The slice of `Storage` this needs. Narrow, so a test can hand over an object rather than a DOM. */
export interface SegmentHintStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface SegmentHintStashOptions {
  /** `null` means "no storage" — a caller says so explicitly; omitting it means `sessionStorage`. */
  storage?: SegmentHintStorage | null
  now?: number
}

/**
 * Resolves the default store, and never throws doing it.
 *
 * `window.sessionStorage` is a getter that throws outright in a browser with site data blocked, so
 * the access itself is guarded rather than only the calls that follow.
 */
function defaultStorage(): SegmentHintStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function resolveStorage(options: SegmentHintStashOptions): SegmentHintStorage | null {
  return options.storage === undefined ? defaultStorage() : options.storage
}

/**
 * Stashes a hint for the other side of sign-up, and returns what it stored.
 *
 * Validation lives here rather than in the caller: a writer that accepted `unknown` and trusted it
 * would be one careless call away from putting an arbitrary string where a later screen reads a
 * segment. Anything unrecognised stores nothing at all — not an empty marker, nothing — so an
 * unusable hint and no hint are the same state on disk as they are in the interface.
 *
 * Storage being unavailable is not an error. Failing to preselect a radio button is not a failure
 * anybody should be told about, and it must never interrupt a sign-up.
 */
export function stashSegmentHint(
  raw: unknown,
  options: SegmentHintStashOptions = {},
): UserSegment | null {
  const segment = parseUserSegment(raw)
  const storage = resolveStorage(options)
  if (!segment || !storage) return null

  const expiresAt = (options.now ?? Date.now()) + SEGMENT_HINT_TTL_MS
  try {
    storage.setItem(SEGMENT_HINT_STORAGE_KEY, JSON.stringify({ v: 1, segment, expiresAt }))
  } catch {
    return null
  }
  return segment
}

/**
 * Reads the stashed hint once, and clears it whatever it turns out to be.
 *
 * The removal happens before the value is inspected, on purpose. A hint that fails validation is
 * still a hint that has now been seen, and leaving a malformed one behind would mean re-parsing the
 * same rubbish on every later screen that asks.
 */
export function consumeSegmentHint(options: SegmentHintStashOptions = {}): UserSegment | null {
  const storage = resolveStorage(options)
  if (!storage) return null

  let raw: string | null
  try {
    raw = storage.getItem(SEGMENT_HINT_STORAGE_KEY)
    storage.removeItem(SEGMENT_HINT_STORAGE_KEY)
  } catch {
    return null
  }
  if (!raw) return null

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { segment, expiresAt } = parsed as { segment?: unknown; expiresAt?: unknown }
    // A missing or non-numeric expiry is an expired one. Anything else would let a hand-written
    // entry with no TTL sit in storage for the life of the tab.
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null
    if (expiresAt <= (options.now ?? Date.now())) return null
    return parseUserSegment(segment)
  } catch {
    return null
  }
}

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
