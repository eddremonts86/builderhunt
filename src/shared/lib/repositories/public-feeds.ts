import { and, eq, sql } from 'drizzle-orm'
import { publicDb } from '../db/client'
import { savedQueries } from '../db/schema'

export function findCapabilitySavedQuery(organizationId: string, searchId: string) {
  return publicDb.transaction(async (transaction) => {
    await transaction.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`)
    const [query] = await transaction.select({
      id: savedQueries.id,
      name: savedQueries.name,
      keywords: savedQueries.keywords,
      sources: savedQueries.sources,
      language: savedQueries.language,
      country: savedQueries.country,
    }).from(savedQueries)
      .where(and(eq(savedQueries.organizationId, organizationId), eq(savedQueries.id, searchId)))
      .limit(1)
    return query ?? null
  })
}
