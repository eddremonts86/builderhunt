import { env } from '~/shared/lib/env'

export interface RawBuilder {
  id: string
  source: 'devto'
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

interface DevToUser {
  id: number
  username: string
  name?: string
  profile_image: string
  bio?: string
  github_username?: string
  twitter_username?: string
  website_url?: string
  public_reactions_count: number
  followers_count: number
  following_count: number
  articles_count: number
}

export async function searchDevTo(keywords: string[]): Promise<RawBuilder[]> {
  const baseUrl = env.DEVTO_API_URL
  const query = keywords.join(' ')
  if (!query) return []

  try {
    const res = await fetch(
      `${baseUrl}/search/users?per_page=20&q=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': 'BuilderHunt/1.0' } },
    )
    if (!res.ok) return []
    const users: DevToUser[] = await res.json()

    return users.map(user => ({
      id: `devto-${user.id}`,
      source: 'devto' as const,
      sourceId: String(user.id),
      username: user.username,
      displayName: user.name ?? undefined,
      avatarUrl: user.profile_image,
      bio: user.bio ?? undefined,
      profileUrl: `https://dev.to/${user.username}`,
      followersCount: user.followers_count,
      language: undefined,
      country: undefined,
      topics: [],
      metadata: {
        articlesCount: user.articles_count,
        reactions: user.public_reactions_count,
        github: user.github_username,
        twitter: user.twitter_username,
      },
    }))
  } catch {
    return []
  }
}