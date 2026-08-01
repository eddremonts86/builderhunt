import { env } from '~/shared/lib/env'
import type { RawBuilder } from '~/lib/sources/types'

/**
 * What `GET /search/users` actually returns.
 *
 * Deliberately narrow, and that narrowness is the point. This interface previously also declared `name`,
 * `bio`, `followers`, `location`, `public_repos` and `created_at` — **none of which the search endpoint
 * sends.** Verified against the live API: the response carries `login`, `id`, `avatar_url`, `html_url`,
 * `score`, `type` and a set of URL templates, and nothing else.
 *
 * The cost of that fiction was measurable in this repository's own database: of 43 GitHub people, 1 had a
 * display name, 0 had a bio, 0 had a location and 0 had a follower count. GitHub is the most important
 * source for finding developers, and it was producing a username and an avatar.
 *
 * `hydrateUsers` below fetches the full profile, which is the only way to get those fields — and the same
 * call is what yields `blog` and `twitter_username`, the self-declared cross-links that make identity
 * unification possible at all.
 */
interface GitHubSearchUser {
  login: string
  id: number
  avatar_url: string
  html_url: string
  /** `User` or `Organization`. Present on the search response, and the only field there that distinguishes
   * the two — `type:user` in the query does not exclude organizations. */
  type?: string
}

/** What `GET /users/{login}` adds. Every field here is absent from the search response. */
interface GitHubUserProfile {
  login: string
  type?: string
  name?: string | null
  bio?: string | null
  location?: string | null
  company?: string | null
  followers?: number
  public_repos?: number
  created_at?: string
  /** Self-declared personal site, and the anchor a reciprocity check resolves — see
   * src/lib/identity/declared-links.ts. */
  blog?: string | null
  twitter_username?: string | null
}

interface GitHubSearchRepo {
  id: number
  name: string
  full_name: string
  description: string | null
  stargazers_count: number
  language: string | null
  topics: string[]
  open_issues_count: number
  watchers_count: number
  created_at: string
  updated_at: string
}

async function searchUsers(query: string, options: { country?: string; language?: string; token?: string; page?: number; perPage?: number } = {}): Promise<RawBuilder[]> {
  const { country, language, token, page = 1, perPage = 20 } = options
  const headers: HeadersInit = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'BuilderHunt/1.0',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }

  // Build query with qualifiers. GitHub supports `location:` and `language:` natively.
  const qualifiers: string[] = [`${query}`, 'type:user']
  if (country) qualifiers.push(`location:${country}`)
  if (language) qualifiers.push(`language:${language}`)
  const q = qualifiers.join('+')

  const res = await fetch(
    `https://api.github.com/search/users?q=${encodeURIComponent(q).replace(/%2B/g, '+')}&per_page=${perPage}&page=${page}`,
    { headers },
  )
  if (!res.ok) return []
  const data = await res.json() as { items: GitHubSearchUser[] }
  const profiles = await hydrateUsers(data.items.map((user) => user.login), headers)

  return data.items.map(user => {
    const profile = profiles.get(user.login.toLowerCase())
    return {
      id: `gh-${user.id}`,
      // An organization is not a person, and filing one as a person is how a company account ends up in a
      // candidate list — and, worse, how it becomes a `canonical_human`. GitHub says which it is; the
      // hydrated profile is authoritative, and the search response's own `type` is the fallback.
      kind: (profile?.type ?? user.type) === 'Organization' ? 'organization' as const : 'person' as const,
      source: 'github' as const,
      sourceId: String(user.id),
      username: user.login,
      displayName: profile?.name ?? undefined,
      avatarUrl: user.avatar_url,
      bio: profile?.bio ?? undefined,
      profileUrl: user.html_url,
      followersCount: profile?.followers,
      language: undefined,
      country: profile?.location ?? undefined,
      topics: [],
      metadata: {
        publicRepos: profile?.public_repos,
        createdAt: profile?.created_at,
        company: profile?.company ?? null,
        // The declared cross-links. Present only because of the hydration above — the search endpoint sends
        // neither.
        blog: profile?.blog ?? null,
        twitterUsername: profile?.twitter_username ?? null,
      },
    }
  })
}

/**
 * Fetches the full profile for each search hit.
 *
 * One request per user, because GitHub offers no batch endpoint for `/users/{login}` — the GraphQL API can
 * batch it, but that is a second auth path and a second query language for the same data, and this connector
 * already holds a REST token.
 *
 * Bounded three ways so a search can never turn into a rate-limit incident:
 *
 * - `MAX_HYDRATED_USERS` caps how many are hydrated per search, so a large `per_page` cannot multiply into
 *   hundreds of requests.
 * - Without a token GitHub allows 60 requests an hour against the whole API, which one search would exhaust.
 *   So hydration is **skipped entirely** when unauthenticated, and the caller gets the same sparse results as
 *   before rather than a search that works twice and then fails.
 * - A hydration failure is swallowed per user. The search result is still worth returning with fewer fields;
 *   losing the whole result set because one profile 404'd (a deleted account, a renamed org) would be worse.
 *
 * Requests go out in small concurrent batches rather than all at once: GitHub applies secondary rate limits
 * to bursts of concurrent requests, which are separate from the hourly budget and are not visible in
 * `/rate_limit`.
 */
const MAX_HYDRATED_USERS = 30
const HYDRATION_BATCH_SIZE = 6

async function hydrateUsers(logins: readonly string[], headers: HeadersInit): Promise<Map<string, GitHubUserProfile>> {
  const byLogin = new Map<string, GitHubUserProfile>()
  // The Authorization header is what buys the 5000/hour budget. Without it, hydrating even one page of
  // results would consume most of the unauthenticated allowance for the whole application.
  const authenticated = 'Authorization' in (headers as Record<string, string>)
  if (!authenticated || logins.length === 0) return byLogin

  const wanted = logins.slice(0, MAX_HYDRATED_USERS)
  for (let index = 0; index < wanted.length; index += HYDRATION_BATCH_SIZE) {
    const batch = wanted.slice(index, index + HYDRATION_BATCH_SIZE)
    const results = await Promise.all(batch.map(async (login) => {
      try {
        const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers })
        if (!res.ok) return null
        return await res.json() as GitHubUserProfile
      } catch {
        return null
      }
    }))
    for (const profile of results) {
      if (profile?.login) byLogin.set(profile.login.toLowerCase(), profile)
    }
  }
  return byLogin
}

async function searchRepos(query: string, options: { token?: string; page?: number; perPage?: number } = {}): Promise<RawBuilder[]> {
  const { token, page = 1, perPage = 20 } = options
  const headers: HeadersInit = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'BuilderHunt/1.0',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }

  const res = await fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=${perPage}&page=${page}`,
    { headers },
  )
  if (!res.ok) return []
  const data = await res.json() as { items: GitHubSearchRepo[] }

  return data.items.map(repo => ({
    id: `gh-repo-${repo.id}`,
    kind: 'repo' as const,
    source: 'github',
    sourceId: String(repo.id),
    username: repo.full_name,
    displayName: repo.name,
    avatarUrl: undefined,
    bio: repo.description ?? undefined,
    profileUrl: `https://github.com/${repo.full_name}`,
    followersCount: repo.stargazers_count,
    language: repo.language ?? undefined,
    country: undefined,
    topics: repo.topics,
    metadata: { stars: repo.stargazers_count, issues: repo.open_issues_count, watchers: repo.watchers_count },
  }))
}

export interface SearchGitHubOptions {
  country?: string
  language?: string
  page?: number
  perPage?: number
}

export async function searchGitHub(keywords: string[], options: SearchGitHubOptions = {}): Promise<RawBuilder[]> {
  const token = env.GITHUB_TOKEN
  const query = keywords.join(' ')
  if (!query) return []

  const [users, repos] = await Promise.all([
    searchUsers(query, { ...options, token }),
    searchRepos(query, { ...options, token }),
  ])
  return [...users, ...repos]
}