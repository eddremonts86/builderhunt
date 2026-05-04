import { env } from '~/shared/lib/env'

export interface RawBuilder {
  id: string
  source: 'reddit'
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

interface RedditSearchResult {
  kind: 't2'
  data: {
    id: string
    name: string
    subreddit: string
    display_name: string
    title?: string
    public_description?: string
    subscribers: number
    active_users: number
    created_utc: number
    icon_img: string
    url: string
  }
}

interface RedditListing {
  children: RedditSearchResult[]
  after?: string
}

export async function searchReddit(keywords: string[]): Promise<RawBuilder[]> {
  const clientId = env.REDDIT_CLIENT_ID
  const clientSecret = env.REDDIT_CLIENT_SECRET
  const query = keywords.join(' ')
  if (!query) return []

  let accessToken = ''
  try {
    if (clientId && clientSecret) {
      const res = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          username: '',
          password: '',
        }),
      })
      const data = await res.json() as { access_token?: string }
      accessToken = data.access_token ?? ''
    }
  } catch {
    // continue without auth
  }

  try {
    const headers: HeadersInit = {
      Accept: 'application/json',
      'User-Agent': 'BuilderHunt/1.0',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    }

    const res = await fetch(
      `https://oauth.reddit.com/search/users?q=${encodeURIComponent(query)}&restrict_sr=false&include_overlap=false&sort=relevance&t=month&limit=20`,
      { headers },
    )
    if (!res.ok) {
      // Fallback to public endpoint
      const publicRes = await fetch(
        `https://www.reddit.com/search/users.json?q=${encodeURIComponent(query)}&restrict_sr=false&sort=relevance&t=month&limit=20`,
        { headers: { 'User-Agent': 'BuilderHunt/1.0' } },
      )
      if (!publicRes.ok) return []
      const publicData = await publicRes.json() as { data: RedditListing }
      return normalizeResults(publicData.data)
    }

    const data = await res.json() as { data: RedditListing }
    return normalizeResults(data.data)
  } catch {
    return []
  }
}

function normalizeResults(data: RedditListing): RawBuilder[] {
  return data.children.map(user => ({
    id: `reddit-${user.data.id}`,
    source: 'reddit' as const,
    sourceId: user.data.id,
    username: user.data.display_name,
    displayName: user.data.title ?? user.data.display_name,
    avatarUrl: user.data.icon_img.split('?')[0],
    bio: user.data.public_description ?? undefined,
    profileUrl: `https://www.reddit.com/${user.data.url}`,
    followersCount: user.data.subscribers,
    language: undefined,
    country: undefined,
    topics: [user.data.subreddit],
    metadata: { activeUsers: user.data.active_users },
  }))
}