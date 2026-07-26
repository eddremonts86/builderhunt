/**
 * Feature flags and immutable rate-card keys for Solutions Intelligence (plan:
 * solutions-intelligence, tasks.md "Define flags and immutable rate-card keys").
 *
 * Each flag gates an independent capability so any one of them can be disabled without
 * disabling the others — spec.md/design doc: "Feature flags independently control catalog
 * ingestion, public scraping, live enrichment, LLM interpretation, external human profiles, and
 * paid generation. Disabling `Solutions` never removes saved briefs or results and never
 * affects ordinary builder search." All default OFF in every environment; each must be turned
 * on deliberately once its own prerequisite review has passed (source register sign-off for
 * scraping, billing certification for paid generation, etc.).
 *
 * This file does NOT register these operations with the billing platform's own
 * `RATE_CARDS` map (`billing/rate-cards.ts`) — that's a separate, later task ("Register
 * Solutions rate cards with billing") gated on cost-benchmark certification. These are the
 * module's own immutable local constants: `operationKey`/`units`/`version` are what
 * `solutions/*` code imports to build a reservation request, but the billing platform's rate
 * card is still the actual source of truth once registered.
 */
import type { CatalogTier } from '../billing/catalog'
import { env } from '../env'

export interface SolutionsFeatureFlags {
  /** Ingesting official-API/feed/licensed-dataset catalog metadata into `solution_*` tables. */
  catalogIngestionEnabled: boolean
  /** Compliant public crawl/scrape ingestion, reusing the enrichment registry's policies. */
  publicScrapeEnabled: boolean
  /** Live, per-run source freshness lookups (as opposed to the durable catalog alone). */
  liveEnrichmentEnabled: boolean
  /** LLM brief interpretation (`interpret.ts`). */
  interpretationEnabled: boolean
  /** LLM route explanation (`explain.ts`). */
  explanationEnabled: boolean
  /** Showing real, non-BuilderHunt external human profiles as Human-lane candidates. */
  externalHumanEnabled: boolean
  /** The premium paid path (`solutions.generate.v1`/`solutions.regenerate.v1`) — everything
   * else in this list can be on in a staff-only/internal-evaluation mode while this stays off. */
  paidGenerationEnabled: boolean
}

export function getSolutionsFeatureFlags(): SolutionsFeatureFlags {
  return {
    catalogIngestionEnabled: env.SOLUTIONS_CATALOG_INGESTION_ENABLED === 'true',
    publicScrapeEnabled: env.SOLUTIONS_PUBLIC_SCRAPE_ENABLED === 'true',
    liveEnrichmentEnabled: env.SOLUTIONS_LIVE_ENRICHMENT_ENABLED === 'true',
    interpretationEnabled: env.SOLUTIONS_INTERPRETATION_ENABLED === 'true',
    explanationEnabled: env.SOLUTIONS_EXPLANATION_ENABLED === 'true',
    externalHumanEnabled: env.SOLUTIONS_EXTERNAL_HUMAN_ENABLED === 'true',
    paidGenerationEnabled: env.SOLUTIONS_PAID_GENERATION_ENABLED === 'true',
  }
}

/** spec.md "Premium contract": available to active `pro`, `pro_max`, and `team` organizations only — never `free`. */
export const SOLUTIONS_ENTITLEMENT_TIERS: readonly Exclude<CatalogTier, 'free'>[] = ['pro', 'pro_max', 'team']

export interface SolutionsRateCardKey {
  operationKey: string
  version: number
  units: number
}

/**
 * Immutable — bumping units for an operation that's already live must mint a new `version`
 * rather than mutate this entry in place, so a historical run's settlement always resolves the
 * rate-card version that actually governed it (same convention as `billing/rate-cards.ts`).
 */
export const SOLUTIONS_RATE_CARD_KEYS = {
  generate: { operationKey: 'solutions.generate.v1', version: 1, units: 10 } as const satisfies SolutionsRateCardKey,
  regenerate: { operationKey: 'solutions.regenerate.v1', version: 1, units: 3 } as const satisfies SolutionsRateCardKey,
} as const
