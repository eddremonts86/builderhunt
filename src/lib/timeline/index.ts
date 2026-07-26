import { getRedis } from '~/shared/lib/redis'
import type { SourceName } from '~/lib/sources/types'
import { normalizeEvents } from './normalize'
import { fetchGithubEvents } from './fetchers/github'
import { fetchHNEvents } from './fetchers/hn'
import { fetchDevToEvents } from './fetchers/devto'
import { fetchStackOverflowEvents } from './fetchers/stackoverflow'
import { fetchGitlabEvents } from './fetchers/gitlab'
import type { TimelineEvent, TimelineResult } from './types'

const TTL_SECONDS = 21_600 // 6h
const NEGATIVE_TTL_SECONDS = 600 // 10m — covers both "genuinely no activity" and
// "upstream failed"; the fetchers never throw, so this layer can't (and
// doesn't need to) tell the two apart. Either way, at most one more
// upstream attempt per 10 minutes for that builder.

const SUPPORTED_SOURCES: readonly SourceName[] = ['github', 'hn', 'devto', 'stackoverflow', 'gitlab']

export interface TimelineBuilderRef {
  source: SourceName
  sourceId: string
  username: string
}

async function dispatch(builder: TimelineBuilderRef): Promise<TimelineEvent[]> {
  switch (builder.source) {
    case 'github': return fetchGithubEvents({ username: builder.username })
    case 'hn': return fetchHNEvents({ username: builder.username })
    case 'devto': return fetchDevToEvents({ username: builder.username })
    case 'stackoverflow': return fetchStackOverflowEvents({ sourceId: builder.sourceId })
    case 'gitlab': return fetchGitlabEvents({ sourceId: builder.sourceId })
    default: return []
  }
}

function cacheKey(source: string, sourceId: string): string {
  return `timeline:${source}:${sourceId}`
}

interface MemoryCacheEntry {
  result: TimelineResult
  expiresAt: number
}

const memoryCache = new Map<string, MemoryCacheEntry>()

async function readCache(key: string): Promise<TimelineResult | null> {
  const mem = memoryCache.get(key)
  if (mem && mem.expiresAt > Date.now()) return mem.result

  try {
    const redis = await getRedis()
    if (redis) {
      const raw = await redis.get(key)
      if (raw) return JSON.parse(raw) as TimelineResult
    }
  } catch {
    // Redis unavailable — fall through to a live fetch, same trade-off as search.ts.
  }
  return null
}

async function writeCache(key: string, result: TimelineResult, ttlSeconds: number): Promise<void> {
  memoryCache.set(key, { result, expiresAt: Date.now() + ttlSeconds * 1000 })
  try {
    const redis = await getRedis()
    if (redis) await redis.set(key, JSON.stringify(result), 'EX', ttlSeconds)
  } catch {
    // Best-effort — the in-memory layer above still prevents a per-view refetch on this instance.
  }
}

export async function getBuilderTimeline(builder: TimelineBuilderRef): Promise<TimelineResult> {
  const key = cacheKey(builder.source, builder.sourceId)
  const cached = await readCache(key)
  if (cached) return cached

  if (!SUPPORTED_SOURCES.includes(builder.source)) {
    const result: TimelineResult = { events: [], source: builder.source, supported: false, fetchedAt: new Date().toISOString() }
    await writeCache(key, result, TTL_SECONDS)
    return result
  }

  const raw = await dispatch(builder)
  const events = normalizeEvents(raw)
  const result: TimelineResult = { events, source: builder.source, supported: true, fetchedAt: new Date().toISOString() }
  await writeCache(key, result, events.length > 0 ? TTL_SECONDS : NEGATIVE_TTL_SECONDS)
  return result
}
