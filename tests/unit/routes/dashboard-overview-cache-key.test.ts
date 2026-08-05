import { describe, expect, it } from 'vitest'
import { cacheKey } from '~/routes/api/dashboard/overview'
import { DASHBOARD_SCHEMA_VERSION } from '~/shared/lib/dashboard/contracts'

/**
 * plans/ui-dashboard Wave 1, "Add cache and observability boundaries" — verify line: "cache keys
 * cannot collide across organizations/roles".
 *
 * ## Why this is a unit test and not an e2e
 *
 * The property is about what two *different* callers would read, and demonstrating it end to end
 * needs several sign-ups in one file — which this suite's own rate limit refuses, and which would
 * make the assertion depend on a limiter rather than on the key. The key is a pure function; testing
 * it directly is both cheaper and a stronger statement, because it enumerates the collisions rather
 * than sampling two of them.
 *
 * ## The specific hazard
 *
 * The plan specified "organization, role class, range, and schema version", which was right while
 * every section was an organization aggregate. The action queue is not: `getOnboardingStatus` is
 * keyed by `(organizationId, userId)`, and pending membership invitations are addressed to a person
 * and can name an organization this one has nothing to do with. Under an organization-scoped key the
 * first teammate to load the dashboard writes *their* onboarding progress and *their* invitations
 * into an entry the next teammate reads — a cross-user disclosure inside a correctly isolated tenant.
 *
 * This repository has shipped that mistake before in other forms: a Coolify env write indexed by key
 * alone put a preview database URL over production, and `search.ts` served a timed-out source's
 * empty result as a success. A cache indexed by too little.
 */

const BASE = ['org-1', 'user-1', 'billing-reader', '7d'] as const

describe('the dashboard overview cache key', () => {
  it('changes when any single input changes', () => {
    const base = cacheKey(...BASE)
    const variants = [
      cacheKey('org-2', 'user-1', 'billing-reader', '7d'),
      cacheKey('org-1', 'user-2', 'billing-reader', '7d'),
      cacheKey('org-1', 'user-1', 'member', '7d'),
      cacheKey('org-1', 'user-1', 'billing-reader', '30d'),
    ]

    for (const variant of variants) {
      expect(variant, `a variant collided with the base key: ${variant}`).not.toBe(base)
    }
    expect(new Set([base, ...variants]).size).toBe(5)
  })

  it('separates two users who share an organization and a role', () => {
    // The case an organization-scoped key would have missed, and the reason the plan's original
    // specification had to be corrected once the queue carried per-user facts.
    expect(cacheKey('org-1', 'alice', 'member', '7d')).not.toBe(cacheKey('org-1', 'bob', 'member', '7d'))
  })

  it('separates a member from a billing reader in the same organization', () => {
    // Not cosmetic: a billing reader's payload carries a `usage` section a member's must not have.
    // One shared entry would either disclose it or silently drop it, depending on who arrived first.
    expect(cacheKey('org-1', 'u', 'member', '7d')).not.toBe(cacheKey('org-1', 'u', 'billing-reader', '7d'))
  })

  it('carries the schema version, so a deploy cannot read the previous shape', () => {
    expect(cacheKey(...BASE)).toContain(`v${DASHBOARD_SCHEMA_VERSION}`)
  })

  it('is stable for identical inputs', () => {
    expect(cacheKey(...BASE)).toBe(cacheKey(...BASE))
  })

  it('cannot be spoofed into another key by a separator in an input', () => {
    /*
     * Ids reaching this function come from the session, not from a request, so this is defence in
     * depth rather than a live hole. It is worth pinning anyway: the key is colon-delimited, so an
     * organization id containing a colon could otherwise be crafted to produce the same string as a
     * different (organization, user) pair, and a cache collision engineered that way would serve one
     * tenant's projection to another.
     */
    const crafted = cacheKey('org-1:user-9', 'user-1', 'member', '7d')
    const honest = cacheKey('org-1', 'user-9:user-1', 'member', '7d')
    expect(crafted).not.toBe(honest)
  })
})
