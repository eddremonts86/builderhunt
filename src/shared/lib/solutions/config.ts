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
 * The rate-card keys below are **derived from `billing/rate-cards.ts`, not declared here.** They used to
 * be local constants naming `solutions.generate.v1` — an operation the billing platform had never heard
 * of, so any `reserveCredits` call with it would have thrown `unknown_feature`. Solutions code could not
 * actually have billed anything. The interview module shipped and then fixed the identical mistake, and
 * its note in `interview-config.ts` is what made this one findable.
 *
 * One price, one source. A rate change bumps `version` in the registry and every caller follows.
 */
import type { CatalogTier } from '../billing/catalog'
import { getRateCard } from '../billing/rate-cards'
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
 * The two Solutions operations, mapped to their registry keys.
 *
 * spec.md names them `solutions.generate.v1` and `solutions.regenerate.v1`; the registry's own identifiers are
 * snake_case like every other card, and the version lives in the card's `version` field rather than in its
 * name. This map is the only place the two naming schemes meet.
 */
const SOLUTIONS_OPERATIONS = {
  generate: 'solutions_generate',
  regenerate: 'solutions_regenerate',
} as const

export type SolutionsRateCardOperation = keyof typeof SOLUTIONS_OPERATIONS

/**
 * Resolves an operation's current price from the registry.
 *
 * Read on every call rather than snapshotted at module load. A frozen snapshot was the first version, and it
 * would have made a rate change take effect only on process restart — so two servers mid-deploy could have
 * quoted and charged different prices for the same operation, with the reservation recording whichever version
 * the process that served it happened to hold.
 *
 * `units` is the card's `maxUnits`, which for these operations is the **whole price** rather than a ceiling:
 * spec.md's premium contract fixes a 10-credit settlement for generate and 3 for regenerate. It is the figure
 * shown to a user before they confirm and the figure settled afterwards; the credit boundary meters no provider
 * usage. See `~/shared/lib/billing/rate-cards.ts` for why it is a price and not a budget.
 *
 * Throws rather than returning undefined on either failure: a caller builds a real reservation from this, and a
 * silent fallback would misprice it. A missing card means this map and the registry disagree about what exists,
 * which would otherwise surface as an `unknown_feature` reservation failure at the worst possible moment —
 * after a user confirmed a charge.
 */
export function getSolutionsRateCardKey(operation: string): SolutionsRateCardKey {
  const operationKey = (SOLUTIONS_OPERATIONS as Record<string, string>)[operation]
  if (!operationKey) throw new Error(`Unknown solutions rate-card operation: ${operation}`)
  const card = getRateCard(operationKey)
  if (!card) throw new Error(`Solutions rate card '${operationKey}' is not registered in billing/rate-cards.ts`)
  return { operationKey: card.operation, version: card.version, units: card.maxUnits }
}

/** Every Solutions operation's current price, for callers that need the whole set (docs, admin surfaces). */
export function listSolutionsRateCardKeys(): Record<SolutionsRateCardOperation, SolutionsRateCardKey> {
  return {
    generate: getSolutionsRateCardKey('generate'),
    regenerate: getSolutionsRateCardKey('regenerate'),
  }
}
