import { env } from '~/shared/lib/env'

export interface RawBuilder {
  id: string
  source: 'hn'
  sourceId: string
  username: string
  displayName?: string
  avatarUrl?: string
  bio?: string
  profileUrl: string
  followersCount?: number
  language?: string
  country?: string
  topics: string[]
  metadata: Record<string, unknown>
}

interface HNUser {
  id: string
  karma: number
  about?: string
  submitted?: number[]
  created: number
}

export async function searchHN(keywords: string[]): Promise<RawBuilder[]> {
  const baseUrl = env.HACKERNEWS_API_URL
  const query = keywords.join(' ').toLowerCase()
  if (!query) return []

  try {
    // Search for users who submitted items matching keywords
    // HN doesn't have a real search API, so we search top stories
    const topStoriesRes = await fetch(`${baseUrl}/topstories.json`)
    const topIds: number[] = await topStoriesRes.json()
    const sampleIds = topIds.slice(0, 100)

    const usersMap = new Map<string, { id: string; karma: number; about?: string }>()

    // Collect authors from top stories
    const storyPromises = sampleIds.slice(0, 50).map(async (id: number) => {
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
      users.slice(0, 20).map(async (u) => {
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