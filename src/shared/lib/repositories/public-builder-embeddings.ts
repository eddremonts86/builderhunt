// Public (non-tenant) repository for the global `builder_embeddings` table.
// Every function here uses `publicDb` directly — never `withTenantContext` —
// since this table has no organizationId (public profile data, shared across
// all users). See schema.ts's "Semantic Search" section comment.
import { and, asc, cosineDistance, eq, isNotNull, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
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
 *
 * Returns whether the row's `content_hash` actually changed as a result of
 * the upsert, so the write-through indexer can log per-batch churn without
 * re-reading the row. `TRUE` for a fresh insert (the existing row's hash is
 * `NULL`, which `IS DISTINCT FROM` a non-null value), `TRUE` after a content
 * edit, `FALSE` for an identical re-index. See
 * `plans/phase-1/03-postgres-18-upgrade/spec.md` §3B.
 */
export async function upsertBuilderEmbeddingStub(input: UpsertBuilderEmbeddingStubInput): Promise<boolean> {
  // The RETURNING clause of an UPSERT cannot reference the `excluded`
  // pseudo-table (it's only available in the SET clause). To return
  // "did the content change", we read the existing content_hash FIRST
  // (if any), then run the upsert, then compare the hash that was
  // actually written. The read is bounded by the unique index on
  // (source, source_id) so it is O(1).
  const [existing] = await publicDb
    .select({ contentHash: builderEmbeddings.contentHash })
    .from(builderEmbeddings)
    .where(
      and(
        eq(builderEmbeddings.source, input.source),
        eq(builderEmbeddings.sourceId, input.sourceId),
      ),
    )
    .limit(1)
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
  // TRUE when the row is new (no prior content_hash) or the hash
  // actually changed. FALSE when we re-indexed the same content —
  // the SET clause's guard kept the embedding/embeddedAt columns
  // intact, so the indexer does not need to re-embed.
  return existing === undefined || existing.contentHash !== input.contentHash
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
 * Builds the HNSW cosine-similarity query without executing it, so the
 * regression test can EXPLAIN exactly the SQL this module emits against a
 * disposable database. Product code calls `findSimilarBuilderEmbeddings`.
 *
 * The ORDER BY shape is load-bearing. pgvector's HNSW index
 * (`builder_embeddings_hnsw_idx`, `vector_cosine_ops`) can only serve an
 * ordering written as the bare distance operator ascending —
 * `ORDER BY embedding <=> $vec`. Ordering by the derived expression
 * `1 - (embedding <=> $vec)` DESC yields the identical sequence, but the
 * planner cannot match a monotonic transform back to the index and falls
 * back to `Seq Scan + Sort` over the whole table. So similarity is a
 * *selected column* here and the distance operator is the *sort key*;
 * ascending distance is descending similarity, so callers see the same
 * most-relevant-first order either way.
 */
export function similarBuilderEmbeddingsQuery(db: PostgresJsDatabase, queryVector: number[], limit: number) {
  const distance = cosineDistance(builderEmbeddings.embedding, queryVector)
  return db
    .select({
      source: builderEmbeddings.source,
      sourceId: builderEmbeddings.sourceId,
      profile: builderEmbeddings.profile,
      similarity: sql<number>`1 - (${distance})`,
    })
    .from(builderEmbeddings)
    .where(isNotNull(builderEmbeddings.embedding))
    .orderBy(asc(distance))
    .limit(limit)
}

/**
 * HNSW cosine-similarity search: top `limit` rows nearest `queryVector`
 * that already have an embedding, most similar first.
 * `similarity = 1 - cosine distance` (1.0 = identical, 0.0 = orthogonal).
 *
 * HNSW is an *approximate* index — it explores `max(hnsw.ef_search, limit)`
 * candidates (`ef_search` defaults to 40) and returns the best it found, so
 * `limit` rows always come back but they are not guaranteed to be the true
 * nearest `limit`. That matters here because callers filter *after*
 * retrieval: `semantic-search.ts` drops everything under
 * `SEMANTIC_SIMILARITY_THRESHOLD` and compares the survivors against
 * `SEMANTIC_MIN_LOCAL_MATCHES`, so a near-miss the index skipped becomes an
 * unnecessary trip down the federated degradation ladder rather than a
 * visibly wrong result. If recall ever needs tightening, raise it
 * per-statement (`SET LOCAL hnsw.ef_search = ...`) instead of widening
 * `limit`, which only buys more rows off the same candidate set.
 *
 * Note that an indexable ORDER BY makes the index *available*, not
 * mandatory: the planner still costs it against a seq scan, and on a small
 * corpus the seq scan legitimately wins. Measured locally at `limit` 50, the
 * crossover sits around ~2k embedded rows (352 rows → seq scan at ~7 ms;
 * 2k/5k/20k rows → HNSW index scan).
 */
export async function findSimilarBuilderEmbeddings(queryVector: number[], limit: number): Promise<BuilderEmbeddingMatch[]> {
  const rows = await similarBuilderEmbeddingsQuery(publicDb, queryVector, limit)
  return rows.map((row) => ({ ...row, profile: row.profile as EmbeddedProfile }))
}

