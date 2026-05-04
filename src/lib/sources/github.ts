import { env } from '~/shared/lib/env'

export interface RawBuilder {
  id: string
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

async function searchUsers(query: string, token?: string): Promise<RawBuilder[]> {
  const headers: HeadersInit = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'BuilderHunt/1.0',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }

  const res = await fetch(
    `https://api.github.com/search/users?q=${encodeURIComponent(query)}+type:user&per_page=20`,
    { headers },
  )
  if (!res.ok) return []
  const data = await res.json() as { items: GitHubSearchUser[] }

  return data.items.map(user => ({
    id: `gh-${user.id}`,
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

async function searchRepos(query: string, token?: string): Promise<RawBuilder[]> {
  const headers: HeadersInit = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'BuilderHunt/1.0',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }

  const res = await fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=20`,
    { headers },
  )
  if (!res.ok) return []
  const data = await res.json() as { items: GitHubSearchRepo[] }

  return data.items.map(repo => ({
    id: `gh-repo-${repo.id}`,
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
    metadata: { stars: repo.stargazers_count, issues: repo.open_issues_count },
  }))
}

export async function searchGitHub(keywords: string[]): Promise<RawBuilder[]> {
  const token = env.GITHUB_TOKEN
  const query = keywords.join(' ')
  if (!query) return []

  const [users, repos] = await Promise.all([searchUsers(query, token), searchRepos(query, token)])
  return [...users, ...repos]
}