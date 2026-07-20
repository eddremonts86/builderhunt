import { createHash } from 'node:crypto'
import { and, count, desc, eq, gte, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import {
  builderIdentities,
  builderNotes,
  builders,
  organizationBuilders,
  savedQueries,
} from '../db/schema'

export interface TrackOrganizationBuilderInput {
  id: string
  organizationId: string
  creatorUserId: string
  source: string
  sourceId: string
  username: string
  displayName?: string | null
  avatarUrl?: string | null
  bio?: string | null
  profileUrl: string
  followersCount?: number | null
  language?: string | null
  country?: string | null
  topics?: string[]
  score?: number
  metadata?: Record<string, unknown>
}

const privateBuilderFields = {
  id: organizationBuilders.id,
  identityId: builderIdentities.id,
  username: builderIdentities.username,
  displayName: builderIdentities.displayName,
  avatarUrl: builderIdentities.avatarUrl,
  source: builderIdentities.source,
  sourceId: builderIdentities.sourceId,
  bio: builderIdentities.bio,
  profileUrl: builderIdentities.profileUrl,
  followersCount: builderIdentities.followersCount,
  language: builderIdentities.language,
  country: builderIdentities.country,
  privateMetadata: organizationBuilders.privateMetadata,
  lastSeen: builderIdentities.lastSeenAt,
  createdAt: organizationBuilders.createdAt,
}

export function trackedKey(source: string, sourceId: string) {
  return `${source}:${sourceId}`
}

export async function getTrackedKeySet(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<Set<string>> {
  const rows = await trackedRows(transaction, organizationId)
  return new Set(rows.map((row) => trackedKey(row.source, row.sourceId)))
}

export async function getTrackedBuilderIds(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<Map<string, string>> {
  const rows = await trackedRows(transaction, organizationId)
  return new Map(rows.map((row) => [trackedKey(row.source, row.sourceId), row.id]))
}

export function listOrganizationBuilders(transaction: TenantTransaction, organizationId: string) {
  return transaction.select(privateBuilderFields)
    .from(organizationBuilders)
    .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
    .where(eq(organizationBuilders.organizationId, organizationId))
    .orderBy(desc(builderIdentities.lastSeenAt))
}

export function listRecentOrganizationBuilders(
  transaction: TenantTransaction,
  organizationId: string,
  limit = 6,
) {
  return transaction.select(privateBuilderFields)
    .from(organizationBuilders)
    .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
    .where(eq(organizationBuilders.organizationId, organizationId))
    .orderBy(desc(builderIdentities.lastSeenAt))
    .limit(limit)
}

export async function countOrganizationBuilders(transaction: TenantTransaction, organizationId: string) {
  const [row] = await transaction.select({ value: count() })
    .from(organizationBuilders)
    .where(eq(organizationBuilders.organizationId, organizationId))
  return Number(row?.value ?? 0)
}

export async function findOrganizationBuilderBySource(
  transaction: TenantTransaction,
  organizationId: string,
  source: string,
  sourceId: string,
) {
  const [row] = await transaction.select({ id: organizationBuilders.id })
    .from(organizationBuilders)
    .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
    .where(and(
      eq(organizationBuilders.organizationId, organizationId),
      eq(builderIdentities.source, source),
      eq(builderIdentities.sourceId, sourceId),
    ))
    .limit(1)
  return row ?? null
}

export async function findOrganizationBuilder(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
) {
  const [row] = await transaction.select(privateBuilderFields)
    .from(organizationBuilders)
    .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
    .where(and(eq(organizationBuilders.organizationId, organizationId), eq(organizationBuilders.id, id)))
    .limit(1)
  return row ?? null
}

/**
 * Looks up a tracked builder by the org's own membership, keyed by the
 * global `builderIdentities.id` (not `organizationBuilders.id`). Used by
 * `GET /api/builders/:id` so an authenticated recruiter can open the
 * profile page for any builder they've tracked, without requiring the
 * builder to have gone through the separate claim/publish flow that backs
 * `findPublishedBuilderProfile` (the anonymous-safe public path).
 */
export async function findOrganizationBuilderByIdentity(
  transaction: TenantTransaction,
  organizationId: string,
  builderIdentityId: string,
) {
  const [row] = await transaction.select(privateBuilderFields)
    .from(organizationBuilders)
    .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
    .where(and(
      eq(organizationBuilders.organizationId, organizationId),
      eq(organizationBuilders.builderIdentityId, builderIdentityId),
    ))
    .limit(1)
  return row ?? null
}

export async function trackOrganizationBuilder(
  transaction: TenantTransaction,
  input: TrackOrganizationBuilderInput,
) {
  const identityId = createHash('sha256')
    .update(`${input.source}\0${input.sourceId}`)
    .digest('hex')

  await transaction.insert(builderIdentities).values({
    id: identityId,
    source: input.source,
    sourceId: input.sourceId,
    username: input.username,
    displayName: input.displayName ?? null,
    avatarUrl: input.avatarUrl ?? null,
    bio: input.bio ?? null,
    profileUrl: input.profileUrl,
    followersCount: input.followersCount ?? 0,
    language: input.language ?? null,
    country: input.country ?? null,
  }).onConflictDoUpdate({
    target: [builderIdentities.source, builderIdentities.sourceId],
    set: {
      username: input.username,
      displayName: input.displayName ?? null,
      avatarUrl: input.avatarUrl ?? null,
      bio: input.bio ?? null,
      profileUrl: input.profileUrl,
      followersCount: input.followersCount ?? 0,
      language: input.language ?? null,
      country: input.country ?? null,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    },
  })

  const [existing] = await transaction.select({ id: organizationBuilders.id })
    .from(organizationBuilders)
    .where(and(
      eq(organizationBuilders.organizationId, input.organizationId),
      eq(organizationBuilders.builderIdentityId, identityId),
    ))
    .limit(1)
  const trackingId = existing?.id ?? input.id
  const privateMetadata = {
    ...(input.metadata ?? {}),
    topics: input.topics ?? [],
    score: input.score ?? null,
  }

  await transaction.insert(builders).values({
    id: trackingId,
    organizationId: input.organizationId,
    userId: input.creatorUserId,
    source: input.source,
    sourceId: input.sourceId,
    username: input.username,
    displayName: input.displayName ?? null,
    avatarUrl: input.avatarUrl ?? null,
    bio: input.bio ?? null,
    profileUrl: input.profileUrl,
    followersCount: input.followersCount ?? 0,
    language: input.language ?? null,
    country: input.country ?? null,
    topics: input.topics ?? [],
    metadata: { ...(input.metadata ?? {}), score: input.score ?? null },
  }).onConflictDoNothing()

  await transaction.insert(organizationBuilders).values({
    id: trackingId,
    organizationId: input.organizationId,
    builderIdentityId: identityId,
    creatorUserId: input.creatorUserId,
    privateMetadata,
  }).onConflictDoUpdate({
    target: [organizationBuilders.organizationId, organizationBuilders.builderIdentityId],
    set: { privateMetadata, updatedAt: new Date() },
  })

  return { id: trackingId, identityId, tracked: true as const, existed: Boolean(existing) }
}

export async function updateOrganizationBuilder(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
  update: { topics?: string[]; country?: string | null; language?: string | null },
) {
  const existing = await findOrganizationBuilder(transaction, organizationId, id)
  if (!existing) return null
  const privateMetadata = {
    ...existing.privateMetadata,
    ...(update.topics === undefined ? {} : { topics: update.topics }),
    ...(update.country === undefined ? {} : { country: update.country }),
    ...(update.language === undefined ? {} : { language: update.language }),
  }
  await transaction.update(organizationBuilders)
    .set({ privateMetadata, updatedAt: new Date() })
    .where(and(eq(organizationBuilders.organizationId, organizationId), eq(organizationBuilders.id, id)))
  await transaction.update(builders)
    .set({ ...update, updatedAt: new Date() })
    .where(and(eq(builders.organizationId, organizationId), eq(builders.id, id)))
  return { ...existing, privateMetadata }
}

export async function deleteOrganizationBuilder(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
) {
  const existing = await findOrganizationBuilder(transaction, organizationId, id)
  if (!existing) return false
  await transaction.delete(builderNotes)
    .where(and(eq(builderNotes.organizationId, organizationId), eq(builderNotes.builderId, id)))
  await transaction.delete(organizationBuilders)
    .where(and(eq(organizationBuilders.organizationId, organizationId), eq(organizationBuilders.id, id)))
  await transaction.delete(builders)
    .where(and(eq(builders.organizationId, organizationId), eq(builders.id, id)))
  return true
}

export function listOrganizationBuilderNotes(
  transaction: TenantTransaction,
  organizationId: string,
  builderId: string,
) {
  return transaction.select({
    id: builderNotes.id,
    builderId: builderNotes.builderId,
    content: builderNotes.content,
    createdAt: builderNotes.createdAt,
    updatedAt: builderNotes.updatedAt,
  }).from(builderNotes)
    .where(and(eq(builderNotes.organizationId, organizationId), eq(builderNotes.builderId, builderId)))
    .orderBy(builderNotes.createdAt)
}

export async function createOrganizationBuilderNote(
  transaction: TenantTransaction,
  input: { id: string; organizationId: string; userId: string; builderId: string; content: string },
) {
  const builder = await findOrganizationBuilder(transaction, input.organizationId, input.builderId)
  if (!builder) return null
  const [note] = await transaction.insert(builderNotes).values(input).returning({
    id: builderNotes.id,
    builderId: builderNotes.builderId,
    content: builderNotes.content,
    createdAt: builderNotes.createdAt,
    updatedAt: builderNotes.updatedAt,
  })
  return note
}

export async function getOrganizationDashboardStats(
  transaction: TenantTransaction,
  organizationId: string,
  activeSince: Date,
) {
  const [[total], [active], [queries], [notes], dailyRows] = await Promise.all([
    transaction.select({ value: count() }).from(organizationBuilders)
      .where(eq(organizationBuilders.organizationId, organizationId)),
    transaction.select({ value: count() }).from(organizationBuilders)
      .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
      .where(and(eq(organizationBuilders.organizationId, organizationId), gte(builderIdentities.lastSeenAt, activeSince))),
    transaction.select({ value: count() }).from(savedQueries)
      .where(eq(savedQueries.organizationId, organizationId)),
    transaction.select({ value: count() }).from(builderNotes)
      .where(eq(builderNotes.organizationId, organizationId)),
    // Real per-day breakdown of activity in the window, used to render the
    // dashboard's weekly activity chart without resorting to mock data.
    transaction.select({
      day: sql<string>`to_char(date_trunc('day', ${builderIdentities.lastSeenAt}), 'YYYY-MM-DD')`,
      value: sql<number>`count(*)::int`,
    }).from(organizationBuilders)
      .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
      .where(and(eq(organizationBuilders.organizationId, organizationId), gte(builderIdentities.lastSeenAt, activeSince)))
      .groupBy(sql`date_trunc('day', ${builderIdentities.lastSeenAt})`),
  ])

  const dailyCounts = new Map(dailyRows.map((row) => [row.day, row.value]))
  const dailyActivity = Array.from({ length: 7 }, (_, i) => {
    const date = new Date()
    date.setDate(date.getDate() - (6 - i))
    const iso = date.toISOString().slice(0, 10)
    return {
      date: iso,
      label: date.toLocaleDateString('en-US', { weekday: 'short' }),
      count: dailyCounts.get(iso) ?? 0,
    }
  })

  return {
    totalBuilders: Number(total?.value ?? 0),
    activeThisWeek: Number(active?.value ?? 0),
    savedQueries: Number(queries?.value ?? 0),
    totalNotes: Number(notes?.value ?? 0),
    dailyActivity,
  }
}

function trackedRows(transaction: TenantTransaction, organizationId: string) {
  return transaction.select({
    id: organizationBuilders.id,
    source: builderIdentities.source,
    sourceId: builderIdentities.sourceId,
  }).from(organizationBuilders)
    .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
    .where(eq(organizationBuilders.organizationId, organizationId))
}
