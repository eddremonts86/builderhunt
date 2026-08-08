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
import { TABLE_PAGE_SIZE } from '~/shared/lib/table/constants'
import {
  createSearchContinuation,
  searchFingerprint,
  SearchContinuationError,
  verifySearchContinuation,
  type ProviderContinuation,
  type SearchContinuationMode,
} from './search-continuation'

export interface SearchOptions {
  keywords: string[]
  sources?: string[]
  language?: string
  country?: string
  page?: number
  perPage?: number
}

/**
 * The sources a caller that names none gets.
 *
 * Named rather than inlined because plan 11's continuation has to fingerprint the *requested* set,
 * and a default that only existed inside a destructuring default would be invisible to it: two
 * requests, one naming these five and one naming nothing, are the same search and must share a
 * fingerprint.
 */
export const DEFAULT_SEARCH_SOURCES = ['github', 'hn', 'devto', 'reddit', 'lobsters'] as const

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

/** The sources a request will actually reach, and a status for every one it will not. */
export interface ContactableSources {
  /** Keys that will be contacted, in the caller's requested order. */
  contacted: string[]
  /** One status per source that was requested and skipped, with the reason. */
  notContacted: SourceStatus[]
}

/**
 * Which of the requested sources may be contacted, and why the rest may not.
 *
 * Extracted from `searchBuildersWithStatus` so a caller can know the answer *before* the fan-out
 * runs. Plan 11's continuation binds this set: a source switched off between two pages has to
 * invalidate the token, and a token can only be checked against a snapshot someone computed
 * separately from the search that used it.
 */
export async function resolveContactableSources(requestedSources: readonly string[]): Promise<ContactableSources> {
  // The operator register decides which of the requested sources may be contacted at all. Consulted
  // before the cache, not after: a cache entry written while a source was enabled must not keep
  // serving that source's rows after it was switched off.
  //
  // Dynamic import for the same reason as the connectors — this module is reachable from route files
  // that the client bundle pulls in, and the repository imports `publicDb`, which constructs a real
  // `postgres()` client at module-evaluation time.
  const { partitionRequestedSources } = await import('~/shared/lib/repositories/search-sources')
  const { allowed: permitted, refused } = await partitionRequestedSources([...requestedSources])
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

  return {
    contacted: permitted.filter((source) => !unconfigured.includes(source)),
    notContacted: [...disabledStatuses, ...unconfiguredStatuses],
  }
}

export async function searchBuildersWithStatus(opts: SearchOptions): Promise<SearchOutcome> {
  const { keywords, sources: requestedSources = DEFAULT_SEARCH_SOURCES, language, country, page = 1, perPage = 30 } = opts
  const cacheKeyStr = cacheKey(opts)
  const start = Date.now()
  metrics.increment('searches')

  const { contacted: sources, notContacted } = await resolveContactableSources(requestedSources)
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

/**
 * What every connector is asked for on one provider page.
 *
 * Unchanged at 30, and deliberately not `TABLE_PAGE_SIZE`. This number reaches thirteen third-party
 * APIs and decides what each of them ranks and returns; moving it would move the fused ranking,
 * which is the one thing plan 11 must not change (`tests/e2e/fixtures/search-ranking.json`).
 */
export const SEARCH_PROVIDER_PAGE_SIZE = 30

/**
 * How deep the federation will page.
 *
 * The old `hasMore: results.length >= perPage` was true on essentially every response — a fan-out
 * over N sources returns up to `N × perPage` rows, so it compared a cross-source total against a
 * per-source ask — which means nothing ever stopped the client from requesting page 40. Worse, a
 * connector that ignores its `page` parameter returns the same rows forever, and dedup only runs
 * *within* one fan-out, so there is no natural end at all. Ten provider pages is far past what any
 * user scrolls and is a bound rather than a hope.
 */
export const SEARCH_MAX_PROVIDER_PAGES = 10

export interface KeywordSearchPageOptions {
  keywords: string[]
  /** As the caller asked. `undefined` means `DEFAULT_SEARCH_SOURCES`. */
  sources?: string[]
  language?: string
  country?: string
  /**
   * Who is asking: an organization id, or `'anon'`. Bound into the continuation so a token minted
   * in one organization cannot resume a page in another — even though this search reads no
   * tenant-scoped rows, because a continuation that ignores scope is a habit, not a special case.
   */
  scope: string
  /**
   * Which mode's continuation this is. The semantic endpoint reaches the same federation two ways:
   * `hybrid` when the local vector leg found some matches but too few, `keyword-fallback` when it
   * could not run at all.
   */
  mode: Extract<SearchContinuationMode, 'keyword' | 'keyword-fallback' | 'hybrid'>
  /** The previous page's `nextCursor`, or null/absent for page one. */
  cursor?: string | null
  /**
   * How many rows this page may hold, clamped to `TABLE_PAGE_SIZE`.
   *
   * Below the clamp only for the hybrid leg, which has already spent part of the page on local
   * vector matches and asks the federation for the remainder. The continuation's `served` counter
   * then advances by what the federation actually contributed, so the next page resumes where this
   * one stopped rather than where a full-size page would have.
   */
  limit?: number
  /**
   * Use this fingerprint instead of computing one from `keywords` and the filters.
   *
   * Only the hybrid leg passes it. Its keywords are *translated* ones — the output of an AI task —
   * so a fingerprint over them would bind the token to a derived value that a cache miss can
   * change, invalidating a perfectly good continuation for a query the user never touched. The
   * semantic endpoint binds the raw query and the query vector instead, which is both stabler and
   * strictly stronger: the translation is a function of them.
   */
  queryFingerprint?: string
  /**
   * Rows to ask each connector for, when the caller wants fewer than `SEARCH_PROVIDER_PAGE_SIZE`.
   *
   * Clamped, never honoured upward — the phase's rule for every page size. A *size* is not the
   * offset paging plan 03 removed: the previews that use it (the onboarding starter query, the
   * pre-search featured strip) ask for six rows because six is what they draw, and dropping the
   * parameter made them fetch thirty per source and miss their seeded cache key.
   */
  providerPageSize?: number
}

export interface KeywordSearchPage {
  builders: FusedBuilder[]
  /** `null` when there is no further page to ask for. */
  nextCursor: string | null
  /**
   * Always `null`. A federation cannot count without exhausting every upstream, and none of the
   * thirteen offers a total to exhaust.
   */
  total: null
  consistency: 'provider-best-effort'
  sources: SourceStatus[]
  degraded: boolean
}

/**
 * One bounded page of federated keyword search.
 *
 * The fan-out is unchanged: every contactable connector is asked for `SEARCH_PROVIDER_PAGE_SIZE`
 * rows of provider page *n*, and the results are deduped, scored and fused exactly as before. What
 * changes is what leaves the server — a slice of at most `TABLE_PAGE_SIZE` of that fused ordering,
 * plus a signed continuation naming where the next slice starts.
 *
 * Two numbers, not one, because `N` sources × 30 rows is up to `N × 30` fused rows for a single
 * provider page. Serving those 50 at a time costs no extra upstream requests at all: the second and
 * third slices come out of the same cache entry the first one populated.
 *
 * The ordering is preserved exactly. Concatenating every slice of provider page *n* reproduces the
 * list the old unbounded response returned, which is what `tests/e2e/search.spec.ts` asserts against
 * the recorded fixture.
 */
export async function pageBuilderSearch(opts: KeywordSearchPageOptions): Promise<KeywordSearchPage> {
  const requested = opts.sources ?? [...DEFAULT_SEARCH_SOURCES]
  const { contacted, notContacted } = await resolveContactableSources(requested)

  const providerPageSize = Math.min(
    Math.max(1, opts.providerPageSize ?? SEARCH_PROVIDER_PAGE_SIZE),
    SEARCH_PROVIDER_PAGE_SIZE,
  )
  const fingerprint = opts.queryFingerprint ?? searchFingerprint({
    keywords: opts.keywords,
    requestedSources: requested,
    language: opts.language,
    country: opts.country,
    providerPageSize,
  })

  // Verified before the fan-out, so a stale token costs a 400 rather than thirteen upstream
  // requests whose results are then thrown away.
  let state: ProviderContinuation = { kind: 'provider', providerPage: 1, served: 0 }
  if (opts.cursor) {
    const resumed = verifySearchContinuation(opts.cursor, {
      mode: opts.mode,
      query: fingerprint,
      scope: opts.scope,
      sources: contacted,
    })
    if (resumed.state.kind !== 'provider') throw new SearchContinuationError('not a federated continuation')
    state = resumed.state
  }

  if (contacted.length === 0) {
    // Nothing to ask. `degraded` rather than an empty success: every requested source was refused
    // or unconfigured, and "no results" would read as "nobody matched".
    return { builders: [], nextCursor: null, total: null, consistency: 'provider-best-effort', sources: notContacted, degraded: notContacted.length > 0 }
  }

  const { builders, sources } = await searchBuildersWithStatus({
    keywords: opts.keywords,
    sources: requested,
    language: opts.language,
    country: opts.country,
    page: state.providerPage,
    perPage: providerPageSize,
  })

  // Clamped, not honoured: page size is a property of what the server is willing to serve.
  const limit = Math.min(Math.max(1, opts.limit ?? TABLE_PAGE_SIZE), TABLE_PAGE_SIZE)
  const slice = builders.slice(state.served, state.served + limit)
  const consumed = state.served + slice.length

  let nextState: ProviderContinuation | null = null
  if (consumed < builders.length) {
    // More of this provider page's fused set is still unserved — no upstream request needed.
    nextState = { kind: 'provider', providerPage: state.providerPage, served: consumed }
  } else if (builders.length > 0 && state.providerPage < SEARCH_MAX_PROVIDER_PAGES) {
    // This provider page is spent. A page that came back empty ends the walk instead: an upstream
    // with nothing more to say will not have more on page n+1 either.
    nextState = { kind: 'provider', providerPage: state.providerPage + 1, served: 0 }
  }

  return {
    builders: slice,
    nextCursor: nextState
      ? createSearchContinuation({
        mode: opts.mode,
        query: fingerprint,
        scope: opts.scope,
        sources: contacted,
        state: nextState,
      })
      : null,
    total: null,
    consistency: 'provider-best-effort',
    sources,
    degraded: sources.some((status) => status.health !== 'ok'),
  }
}