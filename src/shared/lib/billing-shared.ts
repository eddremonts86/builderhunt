// Billing types and constants — safe to import on both client and server.
// (The actual server-only helpers live in billing.ts.)

export type PlanTier = 'free' | 'pro' | 'team'
export type PlanStatus = 'active' | 'past_due' | 'canceled' | 'trialing'

/**
 * `PlanTier` plus Pro Max — the tier set an `organization_entitlements` row can
 * actually carry, and therefore the correct key type for any per-tier allowance
 * that gates an ORGANIZATION-scoped resource.
 *
 * Deliberately a separate type from `PlanTier` rather than a widening of it:
 * `PlanTier` also drives the legacy manual per-user plan system below
 * (`PLAN_LIMITS`/`PLAN_PRICING`, admin-grantable via `setPlatformUserPlan`),
 * which cannot grant Pro Max — only a real Stripe subscription can.
 *
 * `repositories/entitlements.ts` re-exports this as `EntitlementTier`, which is
 * the name the server-side call sites use. It is declared here, in the
 * client-safe module, so a tier-keyed allowance can be read by the pricing page
 * as well as by the route that enforces it — the two disagreeing is exactly the
 * bug `SOURCING_SPRINT_LIMITS` had.
 */
export type OrganizationTier = PlanTier | 'pro_max'

export const PLAN_LIMITS: Record<PlanTier, { savedSearches: number; savedBuilders: number; rssSubscriptions: number }> = {
  free: { savedSearches: 3, savedBuilders: 50, rssSubscriptions: 3 },
  pro: { savedSearches: 50, savedBuilders: Infinity, rssSubscriptions: Infinity },
  team: { savedSearches: 200, savedBuilders: Infinity, rssSubscriptions: Infinity },
}

// Matches `organization_entitlements.seat_limit`'s own `between 1 and 10`
// check constraint, and the "Up to 10 team seats" copy in PLAN_PRICING below.
export const PLAN_SEAT_LIMITS: Record<PlanTier, number> = {
  free: 1,
  pro: 1,
  team: 10,
}

// Plan: ai-sourcing-sprints. Counts only `status = 'active'` sprints per
// organization (paused/completed never count against the limit). Gated via
// the organization's entitlement tier (getOrganizationEntitlement), same
// convention as every other organization-scoped resource — NOT the
// personal per-user `plans` table PLAN_LIMITS above is read from.
//
// Keyed by `OrganizationTier`, so Pro Max has its own explicit row. It used to
// be `Record<PlanTier, number>`, which forced the enforcement sites through
// `resolveLegacyPlanTier` (Pro Max → Team) and left the advertised allowance and
// the enforced one free to disagree — they did: `/pricing` promised Pro Max 3
// concurrent sprints while the code allowed 10, and gave Pro 3 without
// advertising any. The numbers here are the enforced behaviour that shipped; no
// organization's allowance changed. Every surface that ADVERTISES the allowance
// now derives its copy from this map through the two formatters below, so a page
// cannot state a number the routes do not honour.
export const SOURCING_SPRINT_LIMITS: Record<OrganizationTier, number> = {
  free: 0,
  pro: 3,
  pro_max: 10,
  team: 10,
}

/**
 * The plan-card bullet form, e.g. `AI sourcing sprints (up to 3)`.
 * `null` for a tier with no allowance — Free gets no bullet advertising zero.
 */
export function sourcingSprintFeature(tier: OrganizationTier): string | null {
  const limit = SOURCING_SPRINT_LIMITS[tier]
  return limit > 0 ? `AI sourcing sprints (up to ${limit})` : null
}

/**
 * The comparison-table cell form, e.g. `Up to 3`. `null` means "no allowance",
 * which the table renders as its own not-included marker rather than as text.
 */
export function sourcingSprintAllowanceLabel(tier: OrganizationTier): string | null {
  const limit = SOURCING_SPRINT_LIMITS[tier]
  return limit > 0 ? `Up to ${limit}` : null
}

/**
 * Builds a feature list, dropping the `null`s a zero allowance produces. Lets a
 * derived bullet sit inline among hand-written ones without each list needing
 * its own filter.
 */
export function compactFeatures(...entries: Array<string | null>): string[] {
  return entries.filter((entry): entry is string => entry !== null)
}

export const PLAN_PRICING: Record<PlanTier, { monthly: number; annual: number; label: string; features: string[] }> = {
  free: {
    monthly: 0,
    annual: 0,
    label: 'Free',
    features: [
      '3 saved searches',
      '50 saved builders',
      'Basic RSS feeds',
      'Public /explore',
      'Public /blog',
    ],
  },
  pro: {
    monthly: 19,
    annual: 182,
    label: 'Pro',
    features: compactFeatures(
      '50 saved searches',
      'Unlimited saved builders',
      'Smart alerts',
      'Semantic search',
      'Code fingerprinting',
      sourcingSprintFeature('pro'),
      'Priority support',
    ),
  },
  team: {
    monthly: 99,
    annual: 950,
    label: 'Team',
    features: compactFeatures(
      'Everything in Pro',
      'Up to 10 team seats',
      'Shared saved searches',
      'Shared builder lists',
      'Work-sample analysis',
      'Team fit analysis',
      'Activity feed',
      sourcingSprintFeature('team'),
      'Priority support',
    ),
  },
}

export interface UserPlan {
  userId: string
  plan: PlanTier
  status: PlanStatus
  planEndsAt: string | null
  trialEndsAt: string | null
  notes: string | null
}

// Still consumed by src/routes/_dashboard/settings/billing.tsx, which builds
// these shapes itself from /api/plans/me's org-based entitlement response —
// not by checkPlatformLimit (deleted: dead code with a latent bug, see
// plans/security-and-multitenancy/tasks.md task 15).
export type LimitResource = 'savedSearches' | 'savedBuilders' | 'rssSubscriptions'

export interface LimitCheck {
  allowed: boolean
  current: number
  limit: number
  plan: PlanTier
  resource: LimitResource
}
