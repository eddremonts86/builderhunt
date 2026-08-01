/**
 * The two retrieval backends (plan 43 Phase 5, "Implement hybrid retrieval": "bounded FTS and pgvector
 * search ... one backend can degrade safely").
 *
 * Each lane is independent and bounded, and each returns *ranks* rather than scores. Returning scores
 * would invite fusing a `ts_rank` with a cosine similarity, which compares numbers on incomparable
 * scales — whichever backend produced larger values would silently dominate. Ranks are comparable by
 * construction, which is the whole premise of the fusion in `fuse.ts`.
 *
 * Both lanes apply the same hard filters in SQL. A filter applied in one lane and not the other would let
 * an excluded component reach the fused set through whichever lane forgot it.
 */
import { and, arrayOverlaps, desc, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { publicDb } from '~/shared/lib/db/client'
import { builderEmbeddings, solutionComponentProjections } from '~/shared/lib/db/schema'
import type { ComponentKind } from '~/shared/lib/solutions/contracts'
import type { LaneHit } from './fuse'
import type { RetrievalFilters } from './filters'

/**
 * How many rows one lane may return.
 *
 * Bounded per lane rather than only on the fused result: an unbounded lexical scan over a catalog of
 * millions would cost the same whether the caller wanted ten results or a thousand, and the fusion only
 * needs enough depth from each backend for ranks to be meaningful.
 */
export const LANE_LIMIT = 100

export interface LaneQueryInput {
  kinds: readonly ComponentKind[]
  filters: RetrievalFilters
  limit?: number
}

/** Filters both lanes share, built once so they cannot diverge between them. */
function sharedConditions(input: LaneQueryInput, table: typeof solutionComponentProjections) {
  const conditions = [
    inArray(table.kind, [...input.kinds]),
    // Array overlap against the indexed `capability_keys` column — exact, and a GIN index scan. A
    // substring match on the document would treat "not suitable for translation" as a translation
    // capability, which is the opposite of what the sentence says.
    arrayOverlaps(table.capabilityKeys, input.filters.capabilityKeys),
  ]
  if (input.filters.excludedComponentIds.length > 0) {
    // Excluded means absent. Expressed as a NOT IN rather than a post-filter so no code path can return a
    // component the user explicitly ruled out.
    conditions.push(notInArray(table.componentId, input.filters.excludedComponentIds))
  }
  return conditions
}

/**
 * Turns a brief's prose into a tsquery that matches on *any* term.
 *
 * This is the lane's most important line and the least obvious. Every convenient Postgres query builder
 * combines terms with AND: `plainto_tsquery` does, and so does `websearch_to_tsquery` for unquoted words.
 * Handing either a real brief — "Translate product documentation from English to Danish and check the
 * result" — produces a query requiring all eleven terms in one document, which no catalog entry will ever
 * satisfy. Retrieval returned zero candidates for every brief, from a catalog that held matching
 * components, and the trace showed a healthy lane finding nothing.
 *
 * So terms are joined with `or` explicitly. This is candidate generation, not the final answer: recall is
 * what matters here, `ts_rank` orders by how well each document matches, and fusion and scoring narrow it
 * afterwards.
 *
 * Sanitising is not optional. `websearch_to_tsquery` reads `-` as NOT and `"` as a phrase delimiter, so
 * "English-to-Danish" silently becomes "English AND NOT to AND NOT Danish" — a brief excluding the very
 * thing it asked for. Reducing input to bare word tokens removes every operator rather than trying to
 * escape them.
 */
export function toAnyTermQuery(queryText: string, maxTerms = 24): string {
  const terms: string[] = []
  const seen = new Set<string>()
  for (const raw of queryText.split(/[^\p{L}\p{N}]+/u)) {
    // Two characters or fewer carries almost no signal and the English config drops most of it as
    // stopwords anyway; the cap keeps the query tree small enough to be faster than the scan it replaces.
    if (raw.length < 3) continue
    const term = raw.toLowerCase()
    if (seen.has(term)) continue
    seen.add(term)
    terms.push(term)
    if (terms.length >= maxTerms) break
  }
  return terms.join(' or ')
}

/**
 * Lexical lane: Postgres full-text search over the projection document.
 *
 * `websearch_to_tsquery` rather than `to_tsquery` because it never throws on malformed input — `to_tsquery`
 * raises a syntax error on a stray `&`, turning a user's prose into a failed request. The `or` joining
 * happens in `toAnyTermQuery`; see its note for why the default AND semantics made this lane useless.
 */
export async function lexicalLane(
  queryText: string,
  input: LaneQueryInput,
  db: PostgresJsDatabase = publicDb,
): Promise<LaneHit[]> {
  const anyTerm = toAnyTermQuery(queryText)
  if (anyTerm.length === 0) return []

  const query = sql`websearch_to_tsquery('english', ${anyTerm})`
  const rows = await db
    .select({
      componentId: solutionComponentProjections.componentId,
      version: solutionComponentProjections.version,
      rank: sql<number>`ts_rank(${solutionComponentProjections.searchVector}, ${query})`,
    })
    .from(solutionComponentProjections)
    .where(and(
      ...sharedConditions(input, solutionComponentProjections),
      sql`${solutionComponentProjections.searchVector} @@ ${query}`,
    ))
    .orderBy(desc(sql`ts_rank(${solutionComponentProjections.searchVector}, ${query})`))
    .limit(input.limit ?? LANE_LIMIT)

  return rows.map((row, index) => ({ componentId: row.componentId, version: row.version, rank: index + 1 }))
}

/**
 * Vector lane: pgvector cosine similarity over `builder_embeddings`, joined back to projections.
 *
 * The ORDER BY has to be written as the bare distance operator ascending for the HNSW index to serve it —
 * ordering by `1 - distance` descending is mathematically identical and produces a sequential scan. That
 * constraint is why this is hand-written SQL rather than reusing `searchBuilderEmbeddings`, which also
 * narrows its results to human profiles.
 *
 * `embedding is not null` excludes rows the embed worker has not reached yet. A pending row has no vector,
 * so including it would either error or sort arbitrarily; leaving it out means a freshly ingested
 * component is findable lexically first and semantically once embedded, which is the honest behaviour.
 */
export async function vectorLane(
  queryVector: readonly number[],
  input: LaneQueryInput,
  db: PostgresJsDatabase = publicDb,
): Promise<LaneHit[]> {
  if (queryVector.length === 0) return []
  const vectorLiteral = sql.raw(`'[${queryVector.join(',')}]'::vector`)

  const rows = await db
    .select({
      componentId: solutionComponentProjections.componentId,
      version: solutionComponentProjections.version,
    })
    .from(builderEmbeddings)
    .innerJoin(
      solutionComponentProjections,
      and(
        eq(solutionComponentProjections.componentId, builderEmbeddings.sourceId),
        eq(solutionComponentProjections.kind, builderEmbeddings.entityKind),
      ),
    )
    .where(and(
      isNotNull(builderEmbeddings.embedding),
      ...sharedConditions(input, solutionComponentProjections),
    ))
    .orderBy(sql`${builderEmbeddings.embedding} <=> ${vectorLiteral}`)
    .limit(input.limit ?? LANE_LIMIT)

  return rows.map((row, index) => ({ componentId: row.componentId, version: row.version, rank: index + 1 }))
}

export interface CandidateRow {
  componentId: string
  version: number
  kind: ComponentKind
  sourceKey: string
  displayName: string
  capabilityKeys: string[]
  maxEvidenceLevel: string
  observedAt: Date
}

/**
 * Loads the full projection rows for the ids the lanes returned.
 *
 * A second query rather than selecting everything in each lane: the same component is usually returned by
 * both, and fetching its document and capability array twice doubles the largest columns on the wire for
 * no benefit. Display name comes from the projection's own denormalized copy so this needs no join to
 * `solution_components`.
 */
export async function loadCandidates(
  keys: ReadonlyArray<{ componentId: string; version: number }>,
  db: PostgresJsDatabase = publicDb,
): Promise<CandidateRow[]> {
  if (keys.length === 0) return []
  const componentIds = [...new Set(keys.map((key) => key.componentId))]

  const rows = await db
    .select({
      componentId: solutionComponentProjections.componentId,
      version: solutionComponentProjections.version,
      kind: solutionComponentProjections.kind,
      sourceKey: solutionComponentProjections.sourceKey,
      searchDocument: solutionComponentProjections.searchDocument,
      capabilityKeys: solutionComponentProjections.capabilityKeys,
      maxEvidenceLevel: solutionComponentProjections.maxEvidenceLevel,
      observedAt: solutionComponentProjections.observedAt,
    })
    .from(solutionComponentProjections)
    .where(inArray(solutionComponentProjections.componentId, componentIds))

  // Only the (componentId, version) pairs the lanes actually returned. A component whose version moved
  // between the lane query and this one would otherwise contribute a row nothing ranked.
  const wanted = new Set(keys.map((key) => `${key.componentId}:${key.version}`))
  return rows
    .filter((row) => wanted.has(`${row.componentId}:${row.version}`))
    .map((row) => ({
      componentId: row.componentId,
      version: row.version,
      kind: row.kind as ComponentKind,
      sourceKey: row.sourceKey,
      // The document's first line is the display name, by construction in `buildSearchDocument`. Read
      // from there rather than joined, so this query touches one table.
      displayName: row.searchDocument.split('\n', 1)[0] ?? row.componentId,
      capabilityKeys: row.capabilityKeys ?? [],
      maxEvidenceLevel: row.maxEvidenceLevel,
      observedAt: row.observedAt,
    }))
}
