import type { CatalogTier } from './catalog'

/**
 * Server-owned, versioned per-operation billing limits
 * (plans/stripe-billing-platform/tasks.md §4 "Expose server-only feature
 * billing contracts"). Every reservation goes through `getRateCard` — client
 * input can never widen `maxUnits`/`maxDurationSeconds` beyond what's defined
 * here (spec.md: "Client input cannot extend operation limits").
 *
 * `minimumTier: null` means available to every tier including free (no
 * subscription required). Bumping a rate card's numbers for an operation
 * that's already live should also bump `version` — `billing_credit_reservations.rateCardVersion`
 * records which version governed a given reservation, so a rate change never
 * silently reinterprets history.
 */

export interface RateCard {
  operation: string
  version: number
  maxUnits: number
  maxDurationSeconds: number
  settlementGraceSeconds: number
  minimumTier: CatalogTier | null
}

const TIER_RANK: Record<CatalogTier, number> = { free: 0, pro: 1, pro_max: 2, team: 2 }

export const RATE_CARDS: Record<string, RateCard> = {
  ai_sourcing_sprint: {
    operation: 'ai_sourcing_sprint', version: 1, maxUnits: 50, maxDurationSeconds: 600,
    settlementGraceSeconds: 120, minimumTier: 'pro_max',
  },
  semantic_search_query: {
    operation: 'semantic_search_query', version: 1, maxUnits: 5, maxDurationSeconds: 30,
    settlementGraceSeconds: 30, minimumTier: 'pro',
  },
  builder_work_sample_analysis: {
    operation: 'builder_work_sample_analysis', version: 1, maxUnits: 20, maxDurationSeconds: 180,
    settlementGraceSeconds: 60, minimumTier: 'pro_max',
  },
}

export function getRateCard(operation: string): RateCard | null {
  return RATE_CARDS[operation] ?? null
}

/** Whether `tier` meets or exceeds `minimumTier` — `pro_max` and `team` rank equally (catalog.ts: Team includes everything Pro Max has). */
export function tierMeetsMinimum(tier: CatalogTier, minimumTier: CatalogTier | null): boolean {
  if (!minimumTier) return true
  return TIER_RANK[tier] >= TIER_RANK[minimumTier]
}
