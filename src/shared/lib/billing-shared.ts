// Billing types and constants — safe to import on both client and server.
// (The actual server-only helpers live in billing.ts.)

export type PlanTier = 'free' | 'pro' | 'team'
export type PlanStatus = 'active' | 'past_due' | 'canceled' | 'trialing'

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
export const SOURCING_SPRINT_LIMITS: Record<PlanTier, number> = {
  free: 0,
  pro: 3,
  team: 10,
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
    features: [
      '50 saved searches',
      'Unlimited saved builders',
      'Smart alerts',
      'Semantic search',
      'Code fingerprinting',
      'AI sourcing sprints (up to 3)',
      'Priority support',
    ],
  },
  team: {
    monthly: 99,
    annual: 950,
    label: 'Team',
    features: [
      'Everything in Pro',
      'Up to 10 team seats',
      'Shared saved searches',
      'Shared builder lists',
      'Work-sample analysis',
      'Activity feed',
      'AI sourcing sprints (up to 10)',
      'Priority support',
    ],
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

export type LimitResource = 'savedSearches' | 'savedBuilders' | 'rssSubscriptions'

export interface LimitCheck {
  allowed: boolean
  current: number
  limit: number
  plan: PlanTier
  resource: LimitResource
}
