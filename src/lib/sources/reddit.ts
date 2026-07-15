import { env } from '~/shared/lib/env'

export interface RawBuilder {
  id: string
  kind: 'person'
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

export async function searchReddit(keywords: string[], options: { page?: number; perPage?: number } = {}): Promise<RawBuilder[]> {
  const clientId = env.REDDIT_CLIENT_ID
  const clientSecret = env.REDDIT_CLIENT_SECRET
  const query = keywords.join(' ')
  if (!query) return []

  const { page = 1, perPage = 20 } = options
  // Reddit uses cursor-based pagination via `after`
  // We compute the `after` as a positional offset (not ideal but works
  // because reddit returns roughly consistent results for short windows)
  const after = page > 1 ? `t3_after_${(page - 1) * perPage}` : ''

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

    const url = new URL(`https://oauth.reddit.com/search/users`)
    url.searchParams.set('q', query)
    url.searchParams.set('restrict_sr', 'false')
    url.searchParams.set('include_overlap', 'false')
    url.searchParams.set('sort', 'relevance')
    url.searchParams.set('t', 'month')
    url.searchParams.set('limit', String(perPage))
    if (after) url.searchParams.set('after', after)

    const res = await fetch(url.toString(), { headers })
    if (!res.ok) {
      const publicUrl = new URL('https://www.reddit.com/search/users.json')
      publicUrl.searchParams.set('q', query)
      publicUrl.searchParams.set('restrict_sr', 'false')
      publicUrl.searchParams.set('sort', 'relevance')
      publicUrl.searchParams.set('t', 'month')
      publicUrl.searchParams.set('limit', String(perPage))
      if (after) publicUrl.searchParams.set('after', after)
      const publicRes = await fetch(publicUrl.toString(), {
        headers: { 'User-Agent': 'BuilderHunt/1.0' },
      })
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
    kind: 'person' as const,
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