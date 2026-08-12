// Public (non-tenant) repository for the global `builder_embeddings` table.
// Every function here uses `publicDb` directly — never `withTenantContext` —
// since this table has no organizationId (public profile data, shared across
// all users). See schema.ts's "Semantic Search" section comment.
import { and, asc, cosineDistance, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { publicDb } from '../db/client'
import { builderEmbeddings } from '../db/schema'
import { randomId } from '~/lib/utils'
import type { ComponentKind } from '~/shared/lib/solutions/contracts'
import { asEmbeddedProfile, type EmbeddedProfile } from '~/lib/semantic/embedding-doc'

/** Real people — the only kind that existed before plan 43 Phase 2, and still the default. */
export const DEFAULT_ENTITY_KIND: ComponentKind = 'human_profile'

export interface UpsertBuilderEmbeddingStubInput {
  /** Omitted means `human_profile`, which is what every pre-Phase-2 caller means. */
  entityKind?: ComponentKind
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
 * `plans/implemented/03-postgres-18-upgrade/spec.md` §3B.
 */
export async function upsertBuilderEmbeddingStub(input: UpsertBuilderEmbeddingStubInput): Promise<boolean> {
  // The RETURNING clause of an UPSERT cannot reference the `excluded`
  // pseudo-table (it's only available in the SET clause). To return
  // "did the content change", we read the existing content_hash FIRST
  // (if any), then run the upsert, then compare the hash that was
  // actually written. The read is bounded by the unique index on
  // (source, source_id) so it is O(1).
  const entityKind = input.entityKind ?? DEFAULT_ENTITY_KIND
  const [existing] = await publicDb
    .select({ contentHash: builderEmbeddings.contentHash })
    .from(builderEmbeddings)
    .where(
      and(
        eq(builderEmbeddings.entityKind, entityKind),
        eq(builderEmbeddings.source, input.source),
        eq(builderEmbeddings.sourceId, input.sourceId),
      ),
    )
    .limit(1)
  await publicDb
    .insert(builderEmbeddings)
    .values({
      id: randomId(),
      entityKind,
      source: input.source,
      sourceId: input.sourceId,
      document: input.document,
      contentHash: input.contentHash,
      profile: input.profile,
    })
    .onConflictDoUpdate({
      target: [builderEmbeddings.entityKind, builderEmbeddings.source, builderEmbeddings.sourceId],
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
  entityKind: ComponentKind
  source: string
  sourceId: string
  profile: EmbeddedProfile
  similarity: number
  /**
   * Cosine distance — the sort key itself, not `1 - similarity`.
   *
   * A cursor built from the similarity would be a value derived from the distance and then compared
   * back against the distance, and float arithmetic does not survive that round trip exactly. The
   * keyset predicate compares this against the same `embedding <=> $vec` expression the ORDER BY
   * uses, so the boundary row's own value is what decides where the next page starts.
   */
  distance: number
}

/**
 * Hard filters applied in SQL, before the vector sort — not after it in JS (plan 43 Phase 2,
 * "Honor semantic filters and pagination": "filtered pages contain no excluded source/type").
 *
 * Post-filtering a fixed candidate window is what made the old behaviour wrong in two ways at
 * once: a source filter was never applied to local matches at all, and even once applied it would
 * silently shrink the page, because the window was chosen before the filter ran. Pushing both into
 * the WHERE clause means the index returns `limit` rows that already satisfy the filter.
 */
export interface BuilderEmbeddingSearchFilters {
  /** Restrict to these entity kinds. Empty/omitted means every kind. */
  entityKinds?: readonly ComponentKind[]
  /** Restrict to these `source` values. Empty/omitted means every source. */
  sources?: readonly string[]
}

/** The last row of the previous page, in the total order `(distance, source, source_id)`. */
export interface BuilderEmbeddingCursor {
  distance: number
  source: string
  sourceId: string
}

export interface BuilderEmbeddingSearchPage {
  limit: number
  /**
   * Resume after this row. Absent means page one.
   *
   * This replaced an `offset` (plan 11). An offset over a relevance ordering repeats and drops rows
   * whenever the corpus changes between two requests — the write-through indexer inserts rows on
   * every federated search, so that was not a rare case here but the normal one. A keyset over
   * `(distance, source, source_id)` cannot repeat a row at all: the predicate is strictly greater
   * than the boundary.
   *
   * What it still cannot promise is that the same rows would have been *found*. HNSW explores a
   * candidate set and returns the best it saw, and a filtered re-probe explores it afresh. That is
   * the index's approximation, not the cursor's — no cursor design removes it, which is why the
   * response calls itself `approximate` rather than `exact`.
   */
  after?: BuilderEmbeddingCursor | null
}

export interface BuilderEmbeddingSearchResult {
  matches: BuilderEmbeddingMatch[]
  /** Measured, never guessed: the query asks for `limit + 1` rows and this is whether that extra
   * row came back. `matches` is truncated to `limit` before returning, so a caller that trusts
   * this flag can page without ever being told "there is more" about a page that does not exist. */
  hasMore: boolean
}

function buildFilterConditions(filters: BuilderEmbeddingSearchFilters | undefined) {
  const conditions = [isNotNull(builderEmbeddings.embedding)]
  if (filters?.entityKinds?.length) {
    conditions.push(inArray(builderEmbeddings.entityKind, [...filters.entityKinds]))
  }
  if (filters?.sources?.length) {
    conditions.push(inArray(builderEmbeddings.source, [...filters.sources]))
  }
  return conditions
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
export function similarBuilderEmbeddingsQuery(
  db: PostgresJsDatabase,
  queryVector: number[],
  limit: number,
  filters?: BuilderEmbeddingSearchFilters,
  after?: BuilderEmbeddingCursor | null,
) {
  const distance = cosineDistance(builderEmbeddings.embedding, queryVector)
  const conditions = buildFilterConditions(filters)
  if (after) {
    /*
     * The keyset predicate, as a row-value comparison.
     *
     * Written against the distance *expression*, not against a stored column, because that is what
     * the ORDER BY sorts by — comparing anything else would resume from a position in a different
     * ordering. `source` and `source_id` follow so the order is total: two rows at an identical
     * distance are common here (a re-indexed profile keeps its vector), and a page boundary landing
     * inside such a tie is exactly what repeats or drops a row.
     *
     * A row constructor rather than the expanded `d > $1 or (d = $1 and ...)` form: none of the
     * three is nullable — `embedding is not null` is already a condition, and `source`/`source_id`
     * are NOT NULL — so the null-aware expansion would buy nothing and read worse.
     */
    conditions.push(
      sql`(${distance}, ${builderEmbeddings.source}, ${builderEmbeddings.sourceId}) > (${after.distance}, ${after.source}, ${after.sourceId})`,
    )
  }
  return db
    .select({
      entityKind: builderEmbeddings.entityKind,
      source: builderEmbeddings.source,
      sourceId: builderEmbeddings.sourceId,
      profile: builderEmbeddings.profile,
      similarity: sql<number>`1 - (${distance})`,
      distance: sql<number>`${distance}`,
    })
    .from(builderEmbeddings)
    .where(and(...conditions))
    // The trailing terms are what make this a total order. The HNSW index still serves the leading
    // one, and Postgres finishes the job with an incremental sort inside each distance group —
    // which is only ever a handful of rows.
    .orderBy(asc(distance), asc(builderEmbeddings.source), asc(builderEmbeddings.sourceId))
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
  const { matches } = await searchBuilderEmbeddings(queryVector, { limit })
  return matches
}

/**
 * The filtered, paged form of `findSimilarBuilderEmbeddings`. Hard filters run in SQL and the
 * continuation flag is measured by over-fetching one row rather than inferred from
 * `rows.length >= limit` — the inference is wrong exactly when the last page is full, which is the
 * case a user notices because the UI offers a next page that turns out to be empty.
 *
 * The `offset` caveat is inherent to paging an approximate index: HNSW explores a candidate set and
 * returns the best it found, so a corpus that changes between page 1 and page 2 can shift a row
 * across the boundary. That is acceptable for a relevance-ordered feed and is why deep paging here
 * is bounded by the caller rather than offered without limit.
 */
export async function searchBuilderEmbeddings(
  queryVector: number[],
  page: BuilderEmbeddingSearchPage,
  filters?: BuilderEmbeddingSearchFilters,
  /** Override for disposable-database tests, same seam as `similarBuilderEmbeddingsQuery`. */
  db: PostgresJsDatabase = publicDb,
): Promise<BuilderEmbeddingSearchResult> {
  // Over-fetch by one *before* the payload filter below, then again after: dropping catalog rows can
  // shrink the page, so `hasMore` is decided from what survives rather than from what the index returned.
  const rows = await similarBuilderEmbeddingsQuery(db, queryVector, page.limit + 1, filters, page.after)

  /**
   * Catalog components share this table with people — that is what `entity_kind` is for — so a row here
   * is not necessarily a person. This function's contract is people, and its result feeds person result
   * cards.
   *
   * Previously this read `row.profile as EmbeddedProfile`, which is a cast and not a check: a catalog
   * component reaching it would have been handed to a card that reads `username` and `profileUrl`, fields
   * a component does not have. Narrowing instead of casting is what makes that impossible.
   *
   * Rows are dropped rather than an error thrown. A caller wanting components asks for them explicitly
   * through `filters.entityKinds`, and a mixed index answering a person query with the people it found is
   * the correct behaviour, not a failure.
   */
  const profileRows = rows.flatMap((row) => {
    const profile = asEmbeddedProfile(row.profile)
    return profile ? [{ ...row, entityKind: row.entityKind as ComponentKind, profile }] : []
  })
  const hasMore = profileRows.length > page.limit
  return { matches: profileRows.slice(0, page.limit), hasMore }
}

