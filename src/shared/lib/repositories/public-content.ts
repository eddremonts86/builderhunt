import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { publicDb } from '../db/client'
import { changelog, incidents, roadmapItems, roadmapVotes } from '../db/schema'

const incidentPublicFields = {
  id: incidents.id,
  title: incidents.title,
  description: incidents.description,
  status: incidents.status,
  severity: incidents.severity,
  affectedComponents: incidents.affectedComponents,
  startedAt: incidents.startedAt,
  identifiedAt: incidents.identifiedAt,
  resolvedAt: incidents.resolvedAt,
  createdAt: incidents.createdAt,
}

const changelogPublicFields = {
  id: changelog.id,
  title: changelog.title,
  content: changelog.content,
  slug: changelog.slug,
  tags: changelog.tags,
  publishedAt: changelog.publishedAt,
  createdAt: changelog.createdAt,
}

const roadmapPublicFields = {
  id: roadmapItems.id,
  title: roadmapItems.title,
  description: roadmapItems.description,
  status: roadmapItems.status,
  shipEstimate: roadmapItems.shipEstimate,
  category: roadmapItems.category,
  sortOrder: roadmapItems.sortOrder,
  shippedAt: roadmapItems.shippedAt,
  createdAt: roadmapItems.createdAt,
  updatedAt: roadmapItems.updatedAt,
}

export function listPublicIncidents() {
  return publicDb
    .select(incidentPublicFields)
    .from(incidents)
    .orderBy(desc(incidents.startedAt))
    .limit(50)
}

export function listPublicChangelogEntries() {
  return publicDb
    .select(changelogPublicFields)
    .from(changelog)
    .orderBy(desc(changelog.publishedAt))
    .limit(50)
}

export async function findPublicChangelogEntryBySlug(slug: string) {
  const [entry] = await publicDb
    .select(changelogPublicFields)
    .from(changelog)
    .where(eq(changelog.slug, slug))
    .limit(1)
  return entry ?? null
}

export async function listPublicRoadmap(userId?: string) {
  const [items, counts, votes] = await Promise.all([
    publicDb
      .select(roadmapPublicFields)
      .from(roadmapItems)
      .orderBy(asc(roadmapItems.sortOrder), asc(roadmapItems.createdAt)),
    publicDb
      .select({ itemId: roadmapVotes.itemId, count: sql<number>`count(*)::int` })
      .from(roadmapVotes)
      .groupBy(roadmapVotes.itemId),
    userId
      ? publicDb
          .select({ itemId: roadmapVotes.itemId })
          .from(roadmapVotes)
          .where(eq(roadmapVotes.userId, userId))
      : Promise.resolve([]),
  ])
  const countByItem = new Map(counts.map((row) => [row.itemId, row.count]))
  const votedItems = new Set(votes.map((row) => row.itemId))
  return items.map((item) => ({
    ...item,
    voteCount: countByItem.get(item.id) ?? 0,
    userHasVoted: votedItems.has(item.id),
  }))
}

export function togglePublicRoadmapVote(userId: string, itemId: string) {
  return publicDb.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: roadmapVotes.id })
      .from(roadmapVotes)
      .where(and(eq(roadmapVotes.itemId, itemId), eq(roadmapVotes.userId, userId)))
      .limit(1)
    if (existing) {
      await tx.delete(roadmapVotes).where(eq(roadmapVotes.id, existing.id))
      return false
    }
    await tx.insert(roadmapVotes).values({ id: crypto.randomUUID(), itemId, userId })
    return true
  })
}
