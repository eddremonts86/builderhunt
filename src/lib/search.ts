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
import { searchDevpost } from '~/lib/sources/devpost'
import { searchProductHunt } from '~/lib/sources/producthunt'
import { searchBluesky } from '~/lib/sources/bluesky'
import { deduplicateBuilders } from '~/lib/dedup'
import { fuseByRank, scoreBuilders, type FusedBuilder } from '~/lib/score'
import type { RawBuilder, SourceName } from '~/lib/sources/types'
import { env } from '~/shared/lib/env'
import { CREDENTIAL_ENV_VARS, CREDENTIAL_MANDATORY_SOURCES } from '~/shared/lib/source-credentials'
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
 *
 * `unconfigured` is the same argument one step further in. The source is enabled in the register and
 * its connector exists, but the credential its upstream refuses to work without is absent from this
 * deployment — so it was not contacted either, and for a reason an operator can fix rather than a
 * developer. Before this value existed, `reddit` reported `ok, 0 results` on every search: its
 * connector caught a 403 and returned `[]`, which is indistinguishable from "nobody matched". That is
 * the failure mode that let `hashnode` sit enabled and dead for months
 * (docs/operations/public-enrichment-source-register.md#hashnode), reproduced on a live source.
 */
export type SourceHealth = 'ok' | 'failed' | 'timeout' | 'disabled' | 'unconfigured'

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
function statusFromCachedRows(rows: RawBuilder[], requested: string[], recorded?: SourceStatus[]): SourceStatus[] {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.source, (counts.get(row.source) ?? 0) + 1)
  const bySource = new Map((recorded ?? []).map((status) => [status.source, status]))
  return requested.map((source) => {
    // The recorded health wins where it exists: a source that timed out at write time did not
    // become healthy by being read from a cache. `durationMs` is still 0 — no request was made now
    // — and the recorded `detail` travels so the UI can say why.
    const written = bySource.get(source)
    if (written && written.health !== 'ok') {
      return { source, health: written.health, resultCount: 0, durationMs: 0, detail: written.detail }
    }
    return { source, health: 'ok' as const, resultCount: counts.get(source) ?? 0, durationMs: 0 }
  })
}

/**
 * A cache entry carries the per-source health of the fan-out that produced it, not just its rows.
 *
 * Without that, a cache hit reconstructed health from the rows alone (`statusFromCachedRows`) and a
 * source with none was reported `ok, 0 results`. So a connector that timed out was written into the
 * cache as a success and served that way for the next five minutes — one slow moment became five
 * minutes of a source that looked healthy and had nothing to say. Found 2026-08-05 when a GitLab
 * timeout re-probed as `ok, 0 results, 48ms`: the second run never contacted GitLab at all.
 */
interface CacheEntry {
  results: RawBuilder[]
  /** Health of each contacted source at write time. Absent on entries written before this field existed. */
  statuses?: SourceStatus[]
  timestamp: number
}

const cache = new Map<string, CacheEntry>()
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
  const { allowed: permitted, refused } = await partitionRequestedSources(requestedSources)
  const disabledStatuses: SourceStatus[] = refused.map((source) => ({
    source,
    health: 'disabled' as const,
    resultCount: 0,
    durationMs: 0,
    detail: 'Switched off in the source register',
  }))
  if (refused.length > 0) log.info('search_sources_refused', { refused })

  /*
   * Second reason not to contact a source: the register permits it, but the credential its upstream
   * refuses to work without is absent here. Only the two sources that degrade to *nothing* are
   * filtered — see `CREDENTIAL_MANDATORY_SOURCES`. GitHub and friends drop to a smaller anonymous
   * quota without their tokens and still belong in the search.
   *
   * Skipping the request is the smaller half of this. The point is the status: `searchReddit` used to
   * catch its own 403 and return `[]`, which `runConnector` correctly reports as `ok` with zero
   * results, so an unauthenticated deployment showed Reddit as a healthy source that simply never
   * matched anyone. Same shape as the hashnode retirement, on a source still switched on. That
   * connector now throws instead, so a Reddit outage *with* credentials reports `failed`; this branch
   * covers the case where there are no credentials to fail with.
   */
  const unconfigured = permitted.filter((source) => {
    if (!CREDENTIAL_MANDATORY_SOURCES.includes(source as SourceName)) return false
    return !(CREDENTIAL_ENV_VARS[source as SourceName] ?? []).every((name) => Boolean(env[name]))
  })
  const unconfiguredStatuses: SourceStatus[] = unconfigured.map((source) => ({
    source,
    health: 'unconfigured' as const,
    resultCount: 0,
    durationMs: 0,
    // Names the variable, never a value. This string reaches the search UI.
    detail: `Not contacted — ${(CREDENTIAL_ENV_VARS[source as SourceName] ?? []).join(' and ')} not set`,
  }))
  if (unconfigured.length > 0) log.warn('search_sources_unconfigured', { unconfigured })

  const sources = permitted.filter((source) => !unconfigured.includes(source))
  const notContacted = [...disabledStatuses, ...unconfiguredStatuses]
  if (sources.length === 0) {
    return { builders: [], sources: notContacted }
  }

  // Check in-memory cache first
  const cached = cache.get(cacheKeyStr)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    const visible = restrictToSources(await filterSuppressed(cached.results), sources)
    metrics.increment('searchCacheHits')
    log.info('search_executed', { keywords, sources, resultsCount: visible.length, durationMs: Date.now() - start, cache: 'memory' })
    return { builders: fuseByRank(scoreBuilders(visible)), sources: [...statusFromCachedRows(visible, sources, cached.statuses), ...notContacted] }
  }

  // Check Redis cache (if available)
  try {
    const { getRedis } = await import('~/shared/lib/redis')
    const redis = await getRedis()
    if (redis) {
      const redisKey = `search:${cacheKeyStr}`
      const cachedRaw = await redis.get(redisKey)
      if (cachedRaw) {
        // Two shapes live under this key: a bare row array (every entry written before health was
        // recorded, and any still inside its five-minute TTL during a deploy) and the tagged object.
        // An untagged entry simply has no recorded health, which is the pre-existing behaviour.
        const decoded = JSON.parse(cachedRaw) as RawBuilder[] | { results: RawBuilder[]; statuses?: SourceStatus[] }
        const parsed = Array.isArray(decoded) ? decoded : decoded.results
        const statuses = Array.isArray(decoded) ? undefined : decoded.statuses
        cache.set(cacheKeyStr, { results: parsed, statuses, timestamp: Date.now() })
        const visible = restrictToSources(await filterSuppressed(parsed), sources)
        metrics.increment('searchCacheHits')
        log.info('search_executed', { keywords, sources, resultsCount: visible.length, durationMs: Date.now() - start, cache: 'redis' })
        return { builders: fuseByRank(scoreBuilders(visible)), sources: [...statusFromCachedRows(visible, sources, statuses), ...notContacted] }
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
  // `hashnode` was here and is retired (drizzle/0144), for a plainer reason than sourcehut's: Hashnode moved
  // its public GraphQL API behind a paid plan, so every query answered `[]` regardless of the key — which was
  // documented as optional, meaning nothing in the behaviour revealed the source had stopped working.
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
  const liveStatuses = outcomes.map(({ builders: _builders, ...status }) => status)
  cache.set(cacheKeyStr, { results: deduped, statuses: liveStatuses, timestamp: Date.now() })

  // Write-through to Redis (best-effort, fire-and-forget)
  try {
    const { getRedis } = await import('~/shared/lib/redis')
    const redis = await getRedis()
    if (redis) {
      const redisKey = `search:${cacheKeyStr}`
      // 5 minute TTL — matches in-memory CACHE_TTL
      await redis.set(redisKey, JSON.stringify({ results: deduped, statuses: liveStatuses }), 'EX', 300).catch(() => null)
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
    sources: [...liveStatuses, ...notContacted],
  }
}