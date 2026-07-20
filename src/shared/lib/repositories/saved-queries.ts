import { and, count, desc, eq } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { savedQueries } from '../db/schema'

export interface CreateSavedQueryInput {
  id: string
  organizationId: string
  createdByUserId: string
  name: string
  keywords: string[]
  sources: string[]
  language: string | null
  country: string | null
}

export function listSavedQueries(transaction: TenantTransaction, organizationId: string) {
  return transaction.select().from(savedQueries)
    .where(eq(savedQueries.organizationId, organizationId))
    .orderBy(savedQueries.createdAt)
}

export function listRecentSavedQueries(
  transaction: TenantTransaction,
  organizationId: string,
  limit: number,
) {
  return transaction.select({
    id: savedQueries.id,
    name: savedQueries.name,
    keywords: savedQueries.keywords,
    sources: savedQueries.sources,
  }).from(savedQueries)
    .where(eq(savedQueries.organizationId, organizationId))
    .orderBy(desc(savedQueries.createdAt))
    .limit(limit)
}

export function listLegacySavedQueries(transaction: TenantTransaction, userId: string) {
  return transaction.select().from(savedQueries)
    .where(eq(savedQueries.userId, userId))
    .orderBy(savedQueries.createdAt)
}

export async function countSavedQueries(transaction: TenantTransaction, organizationId: string) {
  const [row] = await transaction.select({ value: count() }).from(savedQueries)
    .where(eq(savedQueries.organizationId, organizationId))
  return Number(row?.value ?? 0)
}

export async function createSavedQuery(transaction: TenantTransaction, input: CreateSavedQueryInput) {
  const [query] = await transaction.insert(savedQueries).values({
    id: input.id,
    organizationId: input.organizationId,
    userId: input.createdByUserId,
    name: input.name,
    keywords: input.keywords,
    sources: input.sources,
    language: input.language,
    country: input.country,
  }).returning()
  return query
}

export async function deleteSavedQuery(transaction: TenantTransaction, organizationId: string, id: string) {
  const result = await transaction.delete(savedQueries)
    .where(and(eq(savedQueries.organizationId, organizationId), eq(savedQueries.id, id)))
    .returning({ id: savedQueries.id })
  return result.length > 0
}
