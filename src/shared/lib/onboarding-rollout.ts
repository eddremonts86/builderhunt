/**
 * Who gets onboarding v2 (plan: phase-2/03-onboarding-segmentado).
 *
 * ## Why a stable bucket rather than a coin flip
 *
 * A percentage rollout is only useful if the same person keeps getting the same answer. A random
 * draw per request would move somebody between flows mid-session — half-finished on v2, resumed on
 * v1 — and would make every cohort comparison meaningless, because the two groups would be
 * resampled on every page load.
 *
 * So the bucket is derived from the user id and nothing else. It never moves, and raising the
 * percentage is **purely additive**: everybody at 10 % is still in at 20 %, so a ramp never takes the
 * flow away from somebody halfway through it. Lowering it does remove people, which is what a
 * rollback is for, and the v2 columns are additive so they land back where they were rather than at
 * the beginning.
 *
 * ## Why it is not keyed on the conversion session id
 *
 * That id lives in `sessionStorage` and is minted per browser session. Keying on it would give one
 * person a different flow on their phone than on their laptop, and a new one every time they
 * reopened the tab.
 */

/** FNV-1a, 32-bit. Small, dependency-free and identical on the server and in a browser bundle. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    // The classic FNV prime multiply, written as shifts so it stays inside 32 bits.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash >>> 0
}

/**
 * A stable 0..99 bucket for one person.
 *
 * Namespaced so this rollout's buckets are uncorrelated with any other percentage rollout keyed on
 * the same ids — without the prefix, everybody unlucky in one experiment would be unlucky in all of
 * them, and two rollouts at 10 % would silently be testing the same tenth of the userbase.
 */
export function onboardingCohortBucket(userId: string): number {
  return fnv1a(`builderhunt:onboarding-v2:${userId}`) % 100
}

/** Clamps anything unparseable to 0 — an unreadable percentage must mean "off", never "everybody". */
export function parseRolloutPercent(raw: string | number | null | undefined): number {
  const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.trunc(value)))
}

/**
 * Whether this person is on v2.
 *
 * `bucket < percent`, so 0 is nobody and 100 is everybody, and the set only grows as the percentage
 * does. An empty user id is not in the cohort: an unauthenticated caller has no stable identity to
 * bucket, and guessing would put somebody on a flow they would leave the moment they signed in.
 */
export function isInOnboardingV2Cohort(userId: string, percent: number): boolean {
  if (!userId) return false
  const bounded = parseRolloutPercent(percent)
  if (bounded <= 0) return false
  if (bounded >= 100) return true
  return onboardingCohortBucket(userId) < bounded
}
