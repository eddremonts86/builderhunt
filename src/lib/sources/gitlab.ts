import { env } from '~/shared/lib/env'
import type { RawBuilder } from '~/lib/sources/types'

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
 * Spec reference: plans/implemented/09-gitlab-integration/spec.md
 */
/** Shape of `GET /api/v4/search?scope=users` — a lean directory match, not a full user profile
 * (no bio, no followers — GitLab doesn't expose follower counts on any endpoint). */
interface GLUserSearchResult {
  id: number
  username: string
  name: string
  avatar_url?: string | null
  web_url: string
}

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

/**
 * How long one star-sampling page may take before it is abandoned.
 *
 * `/projects?order_by=star_count&per_page=100&simple=false` is the slowest thing this connector does
 * by an order of magnitude — measured 2026-08-05 against gitlab.com: 3.9 s, 4.0 s, 4.3 s, 5.9 s and
 * **7.2 s** for the five pages, while `search?scope=users` answered in 0.4 s and
 * `search?scope=projects` in 2.4 s. The pages run concurrently, so the slowest one sets the
 * connector's duration, and `CONNECTOR_TIMEOUT_MS` is 8 s — which is why GitLab intermittently
 * reported `timeout, 0 results` and contributed nothing at all to a search.
 *
 * Abandoning a slow page costs a slice of the star sample and keeps the four that answered plus both
 * authenticated searches. Letting it run costs the entire source. The budget sits under the
 * connector's own so the failure is attributable here rather than surfacing as a whole-source
 * timeout — deliberately not imported from `~/lib/search`, which would make this module reach back
 * into its caller.
 */
const PROJECT_PAGE_TIMEOUT_MS = 4000

async function fetchProjectsPage(page: number, perPage: number): Promise<GLProject[]> {
  try {
    const url = `${GL_BASE}/projects?visibility=public&order_by=star_count&simple=false&per_page=${perPage}&page=${page}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'BuilderHunt/1.0 (gitlab source)', ...authHeaders() },
      // A real abort, not a race: the socket is closed, so a slow page stops consuming GitLab's
      // rate budget as well as ours.
      signal: AbortSignal.timeout(PROJECT_PAGE_TIMEOUT_MS),
    })
    if (!res.ok) return []
    return (await res.json()) as GLProject[]
  } catch {
    // Includes the abort. A missing page is a smaller sample, never a failed search.
    return []
  }
}

/**
 * Authenticated search (`GITLAB_TOKEN` set only) — `/api/v4/search` (401 unauthenticated, see
 * this file's header) genuinely searches GitLab's user/project directory by query, unlike the
 * tokenless top-500-starred sampling above. Returns `[]` on any error or when no token is
 * configured, so callers can always call these unconditionally.
 */
async function fetchUserSearchResults(query: string, perPage: number): Promise<GLUserSearchResult[]> {
  if (!env.GITLAB_TOKEN) return []
  try {
    const url = `${GL_BASE}/search?scope=users&search=${encodeURIComponent(query)}&per_page=${perPage}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'BuilderHunt/1.0 (gitlab source)', ...authHeaders() },
    })
    if (!res.ok) return []
    return (await res.json()) as GLUserSearchResult[]
  } catch {
    return []
  }
}

async function fetchProjectSearchResults(query: string, perPage: number): Promise<GLProject[]> {
  if (!env.GITLAB_TOKEN) return []
  try {
    const url = `${GL_BASE}/search?scope=projects&search=${encodeURIComponent(query)}&per_page=${perPage}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'BuilderHunt/1.0 (gitlab source)', ...authHeaders() },
    })
    if (!res.ok) return []
    return (await res.json()) as GLProject[]
  } catch {
    return []
  }
}

function userSearchResultToPersonBuilder(u: GLUserSearchResult): RawBuilder {
  return {
    id: `gl-user-${u.username}`,
    kind: 'person' as const,
    source: 'gitlab' as const,
    sourceId: u.username,
    username: u.username,
    displayName: u.name || u.username,
    avatarUrl: absoluteAvatar(u.avatar_url),
    bio: undefined,
    profileUrl: u.web_url,
    // GitLab exposes no follower count anywhere — score falls back to recency/quality, same as
    // the tokenless owner-aggregation path, just without a stars proxy since this user may own
    // no public projects at all.
    followersCount: undefined,
    language: undefined,
    country: undefined,
    topics: [],
    metadata: { matchedVia: 'authenticated-user-search' },
  }
}

/**
 * GitLab's own top-starred projects rarely mention common stack keywords
 * (most high-star React/Rust/etc projects live on GitHub, not GitLab), so
 * a single page of 100 misses most queries. Pull a few pages (still well
 * within the 2000 req/h unauth quota) to give queries real surface to
 * match against.
 */
async function fetchTopProjects(totalWanted: number): Promise<GLProject[]> {
  const perPage = 100
  const pages = Math.max(1, Math.ceil(totalWanted / perPage))
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) => fetchProjectsPage(i + 1, perPage)),
  )
  return results.flat()
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
  const query = keywords.join(' ')

  // With GITLAB_TOKEN set, also run a real, precise directory search alongside the tokenless
  // top-500-starred sampling below — these two return [] instantly when no token is configured,
  // so the tokenless path is entirely unaffected.
  const [all, tokenUsers, tokenProjects] = await Promise.all([
    fetchTopProjects(500),
    fetchUserSearchResults(query, 20),
    fetchProjectSearchResults(query, 20),
  ])

  // Filter the star-sampled set by query (the token-search results are already query-matched by
  // GitLab itself, so this filter only applies to the tokenless sampling path).
  const matched = all.filter((p) => projectMatchesQuery(p, terms))

  // Build owners + repos from the star-sampled, query-matched set.
  const owners = new Map<string, OwnerAggregate>()
  for (const p of matched) aggregateOwner(p, owners)

  // Sort owners by total stars, then by projectCount
  const ownerList = Array.from(owners.values()).sort((a, b) => {
    if (b.totalStars !== a.totalStars) return b.totalStars - a.totalStars
    return b.projects.length - a.projects.length
  })

  // Sort projects by stars
  const sortedProjects = [...matched].sort((a, b) => b.star_count - a.star_count)

  // Token-search results come first (a real, precise directory match beats a star-sampled
  // guess), then the tokenless owner/project sampling — deduped by id so a person who both
  // matches the directory search and owns a top-500-starred project isn't shown twice.
  const seen = new Set<string>()
  function dedupe(builders: RawBuilder[]): RawBuilder[] {
    return builders.filter((b) => {
      if (seen.has(b.id)) return false
      seen.add(b.id)
      return true
    })
  }

  const all_results: RawBuilder[] = [
    ...dedupe(tokenUsers.map(userSearchResultToPersonBuilder)),
    ...dedupe(ownerList.map(ownerToPersonBuilder)),
    ...dedupe(tokenProjects.map(projectToRepoBuilder)),
    ...dedupe(sortedProjects.map(projectToRepoBuilder)),
  ]
  if (all_results.length === 0) return []

  const start = (page - 1) * perPage
  return all_results.slice(start, start + perPage)
}
