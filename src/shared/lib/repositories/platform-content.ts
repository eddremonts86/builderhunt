import { asc, desc, eq, isNull, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { platformDb } from '../db/client'
import { changelog, incidents, roadmapItems } from '../db/schema'
import { OPERATOR_LIST_LIMIT } from '../db/read-bounds'

export type IncidentCreate = typeof incidents.$inferInsert
export type IncidentUpdate = Partial<typeof incidents.$inferInsert>
export type ChangelogCreate = typeof changelog.$inferInsert
export type ChangelogUpdate = Partial<typeof changelog.$inferInsert>
export type RoadmapCreate = typeof roadmapItems.$inferInsert
export type RoadmapUpdate = Partial<typeof roadmapItems.$inferInsert>

export const listPlatformIncidents = () => platformDb.select().from(incidents).orderBy(desc(incidents.startedAt)).limit(100)
export const createPlatformIncident = (input: IncidentCreate) => platformDb.insert(incidents).values(input)
export async function updatePlatformIncident(id: string, input: IncidentUpdate) {
  const [row] = await platformDb.update(incidents).set(input).where(eq(incidents.id, id)).returning()
  return row ?? null
}

export const listPlatformChangelog = () => platformDb.select().from(changelog).orderBy(desc(changelog.publishedAt)).limit(200)
export const createPlatformChangelog = (input: ChangelogCreate) => platformDb.insert(changelog).values(input)
export async function updatePlatformChangelog(id: string, input: ChangelogUpdate) {
  const [row] = await platformDb.update(changelog).set(input).where(eq(changelog.id, id)).returning()
  return row ?? null
}
export const deletePlatformChangelog = (id: string) => platformDb.delete(changelog).where(eq(changelog.id, id))

// The operator's roadmap board, rendered whole and hand-curated one item at a time.
export const listPlatformRoadmap = () => platformDb.select().from(roadmapItems)
  .orderBy(asc(roadmapItems.sortOrder), desc(roadmapItems.createdAt))
  .limit(OPERATOR_LIST_LIMIT)
export const createPlatformRoadmapItem = (input: RoadmapCreate) => platformDb.insert(roadmapItems).values(input)
export async function updatePlatformRoadmapItem(id: string, input: RoadmapUpdate) {
  const [row] = await platformDb.update(roadmapItems).set(input).where(eq(roadmapItems.id, id)).returning()
  return row ?? null
}
export const deletePlatformRoadmapItem = (id: string) => platformDb.delete(roadmapItems).where(eq(roadmapItems.id, id))

/**
 * Unresolved incidents per severity, with the oldest start (plan 57, Admin track).
 *
 * ## Why not `listPlatformIncidents()` and a filter
 *
 * That one is capped at 100 for the admin table, which is right for a table and wrong for a count: past the cap
 * the number stops growing. Grouping by severity returns one row per severity, so the result size is the
 * vocabulary and not the incident history.
 *
 * ## What "unresolved" means here, and why `status` is not the test
 *
 * `resolvedAt IS NULL`, not `status <> 'resolved'`. The status column is free text with four documented values,
 * so a typo or a fifth value added later would silently drop an incident out of the count — and the one thing an
 * incident aging widget must not do is lose an incident. The timestamp is the fact; the status is the label.
 */
export async function countUnresolvedIncidents(
  db: PostgresJsDatabase = platformDb,
): Promise<Map<string, { open: number; oldestStartedAt: Date | null }>> {
  // unbounded-read-ok: grouped by severity, so this returns at most as many rows as there are severities however
  // long the incident history is. A LIMIT would drop a severity rather than bound anything.
  const rows = await db
    .select({
      severity: incidents.severity,
      open: sql<number>`count(*)::int`,
      oldest: sql<string | null>`min(${incidents.startedAt})`,
    })
    .from(incidents)
    .where(isNull(incidents.resolvedAt))
    .groupBy(incidents.severity)

  const counts = new Map<string, { open: number; oldestStartedAt: Date | null }>()
  for (const row of rows) {
    // Severity is free text in the column, so it is validated rather than trusted: an arbitrary value becoming a
    // metric key would put unbounded label cardinality on an operator page.
    if (!/^[a-z_]{1,32}$/.test(row.severity)) continue
    counts.set(row.severity, {
      open: Number(row.open ?? 0),
      oldestStartedAt: row.oldest ? new Date(row.oldest) : null,
    })
  }
  return counts
}
