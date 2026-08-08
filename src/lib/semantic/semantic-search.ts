// Query engine for the semantic-search plan (spec.md §5). Embeds the raw
// query, searches the global HNSW index, and — only when there aren't
// enough local matches — degrades to the existing federated search
// (src/lib/search.ts), merging and write-through-indexing the new results.
// Never a dead end: any AI failure is caught by the caller
// (src/routes/api/search/semantic.ts), which falls back to plain keyword
// search with `mode: 'keyword-fallback'`.
import { createHash } from 'node:crypto'
import { DEFAULT_SEARCH_SOURCES, pageBuilderSearch, resolveContactableSources, type ScoredBuilder } from '~/lib/search'
import {
  createSearchContinuation,
  queryVectorHash,
  searchFingerprint,
  verifySearchContinuation,
} from '~/lib/search-continuation'
import { TABLE_PAGE_SIZE } from '~/shared/lib/table/constants'
import type { PageConsistency } from '~/shared/lib/table/types'
import type { PlanTier } from '~/shared/lib/billing-shared'
import { checkAndConsumeBudget } from '~/shared/lib/ai/budget'
import { embedTexts } from '~/shared/lib/ai/embeddings'
import { assertEmbeddingDimensionMatchesDatabase } from '~/shared/lib/ai/embedding-dim-check'
import { getCached, setCached } from '~/shared/lib/ai/cache'
import { minimaxChat } from '~/shared/lib/ai/minimax'
import { getTask, type QueryTranslation } from '~/shared/lib/ai/tasks'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { publicDb } from '~/shared/lib/db/client'
import { log } from '~/shared/lib/log'
import { getRedis } from '~/shared/lib/redis'
import type { EntitlementPolicy } from '~/shared/lib/repositories/entitlements'
import { searchBuilderEmbeddings } from '~/shared/lib/repositories/public-builder-embeddings'
import type { ComponentKind } from '~/shared/lib/solutions/contracts'
import { upsertEmbeddingStubs } from './index-writer'

/**
 * `/api/search/semantic` is the people-search endpoint. Now that the same projection also holds
 * Solutions catalog components, leaving this unfiltered would silently start returning models and
 * MCP servers as "builders" — so the default is explicit rather than "no filter".
 */
const DEFAULT_SEMANTIC_ENTITY_KINDS: readonly ComponentKind[] = ['human_profile']

// Same daily-allowance shape as `ai/tasks.ts`'s registry, but embedding
// isn't a chat task (no system prompt/output schema) so it doesn't fit
// `AITaskDefinition` — `checkAndConsumeBudget` only needs `id` + `allowances`.
// The route already blocks `entitlement.tier === 'free'` before reaching
// here; this is defense in depth against a future caller that skips it.
const SEMANTIC_SEARCH_EMBED_ALLOWANCES: Record<PlanTier, number> = { free: 0, pro: 500, team: 1000 }

/** Below this many kept local matches, the degradation ladder kicks in. */
export const SEMANTIC_MIN_LOCAL_MATCHES = 10
/** Minimum cosine similarity (1 - distance) for a local hit to count. */
export const SEMANTIC_SIMILARITY_THRESHOLD = 0.6

const QUERY_EMBED_CACHE_TTL_SECONDS = 24 * 60 * 60

export interface SemanticBuilderResult {
  id: string
  kind: 'person'
  source: string
  sourceId: string
  username: string
  displayName?: string
  avatarUrl?: string
  bio?: string
  profileUrl: string
  followersCount?: number
  language?: string
  country?: string
  topics: string[]
  similarity?: number
}

export interface SemanticSearchOptions {
  query: string
  translated?: QueryTranslation
  /**
   * Restrict to these sources. Applied to BOTH legs — the local vector index (in SQL) and the
   * federated fallback. Until plan 43 Phase 2 this was accepted by the route and then dropped, so
   * a search filtered to `['github']` still returned `hn` rows out of the local index.
   */
  sources?: readonly string[]
  /** Restrict which entity kinds the local index may return. Defaults to people only, which keeps
   * this endpoint's contract unchanged now that the projection also holds catalog components. */
  entityKinds?: readonly ComponentKind[]
  language?: string
  country?: string
  /** The previous page's `nextCursor`, or null/absent for page one. */
  cursor?: string | null
  principal: Pick<TenantPrincipal, 'organizationId' | 'userId'>
  entitlement: Pick<EntitlementPolicy, 'tier'>
}

export interface SemanticSearchOutcome {
  results: (SemanticBuilderResult | ScoredBuilder)[]
  mode: 'semantic' | 'hybrid'
  translated?: QueryTranslation
  /** Opaque, signed, and `null` when there is no further page. */
  nextCursor: string | null
  /**
   * Always `null`.
   *
   * The local leg *could* be counted, but not cheaply: the threshold is a cut on a value derived
   * from the query vector, so counting means computing a distance for every embedded row. The
   * hybrid leg cannot be counted at any price. One honest answer for both beats a number that means
   * something different depending on which leg produced it.
   */
  total: null
  consistency: PageConsistency
}

/** Redis-cached query embedding — 1 embed call per unique query per 24h. Throws (caught by the route, which degrades to keyword search) when the daily embed budget is exhausted. */
async function embedQueryCached(
  query: string,
  principal: Pick<TenantPrincipal, 'organizationId' | 'userId'>,
  entitlement: Pick<EntitlementPolicy, 'tier'>,
): Promise<number[]> {
  const cacheKey = `ai:cache:query-embed:${createHash('sha256').update(query).digest('hex')}`
  try {
    const redis = await getRedis()
    if (redis) {
      const cached = await redis.get(cacheKey)
      if (cached) return JSON.parse(cached) as number[]
    }
  } catch {
    // Redis unavailable — fall through to a live embed.
  }

  const budget = await checkAndConsumeBudget(principal, entitlement, {
    id: 'semantic-search-embed',
    allowances: SEMANTIC_SEARCH_EMBED_ALLOWANCES,
  })
  if (!budget.allowed) throw new Error('semantic search embed budget exhausted')

  const [vector] = await embedTexts([query])

  try {
    const redis = await getRedis()
    if (redis) await redis.set(cacheKey, JSON.stringify(vector), 'EX', QUERY_EMBED_CACHE_TTL_SECONDS)
  } catch {
    // Best-effort — a cache miss just means a re-embed next time.
  }

  return vector
}

/**
 * Runs the `query-translate` task server-side (budgeted + cached, exactly
 * like `/api/ai/complete` would), for callers who couldn't run it
 * client-side (Chrome AI unavailable — e.g. Firefox). Returns `null` on any
 * failure (budget exhausted, provider error, parse error) — the caller
 * treats a `null` translation as "use the raw query as a single keyword".
 */
async function translateQueryServerSide(
  query: string,
  principal: Pick<TenantPrincipal, 'organizationId' | 'userId'>,
  entitlement: Pick<EntitlementPolicy, 'tier'>,
): Promise<QueryTranslation | null> {
  const task = getTask('query-translate')
  if (!task) return null
  const input = { query }

  try {
    const budget = await checkAndConsumeBudget(principal, entitlement, task)
    if (!budget.allowed) return null

    const cached = await getCached<QueryTranslation>(task, input)
    if (cached) return cached

    const output = (await minimaxChat({
      system: task.system,
      prompt: task.buildPrompt(input),
      schema: task.outputSchema,
      maxOutputTokens: task.maxOutputTokens,
    })) as QueryTranslation
    await setCached(task, input, output)
    return output
  } catch (error) {
    log.error('query_translate_server_error', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

function matchesFilter(value: string | undefined, filter: string | undefined): boolean {
  if (!filter) return true
  if (!value) return true // profiles without the field aren't excluded, matching searchBuilders' post-filter semantics
  return value.toLowerCase() === filter.toLowerCase()
}

export async function semanticSearch(opts: SemanticSearchOptions): Promise<SemanticSearchOutcome> {
  const limit = TABLE_PAGE_SIZE

  // Cheap once per process, and it turns "vector search silently matches nothing" into a loud
  // error. Awaited before the first vector round trip on purpose.
  await assertEmbeddingDimensionMatchesDatabase(publicDb)

  const queryVector = await embedQueryCached(opts.query, opts.principal, opts.entitlement)

  // The source filter has to be known before the local query runs, so it comes from what the caller
  // already has — an explicit `sources`, or a translation the client did. A translation computed
  // later (in the degradation branch below) can only constrain the federated leg.
  const localSources = opts.sources ?? opts.translated?.sources
  const entityKinds = opts.entityKinds ?? DEFAULT_SEMANTIC_ENTITY_KINDS

  /*
   * One fingerprint for both legs of this endpoint, bound to the raw query and to the query vector
   * rather than to the translated keywords. See `KeywordSearchPageOptions.queryFingerprint`: the
   * translation is derived from these inputs, so binding it would make a token fragile against its
   * own cache while proving nothing extra.
   */
  const fingerprint = searchFingerprint({
    keywords: [opts.query],
    requestedSources: localSources,
    language: opts.language,
    country: opts.country,
    entityKinds,
    vectorHash: queryVectorHash(queryVector),
  })
  const scope = opts.principal.organizationId

  /*
   * The register snapshot is resolved even for a purely local page.
   *
   * The local index is filtered by the *requested* sources and does not consult the register at all
   * — a gap this plan does not close (`plans/phase-3/11-migrate-search` non-goals: same behaviour,
   * same permissions). Binding the snapshot anyway means a source switched off mid-session restarts
   * the walk on both legs rather than only the federated one, which is the cheaper end of being
   * wrong.
   */
  const { contacted } = await resolveContactableSources(localSources ?? [...DEFAULT_SEARCH_SOURCES])
  const expectation = {
    mode: ['semantic', 'hybrid'] as const,
    query: fingerprint,
    scope,
    sources: contacted,
  }

  const resumed = opts.cursor ? verifySearchContinuation(opts.cursor, expectation) : null

  /*
   * A provider continuation means the previous page had already degraded, so the local leg is
   * skipped entirely rather than re-run.
   *
   * Re-running it would re-prepend the same handful of local matches to every subsequent page —
   * they were all served on page one, since there were fewer than `SEMANTIC_MIN_LOCAL_MATCHES` of
   * them by definition. That is the duplicate this branch exists to prevent.
   */
  if (resumed?.state.kind === 'provider') {
    return federatedPage(opts, { fingerprint, scope, cursor: opts.cursor!, translated: opts.translated })
  }

  const after = resumed?.state.kind === 'semantic'
    ? { distance: resumed.state.distance, source: resumed.state.source, sourceId: resumed.state.sourceId }
    : null

  // Over-fetch: `SEMANTIC_SIMILARITY_THRESHOLD` is a relevance cut on a value derived from the
  // vector, so it cannot be pushed into SQL alongside the hard filters. Asking for a wider window
  // means the threshold has room to reject without starving the page.
  const window = Math.max(limit, SEMANTIC_MIN_LOCAL_MATCHES) * 2
  const { matches, hasMore: moreRowsExist } = await searchBuilderEmbeddings(
    queryVector,
    { limit: window, after },
    { sources: localSources, entityKinds },
  )

  const kept = matches
    .filter((m) => m.similarity >= SEMANTIC_SIMILARITY_THRESHOLD)
    .filter((m) => matchesFilter(m.profile.language, opts.language))
    .filter((m) => matchesFilter(m.profile.country, opts.country))

  const localResults: SemanticBuilderResult[] = kept.map((m) => ({
    id: `${m.source}:${m.sourceId}`,
    kind: 'person',
    source: m.source,
    sourceId: m.sourceId,
    similarity: m.similarity,
    ...m.profile,
  }))

  /*
   * Enough local matches, *or* this is not page one.
   *
   * The second half matters: `SEMANTIC_MIN_LOCAL_MATCHES` asks "did the vector index have enough to
   * say", which is a question about the query, not about page four. Without it, walking to the tail
   * of a genuinely good semantic result set would degrade to the federation the moment the last
   * page came back short — and then merge federated rows in behind a `hybrid` label the user never
   * saw a reason for.
   */
  if (localResults.length >= SEMANTIC_MIN_LOCAL_MATCHES || after !== null) {
    const page = localResults.slice(0, limit)
    const last = kept[page.length - 1]
    /*
     * `matches` is ordered by ascending distance, so similarity descends: once one row falls under
     * the threshold, every row after it does too. A window that produced a rejected row has
     * therefore reached the end of the above-threshold set, whatever the repository's over-fetch
     * says about rows beyond it.
     */
    const thresholdReached = matches.length > kept.length
    const hasMore = localResults.length > limit || (moreRowsExist && !thresholdReached)
    return {
      results: page,
      mode: 'semantic',
      nextCursor: hasMore && last
        ? createSearchContinuation({
          mode: 'semantic',
          query: fingerprint,
          scope,
          sources: contacted,
          state: { kind: 'semantic', distance: last.distance, source: last.source, sourceId: last.sourceId },
        })
        : null,
      total: null,
      consistency: 'approximate',
    }
  }

  // Degradation: not enough local matches — translate + run the existing federated search, then
  // merge (local-first, deduped by source:sourceId). Only ever page one, by the branch above.
  return federatedPage(opts, { fingerprint, scope, cursor: null, translated: opts.translated, localResults })
}

interface FederatedLegContext {
  fingerprint: string
  scope: string
  cursor: string | null
  translated?: QueryTranslation
  /** Local matches to place ahead of the federated ones. Page one only. */
  localResults?: SemanticBuilderResult[]
}

/**
 * The hybrid leg: local matches first, then a bounded federated page filling the rest.
 *
 * Split out because it is reached two ways — page one degrading, and every page after it resuming a
 * provider continuation — and the two must agree on the fingerprint, the scope and the mode or the
 * second would reject the first's token.
 */
async function federatedPage(
  opts: SemanticSearchOptions,
  context: FederatedLegContext,
): Promise<SemanticSearchOutcome> {
  const localResults = context.localResults ?? []
  const translated = context.translated
    ?? (await translateQueryServerSide(opts.query, opts.principal, opts.entitlement) ?? undefined)
  const keywords = translated?.keywords ?? opts.query.split(/\s+/).filter(Boolean)

  // An explicit caller filter outranks the model's guess: the model may widen `sources` to
  // something the caller deliberately excluded, and honoring that would make the federated leg
  // return exactly the sources the local leg just filtered out.
  const federatedSources = opts.sources ? [...opts.sources] : translated?.sources

  const page = await pageBuilderSearch({
    keywords,
    sources: federatedSources,
    language: translated?.language ?? opts.language,
    country: translated?.country ?? opts.country,
    scope: context.scope,
    mode: 'hybrid',
    cursor: context.cursor,
    // Whatever the local leg already spent of this page. On a resumed page that is nothing.
    limit: Math.max(1, TABLE_PAGE_SIZE - localResults.length),
    queryFingerprint: context.fingerprint,
  })

  const seen = new Set(localResults.map((result) => `${result.source}:${result.sourceId}`))
  const federated = page.builders.filter((builder) => !seen.has(`${builder.source}:${builder.sourceId}`))

  // Write-through the newly discovered federated results — fire-and-forget,
  // same as the search/track routes (index-writer.ts).
  upsertEmbeddingStubs(page.builders).catch((error) =>
    log.error('embedding_writethrough_error', { error: error instanceof Error ? error.message : String(error) }),
  )

  return {
    results: [...localResults, ...federated],
    mode: 'hybrid',
    translated,
    nextCursor: page.nextCursor,
    total: null,
    consistency: 'provider-best-effort',
  }
}
