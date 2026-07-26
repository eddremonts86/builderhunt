/**
 * Global suppression enforcement (plan: audit-trust, spec.md "Enforcement surfaces"). Every
 * consumer that can surface or cache a builder identity — live federated search results and its
 * two cache layers, `/api/builders/track`, public `GET /api/builders/$builderId`, recent/
 * recommendation endpoints, exports, feeds, and alert workers — must filter through this after
 * reading from any cache and before writing to one.
 *
 * `profile-removal.ts`'s verify step deletes matching `builders` rows immediately, but
 * `src/lib/search.ts`'s live-fetch/memory/Redis cache layers hold raw federated results keyed by
 * arbitrary (keywords, sources, page, ...) tuples — there is no practical way to enumerate and
 * evict every cache key that might contain a given identity. This filter is the correctness
 * backstop spec.md calls for ("dynamic filtering remains the correctness backstop"): a small,
 * process-local, short-TTL cache of active `(source, sourceId)` pairs, checked on every read.
 */
import { listActiveSuppressions } from './repositories/profile-removal'

interface SuppressionCacheEntry {
  keys: Set<string>
  loadedAt: number
}

let cacheEntry: SuppressionCacheEntry | null = null
const SUPPRESSION_CACHE_TTL_MS = 60_000

function suppressionKey(source: string, sourceId: string): string {
  return `${source}:${sourceId}`
}

async function loadActiveSuppressionKeys(): Promise<Set<string>> {
  if (cacheEntry && Date.now() - cacheEntry.loadedAt < SUPPRESSION_CACHE_TTL_MS) {
    return cacheEntry.keys
  }
  const rows = await listActiveSuppressions()
  const keys = new Set(rows.map((row) => suppressionKey(row.source, row.sourceId)))
  cacheEntry = { keys, loadedAt: Date.now() }
  return keys
}

/** Drops the in-process cache immediately — call right after a verification inserts a new
 * suppression so the very next read in this process sees it without waiting out the TTL. Other
 * server processes still converge within `SUPPRESSION_CACHE_TTL_MS` (60s), well inside spec.md's
 * 5-minute p95 removal-latency budget. */
export function invalidateSuppressionCache(): void {
  cacheEntry = null
}

export async function isSuppressed(source: string, sourceId: string): Promise<boolean> {
  const keys = await loadActiveSuppressionKeys()
  return keys.has(suppressionKey(source, sourceId))
}

/** Filters any list of `{source, sourceId}`-shaped items — federated search results, builder rows,
 * export rows, feed entries, alert candidates — dropping every currently-suppressed identity. */
export async function filterSuppressed<T extends { source: string; sourceId: string }>(items: T[]): Promise<T[]> {
  if (items.length === 0) return items
  const keys = await loadActiveSuppressionKeys()
  if (keys.size === 0) return items
  return items.filter((item) => !keys.has(suppressionKey(item.source, item.sourceId)))
}
