// Billing types and constants — safe to import on both client and server.
// (The actual server-only helpers live in billing.ts.)

export type PlanTier = 'free' | 'pro' | 'team'
export type PlanStatus = 'active' | 'past_due' | 'canceled' | 'trialing'

export const PLAN_LIMITS: Record<PlanTier, { savedSearches: number; savedBuilders: number; rssSubscriptions: number }> = {
  free: { savedSearches: 3, savedBuilders: 50, rssSubscriptions: 3 },
  pro: { savedSearches: 50, savedBuilders: Infinity, rssSubscriptions: Infinity },
  team: { savedSearches: 200, savedBuilders: Infinity, rssSubscriptions: Infinity },
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
