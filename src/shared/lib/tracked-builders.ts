import { db } from '~/shared/lib/db/index'
import { builders } from '~/shared/lib/db/schema'
import { eq } from 'drizzle-orm'

export function trackedKey(source: string, sourceId: string): string {
  return `${source}:${sourceId}`
}

/**
 * All (source, sourceId) pairs the given user has already tracked, as a Set
 * of `trackedKey()`-formatted strings. `builders.id` is per-user (each
 * tracker gets their own row for the same external profile), so this is the
 * only reliable "have I already saved this one" check across the app.
 */
export async function getTrackedKeySet(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ source: builders.source, sourceId: builders.sourceId })
    .from(builders)
    .where(eq(builders.userId, userId))
  return new Set(rows.map((r) => trackedKey(r.source, r.sourceId)))
}

/**
 * Same lookup as `getTrackedKeySet`, but keyed to each row's own `builders.id`
 * instead of a plain Set — callers that need to *act* on an already-tracked
 * result (e.g. offering an "untrack" action) need the row id, since
 * `DELETE /api/builders/:builderId` operates on it, not on (source, sourceId).
 */
export async function getTrackedBuilderIds(userId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: builders.id, source: builders.source, sourceId: builders.sourceId })
    .from(builders)
    .where(eq(builders.userId, userId))
  return new Map(rows.map((r) => [trackedKey(r.source, r.sourceId), r.id]))
}
