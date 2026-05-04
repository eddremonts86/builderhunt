import { searchGitHub } from '~/lib/sources/github'
import { searchHN } from '~/lib/sources/hn'
import { searchDevTo } from '~/lib/sources/devto'
import { searchReddit } from '~/lib/sources/reddit'
import { deduplicateBuilders } from '~/lib/dedup'
import { scoreBuilders, sortByScore } from '~/lib/score'
import type { RawBuilder } from '~/lib/sources/github'

export interface SearchOptions {
  keywords: string[]
  sources?: string[]
  language?: string
  country?: string
}

export type ScoredBuilder = ReturnType<typeof scoreBuilders>[number]

const cache = new Map<string, { results: RawBuilder[]; timestamp: number }>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

function cacheKey(opts: SearchOptions): string {
  return `${opts.keywords.sort().join(',')}-${(opts.sources ?? []).sort().join(',')}`
}

export async function searchBuilders(opts: SearchOptions): Promise<ScoredBuilder[]> {
  const { keywords, sources = ['github', 'hn', 'devto', 'reddit'], language, country } = opts
  const cacheKeyStr = cacheKey(opts)

  // Check cache
  const cached = cache.get(cacheKeyStr)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return sortByScore(scoreBuilders(cached.results))
  }

  const tasks: Promise<RawBuilder[]>[] = []

  if (sources.includes('github')) tasks.push(searchGitHub(keywords))
  if (sources.includes('hn')) tasks.push(searchHN(keywords))
  if (sources.includes('devto')) tasks.push(searchDevTo(keywords))
  if (sources.includes('reddit')) tasks.push(searchReddit(keywords))

  const results = await Promise.all(tasks)
  const all = results.flat()

  // Filter by language/country if specified
  const filtered = all.filter(b => {
    if (language && b.language?.toLowerCase() !== language.toLowerCase()) return false
    if (country && b.country?.toLowerCase() !== country.toLowerCase()) return false
    return true
  })

  const deduped = deduplicateBuilders(filtered)
  cache.set(cacheKeyStr, { results: deduped, timestamp: Date.now() })

  return sortByScore(scoreBuilders(deduped))
}