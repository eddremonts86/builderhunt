import { env } from '~/shared/lib/env'
import type { RawBuilder } from '~/lib/sources/types'

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

  /*
   * Reddit is one of the two connectors with no unauthenticated mode at all — see
   * `CREDENTIAL_MANDATORY_SOURCES`, which is why `~/lib/search` reports it `unconfigured` and never
   * calls this function when the keys are absent.
   *
   * There used to be a fallback here to `https://www.reddit.com/search/users.json`, described as the
   * public path. **It stopped being one.** Verified 2026-08-05: that URL answers **403 with an HTML
   * block page**, as does `oauth.reddit.com` without a token. So the fallback could only ever fail,
   * and because both failures ended in `return []`, the source reported `ok, 0 results` on every
   * search — a dead connector that looked like a quiet one, which is exactly how `hashnode` went
   * unnoticed for months. Removed rather than repaired: a fallback that cannot succeed is worse than
   * none, because it reads as a working degraded path.
   *
   * What replaces it is throwing. `runConnector` turns a rejection into `health: 'failed'` with a
   * generic detail and leaves every other source untouched, so a Reddit outage is now visible instead
   * of silent.
   */
  if (!clientId || !clientSecret) {
    throw new Error('reddit_credentials_absent')
  }

  const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  })
  if (!tokenRes.ok) throw new Error(`reddit_token_${tokenRes.status}`)
  const accessToken = ((await tokenRes.json()) as { access_token?: string }).access_token ?? ''
  if (!accessToken) throw new Error('reddit_token_empty')

  const url = new URL('https://oauth.reddit.com/search/users')
  url.searchParams.set('q', query)
  url.searchParams.set('restrict_sr', 'false')
  url.searchParams.set('include_overlap', 'false')
  url.searchParams.set('sort', 'relevance')
  url.searchParams.set('t', 'month')
  url.searchParams.set('limit', String(perPage))
  if (after) url.searchParams.set('after', after)

  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'BuilderHunt/1.0',
      Authorization: `Bearer ${accessToken}`,
    },
  })
  // Status only. Reddit's error bodies are HTML and can carry the request's own parameters.
  if (!res.ok) throw new Error(`reddit_search_${res.status}`)

  const data = await res.json() as { data: RedditListing }
  return normalizeResults(data.data)
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