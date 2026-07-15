import { env } from '~/shared/lib/env'
import type { RawBuilder } from '~/lib/sources/github'

/**
 * GitLab source — the SaaS public instance (gitlab.com).
 *
 * API constraints (real, as of 2026):
 *   - `/api/v4/search?scope=users|projects` requires auth (401 unauth)
 *   - The free (unauth) API only allows listing + filtering public projects
 *     and looking up users by exact username (which rarely returns results)
 *
 * v1 strategy: fetch the top public projects ordered by star_count, filter
 * client-side by the query (matching name, path, description, topics),
 * and emit two entity types:
 *   - kind: 'repo'   → the project itself
 *   - kind: 'person' → the namespace owner (deduped across projects)
 *
 * Limitations documented in spec:
 *   - No follower count (GitLab API doesn't expose it)
 *   - "stars" on projects are exposed (unlike followers on users)
 *   - User search is impossible without a token
 *
 * Quota: 2000 req/h unauth, 6000/h with GITLAB_TOKEN.
 *
 * Spec reference: plans/gitlab-integration/spec.md
 */
interface GLProject {
  id: number
  name: string
  name_with_namespace: string
  path: string
  path_with_namespace: string
  description?: string
  star_count: number
  forks_count: number
  open_issues_count: number
  tag_list: string[]
  topics: string[]
  visibility: string
  web_url: string
  avatar_url?: string | null
  namespace: {
    id: number
    name: string
    path: string
    kind: 'user' | 'group'
    full_path: string
    avatar_url?: string | null
    web_url: string
  }
  created_at: string
  last_activity_at: string
}

const GL_BASE = 'https://gitlab.com/api/v4'
const GL_WEB = 'https://gitlab.com'

function authHeaders(): HeadersInit {
  if (env.GITLAB_TOKEN) {
    return { 'PRIVATE-TOKEN': env.GITLAB_TOKEN }
  }
  return {}
}

/** GitLab API returns relative avatar URLs; resolve to absolute. */
function absoluteAvatar(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  if (url.startsWith('/')) return `${GL_WEB}${url}`
  return url
}

async function fetchTopProjects(perPage: number): Promise<GLProject[]> {
  try {
    const url = `${GL_BASE}/projects?visibility=public&order_by=star_count&simple=false&per_page=${perPage}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'BuilderHunt/1.0 (gitlab source)', ...authHeaders() },
    })
    if (!res.ok) return []
    return (await res.json()) as GLProject[]
  } catch {
    return []
  }
}

function projectMatchesQuery(p: GLProject, terms: string[]): boolean {
  if (terms.length === 0) return true
  const haystack = [
    p.name.toLowerCase(),
    p.path.toLowerCase(),
    p.path_with_namespace.toLowerCase(),
    (p.description ?? '').toLowerCase(),
    (p.topics ?? []).join(' ').toLowerCase(),
    (p.tag_list ?? []).join(' ').toLowerCase(),
    p.namespace.path.toLowerCase(),
    p.namespace.name.toLowerCase(),
  ].join(' ')
  return terms.some((t) => haystack.includes(t))
}

function projectToRepoBuilder(p: GLProject): RawBuilder {
  const lastActivity = Date.parse(p.last_activity_at)
  return {
    id: `gl-${p.id}`,
    kind: 'repo' as const,
    source: 'gitlab' as const,
    sourceId: String(p.id),
    username: p.path_with_namespace,
    displayName: p.name,
    avatarUrl: absoluteAvatar(p.avatar_url) ?? absoluteAvatar(p.namespace.avatar_url),
    bio: p.description,
    profileUrl: p.web_url,
    followersCount: p.star_count,
    language: undefined,
    country: undefined,
    topics: (p.topics ?? p.tag_list ?? []).slice(0, 8),
    metadata: {
      stars: p.star_count,
      forks: p.forks_count,
      openIssues: p.open_issues_count,
      lastSeen: isNaN(lastActivity) ? Date.now() : lastActivity,
      namespacePath: p.namespace.path,
      ownerKind: p.namespace.kind,
    },
  }
}

interface OwnerAggregate {
  username: string
  displayName?: string
  avatarUrl?: string
  profileUrl: string
  projects: GLProject[]
  totalStars: number
  totalForks: number
  lastSeen: number
  allTopics: Set<string>
}

function aggregateOwner(p: GLProject, byName: Map<string, OwnerAggregate>): void {
  const owner = p.namespace
  if (owner.kind !== 'user') return // Skip groups for the "person" view
  const existing = byName.get(owner.path)
  const lastActivity = Date.parse(p.last_activity_at)
  const entry: OwnerAggregate =
    existing ??
    {
      username: owner.path,
      displayName: owner.name,
      avatarUrl: absoluteAvatar(owner.avatar_url),
      profileUrl: owner.web_url,
      projects: [],
      totalStars: 0,
      totalForks: 0,
      lastSeen: 0,
      allTopics: new Set(),
    }
  entry.projects.push(p)
  entry.totalStars += p.star_count
  entry.totalForks += p.forks_count
  if (!isNaN(lastActivity) && lastActivity > entry.lastSeen) entry.lastSeen = lastActivity
  for (const t of [...(p.topics ?? []), ...(p.tag_list ?? [])]) entry.allTopics.add(t)
  byName.set(owner.path, entry)
}

function ownerToPersonBuilder(o: OwnerAggregate): RawBuilder {
  const projectCount = o.projects.length
  const sample = o.projects.slice(0, 4).map((p) => p.name)
  const more = Math.max(0, projectCount - sample.length)
  const bio =
    projectCount === 1
      ? `Maintains ${o.projects[0].name} on GitLab`
      : `Maintains ${projectCount} public GitLab projects (${o.totalStars.toLocaleString()} total stars): ${sample.join(', ')}${more > 0 ? ` +${more}` : ''}`

  return {
    id: `gl-user-${o.username}`,
    kind: 'person' as const,
    source: 'gitlab' as const,
    sourceId: o.username,
    username: o.username,
    displayName: o.displayName ?? o.username,
    avatarUrl: o.avatarUrl,
    bio,
    profileUrl: o.profileUrl,
    // No followers on GitLab. Use total stars as a "their projects are valued" proxy.
    followersCount: o.totalStars,
    language: undefined,
    country: undefined,
    topics: Array.from(o.allTopics).slice(0, 10),
    metadata: {
      projectCount,
      totalStars: o.totalStars,
      totalForks: o.totalForks,
      lastSeen: o.lastSeen,
    },
  }
}

export interface SearchGitLabOptions {
  page?: number
  perPage?: number
}

export async function searchGitLab(
  keywords: string[],
  options: SearchGitLabOptions = {},
): Promise<RawBuilder[]> {
  const { page = 1, perPage = 30 } = options
  const terms = keywords.map((k) => k.toLowerCase()).filter(Boolean)
  if (terms.length === 0) return []

  // Fetch top 100 by stars. With this slice we have enough surface for
  // any reasonable query to match something.
  const all = await fetchTopProjects(100)
  if (all.length === 0) return []

  // Filter by query
  const matched = all.filter((p) => projectMatchesQuery(p, terms))
  if (matched.length === 0) return []

  // Build owners + repos
  const owners = new Map<string, OwnerAggregate>()
  for (const p of matched) aggregateOwner(p, owners)

  // Sort owners by total stars, then by projectCount
  const ownerList = Array.from(owners.values()).sort((a, b) => {
    if (b.totalStars !== a.totalStars) return b.totalStars - a.totalStars
    return b.projects.length - a.projects.length
  })

  // Sort projects by stars
  const sortedProjects = [...matched].sort((a, b) => b.star_count - a.star_count)

  // People first, then repos
  const all_results: RawBuilder[] = [
    ...ownerList.map(ownerToPersonBuilder),
    ...sortedProjects.map(projectToRepoBuilder),
  ]

  const start = (page - 1) * perPage
  return all_results.slice(start, start + perPage)
}
