// Query engine for the semantic-search plan (spec.md §5). Embeds the raw
// query, searches the global HNSW index, and — only when there aren't
// enough local matches — degrades to the existing federated search
// (src/lib/search.ts), merging and write-through-indexing the new results.
// Never a dead end: any AI failure is caught by the caller
// (src/routes/api/search/semantic.ts), which falls back to plain keyword
// search with `mode: 'keyword-fallback'`.
import { createHash } from 'node:crypto'
import { searchBuilders, type ScoredBuilder } from '~/lib/search'
import type { PlanTier } from '~/shared/lib/billing-shared'
import { checkAndConsumeBudget } from '~/shared/lib/ai/budget'
import { embedTexts } from '~/shared/lib/ai/embeddings'
import { getCached, setCached } from '~/shared/lib/ai/cache'
import { minimaxChat } from '~/shared/lib/ai/minimax'
import { getTask, type QueryTranslation } from '~/shared/lib/ai/tasks'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { log } from '~/shared/lib/log'
import { getRedis } from '~/shared/lib/redis'
import type { EntitlementPolicy } from '~/shared/lib/repositories/entitlements'
import { findSimilarBuilderEmbeddings } from '~/shared/lib/repositories/public-builder-embeddings'
import { upsertEmbeddingStubs } from './index-writer'

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
  language?: string
  country?: string
  perPage?: number
  principal: Pick<TenantPrincipal, 'organizationId' | 'userId'>
  entitlement: Pick<EntitlementPolicy, 'tier'>
}

export interface SemanticSearchOutcome {
  results: (SemanticBuilderResult | ScoredBuilder)[]
  mode: 'semantic' | 'hybrid'
  translated?: QueryTranslation
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
  const perPage = opts.perPage ?? 30
  const queryVector = await embedQueryCached(opts.query, opts.principal, opts.entitlement)
  const candidates = await findSimilarBuilderEmbeddings(queryVector, 50)

  const kept = candidates
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

  if (localResults.length >= SEMANTIC_MIN_LOCAL_MATCHES) {
    return { results: localResults.slice(0, perPage), mode: 'semantic' }
  }

  // Degradation: not enough local matches — translate + run the existing
  // federated search, then merge (local-first, deduped by source:sourceId).
  const translated = opts.translated ?? (await translateQueryServerSide(opts.query, opts.principal, opts.entitlement) ?? undefined)
  const keywords = translated?.keywords ?? opts.query.split(/\s+/).filter(Boolean)

  const federated = await searchBuilders({
    keywords,
    sources: translated?.sources,
    language: translated?.language ?? opts.language,
    country: translated?.country ?? opts.country,
    perPage,
  })

  const seen = new Set(localResults.map((r) => `${r.source}:${r.sourceId}`))
  const merged = [...localResults, ...federated.filter((f) => !seen.has(`${f.source}:${f.sourceId}`))]

  // Write-through the newly discovered federated results — fire-and-forget,
  // same as the search/track routes (index-writer.ts).
  upsertEmbeddingStubs(federated).catch((error) =>
    log.error('embedding_writethrough_error', { error: error instanceof Error ? error.message : String(error) }),
  )

  return { results: merged.slice(0, perPage), mode: 'hybrid', translated }
}
