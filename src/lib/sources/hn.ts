import { env } from '~/shared/lib/env'
import type { RawBuilder } from '~/lib/sources/types'

interface AlgoliaHit {
  author: string
  points: number | null
  title?: string | null
  story_title?: string | null
  comment_text?: string | null
  created_at: string
}

interface AlgoliaSearchResponse {
  hits: AlgoliaHit[]
}

interface HNUser {
  id: string
  karma: number
  about?: string
  submitted?: number[]
  created: number
}

interface AuthorMatch {
  matchCount: number
  bestTitle: string
  lastSeen: number
  topPoints: number
}

/**
 * HN's Firebase API (used previously) has no full-text search — it only
 * exposes item/user lookups by id. Sampling the current front page and
 * ignoring the query meant every search returned the same top-karma users
 * regardless of relevance. HN's Algolia-backed Search API does real
 * full-text search across stories and comments, so we use that to find
 * users who actually posted something matching the query.
 */
export async function searchHN(keywords: string[], options: { page?: number; perPage?: number } = {}): Promise<RawBuilder[]> {
  const query = keywords.join(' ').trim()
  if (!query) return []

  const { page = 1, perPage = 30 } = options

  try {
    const url = new URL('https://hn.algolia.com/api/v1/search')
    url.searchParams.set('query', query)
    url.searchParams.set('tags', '(story,comment)')
    url.searchParams.set('hitsPerPage', '100')
    url.searchParams.set('page', String(page - 1))

    const res = await fetch(url.toString())
    if (!res.ok) return []
    const data = await res.json() as AlgoliaSearchResponse

    // Aggregate matching items by author: how many items matched, the
    // highest-points one (used as the visible "why"), and the most
    // recent match (used for recency scoring).
    const byAuthor = new Map<string, AuthorMatch>()
    for (const hit of data.hits) {
      if (!hit.author) continue
      const title = hit.title ?? hit.story_title ?? hit.comment_text?.slice(0, 140) ?? ''
      const points = hit.points ?? 0
      const ts = Date.parse(hit.created_at) || 0
      const existing = byAuthor.get(hit.author)
      if (!existing) {
        byAuthor.set(hit.author, { matchCount: 1, bestTitle: title, lastSeen: ts, topPoints: points })
      } else {
        existing.matchCount += 1
        existing.lastSeen = Math.max(existing.lastSeen, ts)
        if (points > existing.topPoints) {
          existing.topPoints = points
          existing.bestTitle = title
        }
      }
    }

    const authors = Array.from(byAuthor.entries())
      .sort((a, b) => b[1].topPoints - a[1].topPoints)
      .slice(0, perPage)

    const userDetails = await Promise.all(
      authors.map(async ([username, match]) => {
        try {
          const userRes = await fetch(`${env.HACKERNEWS_API_URL}/user/${username}.json`)
          const user = await userRes.json() as HNUser | null
          if (!user) return null
          return { user, match, username }
        } catch {
          return null
        }
      }),
    )

    return userDetails
      .filter((u): u is NonNullable<typeof u> => u !== null)
      .map(({ user, match, username }): RawBuilder => ({
        id: `hn-${username}`,
        kind: 'person',
        source: 'hn',
        sourceId: username,
        username,
        displayName: undefined,
        avatarUrl: undefined,
        bio: user.about ?? (match.bestTitle ? `Posted: "${match.bestTitle}"` : undefined),
        profileUrl: `https://news.ycombinator.com/user?id=${username}`,
        followersCount: user.karma,
        language: undefined,
        country: undefined,
        topics: keywords,
        metadata: {
          submittedCount: user.submitted?.length ?? 0,
          lastSeen: match.lastSeen || undefined,
          matchCount: match.matchCount,
        },
      }))
  } catch {
    return []
  }
}
