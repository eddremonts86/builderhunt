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
