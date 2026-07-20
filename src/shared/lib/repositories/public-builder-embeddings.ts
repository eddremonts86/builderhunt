// Public (non-tenant) repository for the global `builder_embeddings` table.
// Every function here uses `publicDb` directly — never `withTenantContext` —
// since this table has no organizationId (public profile data, shared across
// all users). See schema.ts's "Semantic Search" section comment.
import { asc, cosineDistance, desc, isNotNull, sql } from 'drizzle-orm'
import { publicDb } from '../db/client'
import { builderEmbeddings } from '../db/schema'
import { randomId } from '~/lib/utils'
import type { EmbeddedProfile } from '~/lib/semantic/embedding-doc'

export interface UpsertBuilderEmbeddingStubInput {
  source: string
  sourceId: string
  document: string
  contentHash: string
  profile: EmbeddedProfile
}

/**
 * Insert-or-refresh a `builder_embeddings` row for `(source, sourceId)`.
 * Only resets `embedding`/`embeddedAt` to NULL (marking it pending re-embed)
 * when the incoming `contentHash` differs from what's stored — unchanged
 * profiles are never re-sent to the embedding provider.
 */
export async function upsertBuilderEmbeddingStub(input: UpsertBuilderEmbeddingStubInput): Promise<void> {
  await publicDb
    .insert(builderEmbeddings)
    .values({
      id: randomId(),
      source: input.source,
      sourceId: input.sourceId,
      document: input.document,
      contentHash: input.contentHash,
      profile: input.profile,
    })
    .onConflictDoUpdate({
      target: [builderEmbeddings.source, builderEmbeddings.sourceId],
      set: {
        document: sql`excluded.document`,
        profile: sql`excluded.profile`,
        contentHash: sql`excluded.content_hash`,
        updatedAt: sql`now()`,
        embedding: sql`case when ${builderEmbeddings.contentHash} = excluded.content_hash then ${builderEmbeddings.embedding} else null end`,
        embeddedAt: sql`case when ${builderEmbeddings.contentHash} = excluded.content_hash then ${builderEmbeddings.embeddedAt} else null end`,
      },
    })
}

export interface PendingBuilderEmbedding {
  id: string
  document: string
}

/** Rows awaiting an embedding (`embedding IS NULL`), oldest-touched first. */
export async function findPendingBuilderEmbeddings(limit: number): Promise<PendingBuilderEmbedding[]> {
  return publicDb
    .select({ id: builderEmbeddings.id, document: builderEmbeddings.document })
    .from(builderEmbeddings)
    .where(sql`${builderEmbeddings.embedding} is null`)
    .orderBy(asc(builderEmbeddings.updatedAt))
    .limit(limit)
}

/** Marks a batch of rows embedded, setting their vector and embeddedAt. */
export async function markBuilderEmbeddingsEmbedded(rows: { id: string; embedding: number[] }[]): Promise<void> {
  if (rows.length === 0) return
  await Promise.all(
    rows.map((row) =>
      publicDb
        .update(builderEmbeddings)
        .set({ embedding: row.embedding, embeddedAt: new Date(), updatedAt: new Date() })
        .where(sql`${builderEmbeddings.id} = ${row.id}`),
    ),
  )
}

export interface BuilderEmbeddingMatch {
  source: string
  sourceId: string
  profile: EmbeddedProfile
  similarity: number
}

/**
 * HNSW cosine-similarity search: top `limit` rows nearest `queryVector`
 * that already have an embedding. `similarity = 1 - cosine distance`
 * (1.0 = identical, 0.0 = orthogonal).
 */
export async function findSimilarBuilderEmbeddings(queryVector: number[], limit: number): Promise<BuilderEmbeddingMatch[]> {
  const distance = cosineDistance(builderEmbeddings.embedding, queryVector)
  const rows = await publicDb
    .select({
      source: builderEmbeddings.source,
      sourceId: builderEmbeddings.sourceId,
      profile: builderEmbeddings.profile,
      similarity: sql<number>`1 - (${distance})`,
    })
    .from(builderEmbeddings)
    .where(isNotNull(builderEmbeddings.embedding))
    .orderBy(desc(sql`1 - (${distance})`))
    .limit(limit)
  return rows.map((row) => ({ ...row, profile: row.profile as EmbeddedProfile }))
}

