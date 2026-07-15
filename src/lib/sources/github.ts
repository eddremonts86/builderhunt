import { env } from '~/shared/lib/env'

export type BuilderKind = 'person' | 'repo'

export interface RawBuilder {
  id: string
  kind: BuilderKind
  source: 'github'
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

interface GitHubSearchUser {
  login: string
  id: number
  avatar_url: string
  html_url: string
  name?: string
  bio?: string
  followers: number
  location?: string
  public_repos: number
  created_at: string
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

  return data.items.map(user => ({
    id: `gh-${user.id}`,
    kind: 'person' as const,
    source: 'github',
    sourceId: String(user.id),
    username: user.login,
    displayName: user.name ?? undefined,
    avatarUrl: user.avatar_url,
    bio: user.bio ?? undefined,
    profileUrl: user.html_url,
    followersCount: user.followers,
    language: undefined,
    country: user.location ?? undefined,
    topics: [],
    metadata: { publicRepos: user.public_repos, createdAt: user.created_at },
  }))
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