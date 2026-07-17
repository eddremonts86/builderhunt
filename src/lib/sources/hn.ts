import { env } from '~/shared/lib/env'
import type { RawBuilder } from '~/lib/sources/types'

interface HNUser {
  id: string
  karma: number
  about?: string
  submitted?: number[]
  created: number
}

export async function searchHN(keywords: string[], options: { page?: number; perPage?: number } = {}): Promise<RawBuilder[]> {
  const baseUrl = env.HACKERNEWS_API_URL
  const query = keywords.join(' ').toLowerCase()
  if (!query) return []

  const { page = 1, perPage = 30 } = options
  // HN doesn't support real search. We sample top stories; pagination
  // by shifting the slice.
  const sampleSize = 100 * page

  try {
    // Search for users who submitted items matching keywords
    const topStoriesRes = await fetch(`${baseUrl}/topstories.json`)
    const topIds: number[] = await topStoriesRes.json()
    const sampleIds = topIds.slice(0, sampleSize)

    const usersMap = new Map<string, { id: string; karma: number; about?: string }>()

    // Collect authors from top stories (with offset for pagination)
    const startIdx = (page - 1) * 50
    const storyPromises = sampleIds.slice(startIdx, startIdx + 50).map(async (id: number) => {
      try {
        const res = await fetch(`${baseUrl}/item/${id}.json`)
        const item = await res.json()
        if (item && item.type === 'story' && item.by) {
          usersMap.set(item.by, { id: item.by, karma: 0 })
        }
      } catch {
        // skip
      }
    })

    await Promise.all(storyPromises)

    // Fetch user details for karma
    const users = Array.from(usersMap.values())
    const userDetails = await Promise.all(
      users.slice(0, perPage).map(async (u) => {
        try {
          const res = await fetch(`${baseUrl}/user/${u.id}.json`)
          return res.json() as Promise<HNUser>
        } catch {
          return null
        }
      }),
    )

    return userDetails
      .filter((u): u is HNUser => u !== null)
      .map(user => ({
        id: `hn-${user.id}`,
        kind: 'person' as const,
        source: 'hn' as const,
        sourceId: user.id,
        username: user.id,
        displayName: undefined,
        avatarUrl: undefined,
        bio: user.about ?? undefined,
        profileUrl: `https://news.ycombinator.com/user?id=${user.id}`,
        followersCount: user.karma,
        language: undefined,
        country: undefined,
        topics: [],
        metadata: { submittedCount: user.submitted?.length ?? 0 },
      }))
  } catch {
    return []
  }
}