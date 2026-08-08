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
    // The `inArray` names exactly which components; a component can have several projection versions,
    // and the filter below keeps only the ones the lanes ranked. `× 4` is headroom over that.
    .limit(componentIds.length * 4)

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

// ── The human lane ─────────────────────────────────────────────────────────────────────────────

/**
 * A person retrieval can return.
 *
 * `canonicalHumanId` is null when the account has not been unified with anything yet, which is the common
 * case: unification needs deterministic evidence and roughly 30% of accounts anchor on the first hop. A
 * single unlinked account is still a real person a recruiter can act on, so it is returned — with the id
 * absent rather than invented, so the composer can say which of its candidates is one confirmed person and
 * which is one account that might be part of a larger picture.
 */
export interface HumanCandidate {
  /** Set when the account belongs to a canonical human by an active link. */
  canonicalHumanId: string | null
  /** Always present: the account this candidate was found through. */
  builderIdentityId: string
  source: string
  username: string
  displayName: string | null
  profileUrl: string
  bio: string | null
  topics: string[]
  followersCount: number
  /** How many source accounts this canonical human is known by. One means "not yet unified". */
  accountCount: number
  lastSeenAt: Date
}

/**
 * Retrieves people, lexically.
 *
 * Reads `builder_embeddings.search_vector` — the same document the vector lane embeds — rather than a second
 * projection built for the purpose. A second document would be a second thing to keep in step with the
 * first, and the first is already maintained by the write-through indexer.
 *
 * Two filters are non-negotiable and both are in SQL:
 *
 * - `kind = 'person'`. A third of `builder_identities` are repositories, and a recruiter searching for people
 *   must never be shown one.
 * - The canonical-human join uses only **active** links (`valid_until is null` and an approved review state).
 *   A withdrawn or merely proposed link contributing a person to a recommendation is exactly what the review
 *   queue exists to prevent.
 *
 * Deduplicated by canonical human where one exists, so a person known by three accounts is one candidate
 * rather than three — returning them three times would let one person occupy a whole lane.
 */
export async function humanLane(
  queryText: string,
  limit = 20,
  db: PostgresJsDatabase = publicDb,
): Promise<HumanCandidate[]> {
  const anyTerm = toAnyTermQuery(queryText)
  if (anyTerm.length === 0) return []

  const rows = await db.execute<{
    canonical_human_id: string | null
    builder_identity_id: string
    source: string
    username: string
    display_name: string | null
    profile_url: string
    bio: string | null
    followers_count: number
    last_seen_at: Date
    account_count: number
    rank: number
  }>(sql`
    with matched as (
      select
        i.id            as builder_identity_id,
        i.source, i.username, i.display_name, i.profile_url, i.bio,
        i.followers_count, i.last_seen_at,
        hsl.canonical_human_id,
        ts_rank(e.search_vector, websearch_to_tsquery('english', ${anyTerm})) as rank
      from builder_embeddings e
      join builder_identities i
        on i.source = e.source and i.source_id = e.source_id and i.kind = 'person'
      left join human_source_links hsl
        on hsl.builder_identity_id = i.id
       and hsl.valid_until is null
       and hsl.review_state in ('auto_approved', 'approved')
      where e.entity_kind = 'human_profile'
        and e.search_vector @@ websearch_to_tsquery('english', ${anyTerm})
    ),
    ranked as (
      select *,
        -- Counted from the person's *links*, not from the rows that matched this query. Counting matches
        -- would report "1 account" for someone known by three when only one of them happened to contain the
        -- search terms — a different number from the one this field claims to be.
        (
          select count(*) from human_source_links hs
          where hs.canonical_human_id = matched.canonical_human_id
            and hs.valid_until is null
            and hs.review_state in ('auto_approved', 'approved')
        ) as account_count,
        -- One row per canonical human, keeping its best-matching account. A person known by three accounts is
        -- one candidate; returning three would let one person fill a lane.
        row_number() over (
          partition by coalesce(canonical_human_id, builder_identity_id)
          order by rank desc, followers_count desc, builder_identity_id
        ) as row_in_person
      from matched
    )
    select canonical_human_id, builder_identity_id, source, username, display_name, profile_url, bio,
           followers_count, last_seen_at,
           case when canonical_human_id is null then 1 else account_count end as account_count,
           rank
    from ranked
    where row_in_person = 1
    order by rank desc, followers_count desc
    limit ${limit}
  `)

  return rows.map((row) => ({
    canonicalHumanId: row.canonical_human_id,
    builderIdentityId: row.builder_identity_id,
    source: row.source,
    username: row.username,
    displayName: row.display_name,
    profileUrl: row.profile_url,
    bio: row.bio,
    // Topics live on the embedded payload, not on the identity row, and reading them would mean a second
    // query for a field the composer does not rank on. Left empty rather than half-populated.
    topics: [],
    followersCount: row.followers_count,
    accountCount: Number(row.account_count),
    lastSeenAt: row.last_seen_at,
  }))
}
