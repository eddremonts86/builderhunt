/**
 * Connector keys the code can actually run, and the one place that list is written down.
 *
 * Must stay in step with `search_sources.connector_implemented`;
 * `assertSearchConnectorRegistryMatchesDatabase` is what proves it does. Duplicating the fact into the
 * database buys a CHECK constraint that refuses `enabled = true` with no connector — worth one
 * assertion to keep honest.
 *
 * It lives in its own module, apart from `repositories/search-sources.ts` which re-exports it, for one
 * reason: that repository imports `publicDb`/`platformDb`, so anything a *client* component imports
 * from it drags `postgres` into the browser bundle. Public copy needs the count (see
 * `SEARCH_SOURCE_COUNT`), and this file has no imports at all, so it is safe from either side.
 */
export const IMPLEMENTED_SEARCH_CONNECTORS = [
  // Two keys left this list on 2026-08-04 with their connectors, and `search_sources.connector_implemented` is
  // false for both to match — `assertSearchConnectorRegistryMatchesDatabase` is what proves the two agree:
  //   * `sourcehut` (drizzle/0143) — sr.ht's robots.txt disallows "anything used to feed a machine learning
  //     model", which is what this product does, so no token could make the connector legitimate.
  //   * `hashnode` (drizzle/0144) — Hashnode moved its public GraphQL API behind a paid plan.
  'github', 'hn', 'devto', 'reddit', 'lobsters', 'stackoverflow', 'npm', 'huggingface',
  'gitlab', 'codeberg', 'devpost', 'producthunt', 'bluesky',
] as const

export type ImplementedSearchConnector = (typeof IMPLEMENTED_SEARCH_CONNECTORS)[number]

/**
 * How many sources public copy may claim BuilderHunt searches.
 *
 * Nine surfaces hardcoded "12 sources" — the referral landing, the explore OG image, the blog CTA,
 * four onboarding screens and the landing FAQ — and every one of them went stale on 2026-08-04 when
 * `sourcehut` and `hashnode` were retired and the real number moved. A count in prose is a claim like
 * any other, so it reads from the registry that decides it.
 */
export const SEARCH_SOURCE_COUNT = IMPLEMENTED_SEARCH_CONNECTORS.length

/**
 * Rows the source register may hold.
 *
 * Not a page size and not a guess: every row in `search_sources` arrives by migration — the thirteen
 * connectors above, the two retired ones whose rows stay behind disabled, and the four
 * external-link-only platforms. A deployment cannot grow this table by being used, so a `.limit()`
 * derived from it truncates nothing; adding a source means writing a migration, and this number
 * moves in the same commit.
 *
 * `assertSearchConnectorRegistryMatchesDatabase` checks the register has not outgrown it, so the
 * bound cannot start silently truncating between the migration and someone noticing.
 */
export const SEARCH_SOURCE_REGISTER_LIMIT = 64
