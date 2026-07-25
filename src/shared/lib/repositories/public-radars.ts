import { and, eq, inArray, sql } from 'drizzle-orm'
import { publicDb } from '../db/client'
import { organizations, publicRadars, savedQueries } from '../db/schema'

export interface PublicRadarQuery {
  name: string
  keywords: string[]
  sources: string[] | null
  language: string | null
  country: string | null
}

/** Plain lookup — `public_radars` carries no RLS, so this needs no tenant context. */
export async function findPublicRadarBySlug(slug: string) {
  const [radar] = await publicDb.select().from(publicRadars)
    .where(eq(publicRadars.slug, slug)).limit(1)
  return radar ?? null
}

/** Existing share for a saved query, if any (used for idempotent re-share). */
export async function findPublicRadarBySavedQueryId(savedQueryId: string) {
  const [radar] = await publicDb.select().from(publicRadars)
    .where(eq(publicRadars.savedQueryId, savedQueryId)).limit(1)
  return radar ?? null
}

/**
 * Resolves the underlying saved query + owning organization's display name
 * for a public radar, from an already-resolved (organizationId, savedQueryId)
 * pair. Both `saved_queries` and `organizations` carry RLS, so this manually
 * scopes a transaction to that organization — same technique as
 * `repositories/public-feeds.ts`'s `findCapabilitySavedQuery`, since there is
 * no authenticated principal on the public `/r/$slug` request to derive
 * `app.organization_id` from otherwise.
 */
export async function getPublicRadarQuery(
  organizationId: string,
  savedQueryId: string,
): Promise<{ query: PublicRadarQuery; organizationName: string } | null> {
  return publicDb.transaction(async (transaction) => {
    await transaction.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`)
    const [query] = await transaction.select({
      name: savedQueries.name,
      keywords: savedQueries.keywords,
      sources: savedQueries.sources,
      language: savedQueries.language,
      country: savedQueries.country,
    }).from(savedQueries)
      .where(and(eq(savedQueries.organizationId, organizationId), eq(savedQueries.id, savedQueryId)))
      .limit(1)
    if (!query) return null

    const [org] = await transaction.select({ name: organizations.name }).from(organizations)
      .where(eq(organizations.id, organizationId)).limit(1)

    return { query, organizationName: org?.name ?? 'a BuilderHunt user' }
  })
}

/** Bulk lookup for the saved-queries list endpoint, so each row can show its share state. */
export async function listPublicRadarSlugsForSavedQueryIds(savedQueryIds: string[]): Promise<Map<string, string>> {
  if (savedQueryIds.length === 0) return new Map()
  const rows = await publicDb.select({ savedQueryId: publicRadars.savedQueryId, slug: publicRadars.slug })
    .from(publicRadars)
    .where(inArray(publicRadars.savedQueryId, savedQueryIds))
  return new Map(rows.map((row) => [row.savedQueryId, row.slug]))
}

/** Insert-only — callers must have already verified ownership of the saved query. */
export async function createPublicRadar(organizationId: string, savedQueryId: string, slug: string) {
  const [radar] = await publicDb.insert(publicRadars).values({
    savedQueryId,
    organizationId,
    slug,
  }).returning()
  return radar
}

/** All shared radar slugs, for sitemap.xml. */
export async function listAllPublicRadarSlugs(): Promise<{ slug: string; createdAt: Date }[]> {
  return publicDb.select({ slug: publicRadars.slug, createdAt: publicRadars.createdAt }).from(publicRadars)
}

export async function deletePublicRadar(organizationId: string, savedQueryId: string): Promise<boolean> {
  const result = await publicDb.delete(publicRadars)
    .where(and(eq(publicRadars.organizationId, organizationId), eq(publicRadars.savedQueryId, savedQueryId)))
    .returning({ savedQueryId: publicRadars.savedQueryId })
  return result.length > 0
}
