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
import { searchSourceHut } from '~/lib/sources/sourcehut'
import { deduplicateBuilders } from '~/lib/dedup'
import { scoreBuilders, sortByScore } from '~/lib/score'
import type { RawBuilder } from '~/lib/sources/types'
import { log } from '~/shared/lib/log'
import { metrics } from '~/shared/lib/metrics'

export interface SearchOptions {
  keywords: string[]
  sources?: string[]
  language?: string
  country?: string
  page?: number
  perPage?: number
}

export type ScoredBuilder = ReturnType<typeof scoreBuilders>[number]

const cache = new Map<string, { results: RawBuilder[]; timestamp: number }>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

function cacheKey(opts: SearchOptions): string {
  return `${opts.keywords.sort().join(',')}-${(opts.sources ?? []).sort().join(',')}-${opts.country ?? ''}-${opts.language ?? ''}-${opts.page ?? 1}-${opts.perPage ?? 30}`
}

export async function searchBuilders(opts: SearchOptions): Promise<ScoredBuilder[]> {
  const { keywords, sources = ['github', 'hn', 'devto', 'reddit', 'lobsters'], language, country, page = 1, perPage = 30 } = opts
  const cacheKeyStr = cacheKey(opts)
  const start = Date.now()
  metrics.increment('searches')

  // Check in-memory cache first
  const cached = cache.get(cacheKeyStr)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    metrics.increment('searchCacheHits')
    log.info('search_executed', { keywords, sources, resultsCount: cached.results.length, durationMs: Date.now() - start, cache: 'memory' })
    return sortByScore(scoreBuilders(cached.results))
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
        metrics.increment('searchCacheHits')
        log.info('search_executed', { keywords, sources, resultsCount: parsed.length, durationMs: Date.now() - start, cache: 'redis' })
        return sortByScore(scoreBuilders(parsed))
      }
    }
  } catch {
    // Redis unavailable — fall through to live search
  }

  const tasks: Promise<RawBuilder[]>[] = []

  if (sources.includes('github')) tasks.push(searchGitHub(keywords, { country, language, page, perPage }))
  if (sources.includes('hn')) tasks.push(searchHN(keywords, { page, perPage }))
  if (sources.includes('devto')) tasks.push(searchDevTo(keywords, { page, perPage }))
  if (sources.includes('reddit')) tasks.push(searchReddit(keywords, { page, perPage }))
  if (sources.includes('lobsters')) tasks.push(searchLobsters(keywords, { page, perPage }))
  if (sources.includes('stackoverflow')) tasks.push(searchStackOverflow(keywords, { page, perPage }))
  if (sources.includes('npm')) tasks.push(searchNpm(keywords, { page, perPage }))
  if (sources.includes('huggingface')) tasks.push(searchHuggingFace(keywords, { page, perPage }))
  if (sources.includes('gitlab')) tasks.push(searchGitLab(keywords, { page, perPage }))
  if (sources.includes('codeberg')) tasks.push(searchCodeberg(keywords, { page, perPage }))
  if (sources.includes('hashnode')) tasks.push(searchHashnode(keywords, { page, perPage }))
  if (sources.includes('sourcehut')) tasks.push(searchSourceHut(keywords, { page, perPage }))

  const results = await Promise.all(tasks)
  const all = results.flat()

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

  log.info('search_executed', { keywords, sources, resultsCount: deduped.length, durationMs: Date.now() - start, cache: 'miss' })
  return sortByScore(scoreBuilders(deduped))
}