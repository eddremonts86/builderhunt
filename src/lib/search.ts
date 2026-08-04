import { searchGitHub } from '~/lib/sources/github'
import { searchHN } from '~/lib/sources/hn'
import { searchDevTo } from '~/lib/sources/devto'
import { searchReddit } from '~/lib/sources/reddit'
import { searchLobsters } from '~/lib/sources/lobsters'
import { searchStackOverflow } from '~/lib/sources/stackoverflow'
import { searchNpm } from '~/lib/sources/npm'
import { searchHuggingFace } from '~/lib/sources/huggingface'
import { searchGitLab } from '~/lib/sources/gitlab'
import { searchCodeberg } from '~/lib/sources/codeberg'
import { searchHashnode } from '~/lib/sources/hashnode'
import { searchDevpost } from '~/lib/sources/devpost'
import { searchProductHunt } from '~/lib/sources/producthunt'
import { searchBluesky } from '~/lib/sources/bluesky'
import { deduplicateBuilders } from '~/lib/dedup'
import { fuseByRank, scoreBuilders, type FusedBuilder } from '~/lib/score'
import type { RawBuilder } from '~/lib/sources/types'
import { log } from '~/shared/lib/log'
import { metrics } from '~/shared/lib/metrics'
import { filterSuppressed } from '~/shared/lib/profile-suppression'

export interface SearchOptions {
  keywords: string[]
  sources?: string[]
  language?: string
  country?: string
  page?: number
  perPage?: number
}

export type ScoredBuilder = ReturnType<typeof scoreBuilders>[number]

/**
 * How long one connector may take before the search stops waiting for it (plan 43 Phase 2,
 * "Isolate connectors and correct identity candidates"). There was no bound at all: a hanging
 * third-party API hung the whole request until the platform's socket timeout.
 */
export const CONNECTOR_TIMEOUT_MS = 8000

/**
 * `disabled` is not a failure and not a success: the operator switched this source off in
 * `search_sources`, so it was never contacted. It exists as its own value because folding it into
 * `ok, 0 results` would tell a user the source had nothing to say, and folding it into `failed` would
 * tell them something is broken. Neither is true.
 */
export type SourceHealth = 'ok' | 'failed' | 'timeout' | 'disabled'

/** Per-source outcome, so a caller can tell "this source found nothing" from "this source broke". */
export interface SourceStatus {
  source: string
  health: SourceHealth
  resultCount: number
  durationMs: number
  /** Present only when `health !== 'ok'`. Never the raw error — connectors can echo upstream bodies. */
  detail?: string
}

export interface SearchOutcome {
  /** `FusedBuilder`, not `ScoredBuilder`: the ordering these come back in is the fused one, and the
   * `fusedScore` that produced it has to be visible to anything that wants to re-sort or explain it. */
  builders: FusedBuilder[]
  sources: SourceStatus[]
}

/**
 * Runs one connector in isolation: its failure, timeout, or malformed output can never affect
 * another connector or the request as a whole.
 *
 * This replaces `await Promise.all(tasks)`, under which one rejecting connector rejected the whole
 * search and the route answered 500 with zero results for all fifteen sources. That was not
 * hypothetical: most connectors catch internally and return `[]`, but `github.ts` has no `catch`
 * anywhere, and GitHub is the highest-traffic source — so a GitHub blip took the entire product's
 * search down while fourteen healthy sources had answers ready.
 *
 * The timeout races rather than cancels. None of the fifteen connectors accepts an `AbortSignal`,
 * so the underlying `fetch` keeps running and its result is discarded; threading signals through
 * every connector is the real cancellation fix and is deliberately left as its own change. Racing
 * still converts "the request hangs indefinitely" into "this source is reported unavailable",
 * which is the user-visible failure that mattered.
 */
async function runConnector(connector: { source: string; run: () => Promise<RawBuilder[]> }): Promise<SourceStatus & { builders: RawBuilder[] }> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const TIMED_OUT = Symbol('timeout')

  try {
    const raced = await Promise.race([
      // A rejection after the race is already lost would otherwise surface as an unhandled
      // rejection and crash the process under Node's default policy, so it is caught here even
      // though the value is discarded.
      connector.run().catch((error: unknown) => { throw error }),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), CONNECTOR_TIMEOUT_MS)
      }),
    ])

    if (raced === TIMED_OUT) {
      log.warn('search_connector_timeout', { source: connector.source, timeoutMs: CONNECTOR_TIMEOUT_MS })
      metrics.increment('searchConnectorTimeouts')
      return { source: connector.source, health: 'timeout', resultCount: 0, durationMs: Date.now() - started, detail: `No response within ${CONNECTOR_TIMEOUT_MS}ms`, builders: [] }
    }

    // Shape guard: nothing validated connector output before it reached filtering, dedup and
    // scoring, so a source that changed its response format injected malformed objects into
    // results rather than reporting itself broken.
    const builders = Array.isArray(raced) ? raced.filter(isUsableBuilder) : []
    const health: SourceHealth = Array.isArray(raced) ? 'ok' : 'failed'
    if (health === 'failed') {
      log.warn('search_connector_malformed', { source: connector.source })
    }
    return {
      source: connector.source,
      health,
      resultCount: builders.length,
      durationMs: Date.now() - started,
      detail: health === 'ok' ? undefined : 'Connector returned an unexpected shape',
      builders,
    }
  } catch (error) {
    log.warn('search_connector_failed', { source: connector.source, error: error instanceof Error ? error.message : String(error) })
    metrics.increment('searchConnectorFailures')
    return { source: connector.source, health: 'failed', resultCount: 0, durationMs: Date.now() - started, detail: 'Source unavailable', builders: [] }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The minimum a record needs for dedup (`source:sourceId`), scoring (`source`) and display. */
function isUsableBuilder(value: unknown): value is RawBuilder {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RawBuilder>
  return typeof candidate.source === 'string' && candidate.source.length > 0
    && typeof candidate.sourceId === 'string' && candidate.sourceId.length > 0
    && typeof candidate.username === 'string' && candidate.username.length > 0
    && Array.isArray(candidate.topics)
}

/**
 * Drops rows belonging to sources the register no longer permits.
 *
 * A cache entry is written with whatever was enabled at the time. Switching a source off has to stop
 * serving its rows immediately, not once the entry expires — otherwise the kill switch has a
 * five-minute (or Redis-lifetime) tail during which the product still shows data from a source
 * someone withdrew.
 */
function restrictToSources(rows: RawBuilder[], allowed: string[]): RawBuilder[] {
  const permitted = new Set(allowed)
  return rows.filter((row) => permitted.has(row.source))
}

/**
 * Per-source status for a cache hit, reconstructed from the cached rows.
 *
 * A cache hit never contacted any source, so claiming live health would be a lie. What is
 * knowable is which sources are represented in the cached set — and a requested source with no
 * cached rows is reported `ok` with zero results rather than `failed`, because that is exactly what
 * the entry records: the source was asked at write time and contributed nothing. `durationMs` is 0
 * for the same reason; no request was made now.
 */
function statusFromCachedRows(rows: RawBuilder[], requested: string[]): SourceStatus[] {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.source, (counts.get(row.source) ?? 0) + 1)
  return requested.map((source) => ({
    source,
    health: 'ok' as const,
    resultCount: counts.get(source) ?? 0,
    durationMs: 0,
  }))
}

const cache = new Map<string, { results: RawBuilder[]; timestamp: number }>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

function cacheKey(opts: SearchOptions): string {
  return `${opts.keywords.sort().join(',')}-${(opts.sources ?? []).sort().join(',')}-${opts.country ?? ''}-${opts.language ?? ''}-${opts.page ?? 1}-${opts.perPage ?? 30}`
}

/**
 * Backward-compatible facade: thirteen call sites want the ranked list and nothing else.
 * `searchBuildersWithStatus` is for the surfaces that must tell a user which sources answered.
 */
export async function searchBuilders(opts: SearchOptions): Promise<FusedBuilder[]> {
  const { builders } = await searchBuildersWithStatus(opts)
  return builders
}

export async function searchBuildersWithStatus(opts: SearchOptions): Promise<SearchOutcome> {
  const { keywords, sources: requestedSources = ['github', 'hn', 'devto', 'reddit', 'lobsters'], language, country, page = 1, perPage = 30 } = opts
  const cacheKeyStr = cacheKey(opts)
  const start = Date.now()
  metrics.increment('searches')

  // The operator register decides which of the requested sources may be contacted at all. Consulted
  // before the cache, not after: a cache entry written while a source was enabled must not keep
  // serving that source's rows after it was switched off.
  //
  // Dynamic import for the same reason as the connectors — this module is reachable from route files
  // that the client bundle pulls in, and the repository imports `publicDb`, which constructs a real
  // `postgres()` client at module-evaluation time.
  const { partitionRequestedSources } = await import('~/shared/lib/repositories/search-sources')
  const { allowed: sources, refused } = await partitionRequestedSources(requestedSources)
  const disabledStatuses: SourceStatus[] = refused.map((source) => ({
    source,
    health: 'disabled' as const,
    resultCount: 0,
    durationMs: 0,
    detail: 'Switched off in the source register',
  }))
  if (refused.length > 0) log.info('search_sources_refused', { refused })
  if (sources.length === 0) {
    return { builders: [], sources: disabledStatuses }
  }

  // Check in-memory cache first
  const cached = cache.get(cacheKeyStr)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    const visible = restrictToSources(await filterSuppressed(cached.results), sources)
    metrics.increment('searchCacheHits')
    log.info('search_executed', { keywords, sources, resultsCount: visible.length, durationMs: Date.now() - start, cache: 'memory' })
    return { builders: fuseByRank(scoreBuilders(visible)), sources: [...statusFromCachedRows(visible, sources), ...disabledStatuses] }
  }

  // Check Redis cache (if available)
  try {
    const { getRedis } = await import('~/shared/lib/redis')
    const redis = await getRedis()
    if (redis) {
      const redisKey = `search:${cacheKeyStr}`
      const cachedRaw = await redis.get(redisKey)
      if (cachedRaw) {
        const parsed = JSON.parse(cachedRaw) as RawBuilder[]
        cache.set(cacheKeyStr, { results: parsed, timestamp: Date.now() })
        const visible = restrictToSources(await filterSuppressed(parsed), sources)
        metrics.increment('searchCacheHits')
        log.info('search_executed', { keywords, sources, resultsCount: visible.length, durationMs: Date.now() - start, cache: 'redis' })
        return { builders: fuseByRank(scoreBuilders(visible)), sources: [...statusFromCachedRows(visible, sources), ...disabledStatuses] }
      }
    }
  } catch {
    // Redis unavailable — fall through to live search
  }

  const paged = { page, perPage }
  // Tagged, so a settled outcome can be attributed back to its source. The old shape was an
  // untagged `Promise<RawBuilder[]>[]`, which is why nothing downstream could report which
  // connector had answered.
  const connectors: Array<{ source: string; run: () => Promise<RawBuilder[]> }> = []
  const want = (source: string) => sources.includes(source)

  if (want('github')) connectors.push({ source: 'github', run: () => searchGitHub(keywords, { country, language, ...paged }) })
  if (want('hn')) connectors.push({ source: 'hn', run: () => searchHN(keywords, paged) })
  if (want('devto')) connectors.push({ source: 'devto', run: () => searchDevTo(keywords, paged) })
  if (want('reddit')) connectors.push({ source: 'reddit', run: () => searchReddit(keywords, paged) })
  if (want('lobsters')) connectors.push({ source: 'lobsters', run: () => searchLobsters(keywords, paged) })
  if (want('stackoverflow')) connectors.push({ source: 'stackoverflow', run: () => searchStackOverflow(keywords, paged) })
  if (want('npm')) connectors.push({ source: 'npm', run: () => searchNpm(keywords, paged) })
  if (want('huggingface')) connectors.push({ source: 'huggingface', run: () => searchHuggingFace(keywords, paged) })
  if (want('gitlab')) connectors.push({ source: 'gitlab', run: () => searchGitLab(keywords, paged) })
  if (want('codeberg')) connectors.push({ source: 'codeberg', run: () => searchCodeberg(keywords, paged) })
  if (want('hashnode')) connectors.push({ source: 'hashnode', run: () => searchHashnode(keywords, paged) })
  // `sourcehut` was here and is retired (drizzle/0143). sr.ht's own robots.txt disallows "anything used to feed
  // a machine learning model", which is what this product does, so no token could make the connector legitimate
  // — and the API offered no user or repository search to begin with. The registry row stays, disabled, and
  // `resolveRequestedSources` refuses the key, so nothing here needs to know the reason.
  if (want('devpost')) connectors.push({ source: 'devpost', run: () => searchDevpost(keywords, paged) })
  if (want('producthunt')) connectors.push({ source: 'producthunt', run: () => searchProductHunt(keywords, paged) })
  if (want('bluesky')) connectors.push({ source: 'bluesky', run: () => searchBluesky(keywords, paged) })

  const outcomes = await Promise.all(connectors.map((connector) => runConnector(connector)))
  const all = outcomes.flatMap((outcome) => outcome.builders)

  // Post-filter: HN/DevTo/Reddit don't have location/language fields,
  // so the filter only applies to results that have those fields populated.
  // GitHub already filters at the source via its API qualifiers.
  const filtered = all.filter(b => {
    if (language && b.language && b.language.toLowerCase() !== language.toLowerCase()) return false
    if (country && b.country && b.country.toLowerCase() !== country.toLowerCase()) return false
    return true
  })

  const deduped = deduplicateBuilders(filtered)
  cache.set(cacheKeyStr, { results: deduped, timestamp: Date.now() })

  // Write-through to Redis (best-effort, fire-and-forget)
  try {
    const { getRedis } = await import('~/shared/lib/redis')
    const redis = await getRedis()
    if (redis) {
      const redisKey = `search:${cacheKeyStr}`
      // 5 minute TTL — matches in-memory CACHE_TTL
      await redis.set(redisKey, JSON.stringify(deduped), 'EX', 300).catch(() => null)
    }
  } catch {
    // Redis unavailable — in-memory cache is enough
  }

  const visible = await filterSuppressed(deduped)
  log.info('search_executed', {
    keywords,
    sources,
    resultsCount: visible.length,
    durationMs: Date.now() - start,
    cache: 'miss',
    // Which sources actually answered, not merely which were requested — the old log recorded the
    // request and so could never show a silent connector outage.
    degradedSources: outcomes.filter((o) => o.health !== 'ok').map((o) => o.source),
  })
  return {
    builders: fuseByRank(scoreBuilders(visible)),
    sources: [...outcomes.map(({ builders: _builders, ...status }) => status), ...disabledStatuses],
  }
}