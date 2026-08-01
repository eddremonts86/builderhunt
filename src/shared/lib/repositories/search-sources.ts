/**
 * The operator register for people-search connectors.
 *
 * Before this existed, which connectors ran was decided entirely by the caller: `sources` on the
 * request narrowed a hardcoded list in `src/lib/search.ts`, and nothing above the request could say
 * "stop contacting this site". This module is that switch — read on every search, so flipping a row
 * takes effect on the next query rather than the next deploy.
 *
 * Read through the app role (SELECT only) and written through the platform role. That split is the
 * point: nothing on the search path can enable a source, so a bug in the search path cannot widen what
 * the platform contacts.
 */
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { publicDb } from '~/shared/lib/db/client'
import { platformDb } from '~/shared/lib/db/platform-db'
import { searchSources } from '~/shared/lib/db/schema'

export type SearchSourceKind =
  | 'official_api' | 'feed' | 'licensed_dataset' | 'user_submission' | 'public_scrape' | 'external_link_only'

export interface SearchSourceRow {
  key: string
  kind: SearchSourceKind
  label: string
  homepageUrl: string
  enabled: boolean
  connectorImplemented: boolean
  allowedHosts: string[]
  storesPersonalData: boolean
  geography: string | null
  rateLimitPerHour: number | null
  retentionDays: number | null
  termsReviewedAt: Date | null
  termsReviewedBy: string | null
  registerNotes: string | null
  updatedAt: Date
}

/**
 * Connector keys the code can actually run, and the one place that list is written down.
 *
 * Must stay in step with `search_sources.connector_implemented`;
 * `assertSearchConnectorRegistryMatchesDatabase` is what proves it does. Duplicating the fact into the
 * database buys a CHECK constraint that refuses `enabled = true` with no connector — worth one
 * assertion to keep honest.
 */
export const IMPLEMENTED_SEARCH_CONNECTORS = [
  'github', 'hn', 'devto', 'reddit', 'lobsters', 'stackoverflow', 'npm', 'huggingface',
  'gitlab', 'codeberg', 'hashnode', 'sourcehut', 'devpost', 'producthunt', 'bluesky',
] as const

export type ImplementedSearchConnector = (typeof IMPLEMENTED_SEARCH_CONNECTORS)[number]

export async function listSearchSources(db: PostgresJsDatabase = publicDb): Promise<SearchSourceRow[]> {
  const rows = await db.select().from(searchSources).orderBy(searchSources.key)
  return rows.map(toSearchSourceRow)
}

export async function findSearchSource(key: string, db: PostgresJsDatabase = publicDb): Promise<SearchSourceRow | null> {
  const [row] = await db.select().from(searchSources).where(eq(searchSources.key, key)).limit(1)
  return row ? toSearchSourceRow(row) : null
}

/**
 * Enabled keys, cached for a few seconds.
 *
 * A search runs up to sixteen connectors and would otherwise read the register on every request. The
 * TTL is deliberately short and deliberately not zero: an operator switching a source off expects it to
 * stop, and waiting a few seconds for that is fine, but waiting for a cache invalidation message is
 * not. `invalidateSearchSourceCache` clears it immediately on a toggle so the common case is instant
 * and the TTL is only the backstop for another process's toggle.
 */
const CACHE_TTL_MS = 5_000
let cache: { keys: Set<string>; at: number } | null = null

export function invalidateSearchSourceCache(): void {
  cache = null
}

export async function loadEnabledSearchSourceKeys(db: PostgresJsDatabase = publicDb): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.keys
  const rows = await db
    .select({ key: searchSources.key })
    .from(searchSources)
    .where(eq(searchSources.enabled, true))
  const keys = new Set(rows.map((row) => row.key))
  cache = { keys, at: Date.now() }
  return keys
}

/**
 * Splits the requested sources into the ones that may run and the ones the register refuses.
 *
 * Returns both halves rather than just the allowed set, because a caller that asked for a source and
 * got silence cannot tell "no results" from "not permitted". `search.ts` reports the refused ones as
 * `disabled` so the UI says so out loud.
 *
 * Fails **closed** on a read error: if the register cannot be read, nothing runs. The alternative —
 * assume everything is permitted when we cannot check — would turn a database blip into every disabled
 * source coming back online at once.
 */
export async function partitionRequestedSources(
  requested: readonly string[],
  db: PostgresJsDatabase = publicDb,
): Promise<{ allowed: string[]; refused: string[] }> {
  let enabled: Set<string>
  try {
    enabled = await loadEnabledSearchSourceKeys(db)
  } catch {
    return { allowed: [], refused: [...requested] }
  }
  const allowed: string[] = []
  const refused: string[] = []
  for (const source of requested) (enabled.has(source) ? allowed : refused).push(source)
  return { allowed, refused }
}

export type SearchSourceToggleOutcome =
  | { status: 'updated'; enabled: boolean }
  | { status: 'unchanged'; enabled: boolean }
  | { status: 'not_found' }
  /** `public_scrape` with no recorded terms review. The database would refuse this too; returning it
   * here is what lets the route answer 409 with a reason instead of surfacing a constraint error. */
  | { status: 'review_required' }
  /** No connector exists, so there is nothing to switch on. */
  | { status: 'no_connector' }

export async function setSearchSourceEnabled(
  input: { key: string; enabled: boolean },
  db: PostgresJsDatabase = platformDb,
): Promise<SearchSourceToggleOutcome> {
  const [existing] = await db
    .select({
      kind: searchSources.kind,
      enabled: searchSources.enabled,
      connectorImplemented: searchSources.connectorImplemented,
      termsReviewedAt: searchSources.termsReviewedAt,
    })
    .from(searchSources)
    .where(eq(searchSources.key, input.key))
    .limit(1)
  if (!existing) return { status: 'not_found' }
  if (existing.enabled === input.enabled) return { status: 'unchanged', enabled: existing.enabled }
  if (input.enabled && !existing.connectorImplemented) return { status: 'no_connector' }
  if (input.enabled && existing.kind === 'public_scrape' && existing.termsReviewedAt === null) {
    return { status: 'review_required' }
  }

  const updated = await db
    .update(searchSources)
    .set({ enabled: input.enabled, updatedAt: new Date() })
    .where(eq(searchSources.key, input.key))
    .returning({ enabled: searchSources.enabled })
  if (updated.length === 0) return { status: 'not_found' }
  invalidateSearchSourceCache()
  return { status: 'updated', enabled: updated[0].enabled }
}

/**
 * Records that a human reviewed this source's terms, robots policy and privacy posture.
 *
 * Separate from the toggle for the same reason as on the solutions side: reviewing and enabling are two
 * decisions, and one call that did both would let one click do both.
 */
export async function recordSearchSourceTermsReview(
  input: { key: string; reviewerUserId: string; notes?: string; at?: Date },
  db: PostgresJsDatabase = platformDb,
): Promise<boolean> {
  const at = input.at ?? new Date()
  const updated = await db
    .update(searchSources)
    .set({
      termsReviewedAt: at,
      termsReviewedBy: input.reviewerUserId,
      ...(input.notes === undefined ? {} : { registerNotes: input.notes }),
      updatedAt: at,
    })
    .where(eq(searchSources.key, input.key))
    .returning({ key: searchSources.key })
  return updated.length > 0
}

/**
 * Proves `connector_implemented` still describes the code.
 *
 * The column exists so a CHECK can refuse `enabled = true` with no connector, which means a stale
 * column would either block a working connector or permit a missing one. Both directions are reported:
 * a row claiming a connector the code does not have, and a connector the register never heard of.
 */
export async function assertSearchConnectorRegistryMatchesDatabase(
  db: PostgresJsDatabase = publicDb,
): Promise<{ claimedButAbsent: string[]; presentButUnregistered: string[] }> {
  const rows = await db
    .select({ key: searchSources.key, connectorImplemented: searchSources.connectorImplemented })
    .from(searchSources)
  const inCode = new Set<string>(IMPLEMENTED_SEARCH_CONNECTORS)
  const registered = new Set(rows.map((row) => row.key))
  return {
    claimedButAbsent: rows.filter((row) => row.connectorImplemented && !inCode.has(row.key)).map((row) => row.key),
    presentButUnregistered: [...inCode].filter((key) => !registered.has(key)),
  }
}

function toSearchSourceRow(row: typeof searchSources.$inferSelect): SearchSourceRow {
  return {
    key: row.key,
    kind: row.kind as SearchSourceKind,
    label: row.label,
    homepageUrl: row.homepageUrl,
    enabled: row.enabled,
    connectorImplemented: row.connectorImplemented,
    allowedHosts: (row.allowedHosts ?? []) as string[],
    storesPersonalData: row.storesPersonalData,
    geography: row.geography,
    rateLimitPerHour: row.rateLimitPerHour,
    retentionDays: row.retentionDays,
    termsReviewedAt: row.termsReviewedAt,
    termsReviewedBy: row.termsReviewedBy,
    registerNotes: row.registerNotes,
    updatedAt: row.updatedAt,
  }
}
