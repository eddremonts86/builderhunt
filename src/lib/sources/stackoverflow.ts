import { env } from '~/shared/lib/env'
import { log } from '~/shared/lib/log'
import type { RawBuilder } from '~/lib/sources/types'

/**
 * Stack Overflow source — expertise signal.
 *
 * Strategy: use `/tags/{tag}/top-answerers/{period}` to find top users
 * for each query keyword. This is the canonical "experts in this topic"
 * endpoint. A user matching multiple keywords is a stronger signal.
 *
 * The endpoint already includes user data (reputation, badges, location)
 * AND tag-specific stats (post_count, score in this tag). We just batch
 * the top-tags call to enrich topics.
 *
 * Quota: 300 req/day per IP without a key, 10k/day with a registered key
 * (https://stackapps.com/apps/register). One call per keyword + one batch
 * top-tags call.
 *
 * Spec reference: plans/phase-1/14-stack-overflow-integration/spec.md
 */
interface SOTagTopUser {
  user: {
    user_id: number
    display_name: string
    reputation: number
    user_type: string
    profile_image: string
    link: string
    accept_rate?: number
  }
  post_count: number
  score: number
}

interface SOTopTag {
  user_id: number
  tag_name: string
  answer_count: number
  answer_score: number
  question_count: number
  question_score: number
}

const SO_BASE = 'https://api.stackexchange.com/2.3'

/**
 * Common query words don't match Stack Overflow's actual tag slugs
 * (e.g. "react" is tagged `reactjs`, "node" is `node.js`). Without this
 * map, `/tags/{tag}/top-answerers` 200s with an empty `items` array for
 * any of these — no error, just silent zero results.
 */
const TAG_SYNONYMS: Record<string, string> = {
  react: 'reactjs',
  vue: 'vuejs3',
  angular: 'angular',
  node: 'node.js',
  nodejs: 'node.js',
  golang: 'go',
  csharp: 'c#',
  cplusplus: 'c++',
  cpp: 'c++',
  dotnet: '.net',
  aspnet: 'asp.net',
  nextjs: 'next.js',
  next: 'next.js',
  ml: 'machine-learning',
}

function toSOTag(term: string): string {
  return TAG_SYNONYMS[term] ?? term
}

function authParams(): string {
  if (env.STACKOVERFLOW_API_KEY) {
    return `&key=${encodeURIComponent(env.STACKOVERFLOW_API_KEY)}`
  }
  return ''
}

const LOW_QUOTA_THRESHOLD = 50

/** StackExchange API responses carry `quota_remaining`/`quota_max` alongside `items` on every
 * call — warn once it's running low so quota exhaustion shows up in logs well before every
 * search silently starts returning `[]`, not just when it's already too late. */
function warnIfQuotaLow(data: { quota_remaining?: number; quota_max?: number }): void {
  if (typeof data.quota_remaining === 'number' && data.quota_remaining < LOW_QUOTA_THRESHOLD) {
    log.warn('stackoverflow_quota_low', { quotaRemaining: data.quota_remaining, quotaMax: data.quota_max })
  }
}

async function fetchTopAnswerersForTag(tag: string, period: 'all_time' | 'month' = 'all_time'): Promise<SOTagTopUser[]> {
  try {
    const url = `${SO_BASE}/tags/${encodeURIComponent(tag)}/top-answerers/${period}?site=stackoverflow${authParams()}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'BuilderHunt/1.0 (stackoverflow source)' },
    })
    if (!res.ok) {
      log.warn('stackoverflow_request_failed', { status: res.status, endpoint: 'top-answerers' })
      return []
    }
    const data = (await res.json()) as { items: SOTagTopUser[]; quota_remaining?: number; quota_max?: number }
    warnIfQuotaLow(data)
    return data.items ?? []
  } catch {
    return []
  }
}

async function fetchTopTags(userIds: number[]): Promise<Map<number, string[]>> {
  if (userIds.length === 0) return new Map()
  const chunk = userIds.slice(0, 100)
  const idsParam = chunk.join(';')
  try {
    const url = `${SO_BASE}/users/${idsParam}/top-tags?site=stackoverflow${authParams()}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'BuilderHunt/1.0 (stackoverflow source)' },
    })
    if (!res.ok) {
      log.warn('stackoverflow_request_failed', { status: res.status, endpoint: 'top-tags' })
      return new Map()
    }
    const data = (await res.json()) as { items: SOTopTag[]; quota_remaining?: number; quota_max?: number }
    warnIfQuotaLow(data)
    const byUser = new Map<number, string[]>()
    for (const t of data.items ?? []) {
      const arr = byUser.get(t.user_id) ?? []
      arr.push(t.tag_name)
      byUser.set(t.user_id, arr)
    }
    return byUser
  } catch {
    return new Map()
  }
}

export interface SearchStackOverflowOptions {
  page?: number
  perPage?: number
}

export async function searchStackOverflow(
  keywords: string[],
  options: SearchStackOverflowOptions = {},
): Promise<RawBuilder[]> {
  const { page = 1, perPage = 30 } = options
  const terms = keywords.map((k) => k.toLowerCase()).filter(Boolean)
  if (terms.length === 0) return []

  // 1. For each query term, fetch top answerers for that tag (in parallel).
  const perTagResults = await Promise.all(terms.map((t) => fetchTopAnswerersForTag(toSOTag(t))))
  const userScores = new Map<number, { user: SOTagTopUser['user']; matchedTags: string[]; postScore: number; postCount: number }>()
  for (let i = 0; i < terms.length; i++) {
    const tag = terms[i]
    for (const item of perTagResults[i]) {
      const u = item.user
      const existing = userScores.get(u.user_id)
      if (existing) {
        existing.matchedTags.push(tag)
        // Sum across tags
        existing.postScore += item.score
        existing.postCount += item.post_count
      } else {
        userScores.set(u.user_id, {
          user: u,
          matchedTags: [tag],
          postScore: item.score,
          postCount: item.post_count,
        })
      }
    }
  }
  if (userScores.size === 0) return []

  // 2. Batch fetch top tags (one call, up to 100 ids)
  const userIds = Array.from(userScores.keys())
  const topTagsByUser = await fetchTopTags(userIds)

  // 3. Sort by tag-specific score (desc), then global reputation
  const composed = Array.from(userScores.entries())
    .filter(([_, v]) => v.user.user_type === 'registered')
    .sort(([_, a], [__, b]) => {
      if (b.postScore !== a.postScore) return b.postScore - a.postScore
      return b.user.reputation - a.user.reputation
    })

  // 4. Pagination
  const start = (page - 1) * perPage
  const slice = composed.slice(start, start + perPage)

  return slice.map(([userId, { user, matchedTags, postScore, postCount }]) => {
    const topTags = topTagsByUser.get(userId) ?? []
    return {
      id: `so-${userId}`,
      kind: 'person' as const,
      source: 'stackoverflow' as const,
      sourceId: String(userId),
      username: user.display_name,
      displayName: user.display_name,
      avatarUrl: user.profile_image || undefined,
      bio: user.accept_rate != null ? `${user.accept_rate}% accept rate` : undefined,
      profileUrl: user.link,
      // No followers; reputation is the SO proxy for "how much the community trusts them"
      followersCount: user.reputation,
      language: undefined,
      country: undefined,
      topics: topTags.slice(0, 8),
      metadata: {
        reputation: user.reputation,
        acceptRate: user.accept_rate ?? null,
        postCount,
        postScore,
        lastSeen: Date.now(),
        matchedTags,
      },
    }
  })
}
