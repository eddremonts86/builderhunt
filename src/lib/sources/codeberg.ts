import { env } from '~/shared/lib/env'
import type { RawBuilder } from '~/lib/sources/types'

/**
 * Codeberg (Gitea-compatible) source — EU-friendly, OSS-focused forge.
 *
 * The Codeberg API is Gitea-standard, which means the same code also
 * works for any self-hosted Gitea/Forgejo instance (configurable via
 * the env var, defaults to codeberg.org). Pattern is closest to GitHub
 * — proper user + repo search, full profile data, followers count.
 *
 * Spec reference: plans/phase-1/09-codeberg-integration/spec.md
 */
interface GiteaUser {
  id: number
  login: string
  login_name: string
  full_name: string
  email: string
  avatar_url: string
  html_url: string
  language: string
  is_admin: boolean
  last_login: string
  created: string
  restricted: boolean
  active: boolean
  prohibit_login: boolean
  location: string
  pronouns: string
  website: string
  description: string
  visibility: 'public' | 'private' | 'limited'
  followers_count: number
  following_count: number
  starred_repos_count: number
  username: string
}

interface GiteaRepo {
  id: number
  owner: GiteaUser
  name: string
  full_name: string
  description: string
  empty: boolean
  private: boolean
  fork: boolean
  template: boolean
  mirror: boolean
  size: number
  language: string
  html_url: string
  url: string
  stars_count: number
  forks_count: number
  watchers_count: number
  open_issues_count: number
  open_pr_counter: number
  release_counter: number
  default_branch: string
  archived: boolean
  created_at: string
  updated_at: string
  topics?: string[]
}

const CB_BASE = env.CODEBERG_API_URL?.replace(/\/$/, '') ?? 'https://codeberg.org/api/v1'

function authHeaders(): HeadersInit {
  if (env.CODEBERG_TOKEN) {
    return { Authorization: `token ${env.CODEBERG_TOKEN}` }
  }
  return {}
}

async function searchUsers(q: string, limit: number): Promise<GiteaUser[]> {
  try {
    const url = `${CB_BASE}/users/search?q=${encodeURIComponent(q)}&limit=${limit}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'BuilderHunt/1.0 (codeberg source)', ...authHeaders() },
    })
    if (!res.ok) return []
    const data = (await res.json()) as { data: GiteaUser[]; ok: boolean }
    return (data.data ?? []).filter((u) => !u.restricted && u.visibility === 'public')
  } catch {
    return []
  }
}

async function searchRepos(q: string, limit: number): Promise<GiteaRepo[]> {
  try {
    const url = `${CB_BASE}/repos/search?q=${encodeURIComponent(q)}&limit=${limit}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'BuilderHunt/1.0 (codeberg source)', ...authHeaders() },
    })
    if (!res.ok) return []
    const data = (await res.json()) as { data: GiteaRepo[]; ok: boolean }
    return (data.data ?? []).filter((r) => !r.private && !r.archived)
  } catch {
    return []
  }
}

function userToPersonBuilder(u: GiteaUser): RawBuilder {
  return {
    id: `cb-${u.id}`,
    kind: 'person' as const,
    source: 'codeberg' as const,
    sourceId: String(u.id),
    username: u.login,
    displayName: u.full_name || u.login,
    avatarUrl: u.avatar_url || undefined,
    bio: u.description || u.location || undefined,
    profileUrl: u.html_url,
    followersCount: u.followers_count,
    language: u.language || undefined,
    country: undefined,
    topics: [],
    metadata: {
      starredRepos: u.starred_repos_count,
      following: u.following_count,
      website: u.website || null,
      createdAt: u.created,
    },
  }
}

function repoToRepoBuilder(r: GiteaRepo): RawBuilder {
  return {
    id: `cb-repo-${r.id}`,
    kind: 'repo' as const,
    source: 'codeberg' as const,
    sourceId: String(r.id),
    username: r.full_name,
    displayName: r.name,
    avatarUrl: r.owner.avatar_url || undefined,
    bio: r.description || undefined,
    profileUrl: r.html_url,
    followersCount: r.stars_count,
    language: r.language || undefined,
    country: undefined,
    topics: r.topics ?? [],
    metadata: {
      stars: r.stars_count,
      forks: r.forks_count,
      openIssues: r.open_issues_count,
      watchers: r.watchers_count,
      lastSeen: Date.parse(r.updated_at) || Date.now(),
      ownerLogin: r.owner.login,
    },
  }
}

export interface SearchCodebergOptions {
  page?: number
  perPage?: number
}

export async function searchCodeberg(
  keywords: string[],
  options: SearchCodebergOptions = {},
): Promise<RawBuilder[]> {
  const { page = 1, perPage = 30 } = options
  const query = keywords.join(' ')
  if (!query) return []

  // Codeberg supports real search (unlike GitLab unauth). Run user + repo
  // search in parallel. Per-page applies to the combined output.
  const limit = 20
  const [users, repos] = await Promise.all([
    searchUsers(query, limit),
    searchRepos(query, limit),
  ])

  const all: RawBuilder[] = [
    ...users.map(userToPersonBuilder),
    ...repos.map(repoToRepoBuilder),
  ]

  const start = (page - 1) * perPage
  return all.slice(start, start + perPage)
}
