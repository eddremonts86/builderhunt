import { asc, desc, eq } from 'drizzle-orm'
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
