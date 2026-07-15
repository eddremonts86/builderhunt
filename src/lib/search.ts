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
import { deduplicateBuilders } from '~/lib/dedup'
import { scoreBuilders, sortByScore } from '~/lib/score'
import type { RawBuilder } from '~/lib/sources/github'

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

  // Check cache
  const cached = cache.get(cacheKeyStr)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return sortByScore(scoreBuilders(cached.results))
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

  return sortByScore(scoreBuilders(deduped))
}