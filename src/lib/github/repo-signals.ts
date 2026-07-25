import { env } from '~/shared/lib/env'
import type { RepoSignals } from '~/shared/lib/hygiene'

/**
 * Real GitHub-derived project hygiene signals (plan: project-hygiene, Phase 2).
 * `estimateRepoSignalsFromBuilder` in `~/shared/lib/hygiene` stays as the
 * deterministic fallback for non-GitHub builders / missing token / errors;
 * this module is the real fetcher behind it for GitHub builders.
 */

export class GitHubTokenMissingError extends Error {
  constructor() {
    super('GITHUB_TOKEN is not configured')
    this.name = 'GitHubTokenMissingError'
  }
}

export class GitHubRateLimitedError extends Error {
  constructor() {
    super('GitHub API rate limit exceeded')
    this.name = 'GitHubRateLimitedError'
  }
}

interface GhRepo {
  name: string
  full_name: string
  fork: boolean
  size: number
  stargazers_count: number
  pushed_at: string
}

interface GhIssue {
  pull_request?: unknown
  state: 'open' | 'closed'
  created_at: string
  closed_at: string | null
}

interface GhContentEntry {
  name: string
}

const GITHUB_API = 'https://api.github.com'
const MAX_REPOS = 5

function authHeaders(): Record<string, string> {
  if (!env.GITHUB_TOKEN) throw new GitHubTokenMissingError()
  return {
    Accept: 'application/vnd.github.v3+json',
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'User-Agent': 'BuilderHunt/1.0 (project-hygiene)',
  }
}

async function ghFetch(path: string): Promise<Response> {
  const res = await fetch(`${GITHUB_API}${path}`, { headers: authHeaders() })
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining')
    if (remaining === '0') throw new GitHubRateLimitedError()
  }
  return res
}

/**
 * Filters out pull requests (GitHub's issues endpoint includes them,
 * distinguished by the presence of a `pull_request` key), computes
 * open/closed counts and the average days-to-close across closed issues.
 * Pure — fixture-tested.
 */
export function issuesToSignals(issuesPayload: GhIssue[]): { openIssues: number; closedIssues: number; averageCloseDays: number } {
  const issuesOnly = issuesPayload.filter((i) => !i.pull_request)
  const open = issuesOnly.filter((i) => i.state === 'open').length
  const closed = issuesOnly.filter((i) => i.state === 'closed' && i.closed_at)

  const totalDays = closed.reduce((sum, i) => {
    const created = Date.parse(i.created_at)
    const closedAt = Date.parse(i.closed_at as string)
    if (isNaN(created) || isNaN(closedAt)) return sum
    return sum + Math.max(0, (closedAt - created) / (1000 * 60 * 60 * 24))
  }, 0)
  const averageCloseDays = closed.length === 0 ? 0 : Math.round(totalDays / closed.length)

  return { openIssues: open, closedIssues: closed.length, averageCloseDays }
}

/**
 * Case-insensitive README/CONTRIBUTING/LICENSE detection from a repo's root
 * directory listing. Pure — fixture-tested.
 */
export function docsFromRootListing(entries: GhContentEntry[]): { hasReadme: boolean; hasContributing: boolean; hasLicense: boolean } {
  const names = entries.map((e) => e.name.toLowerCase())
  const startsWith = (prefix: string) => names.some((n) => n.startsWith(prefix))
  return {
    hasReadme: startsWith('readme'),
    hasContributing: startsWith('contributing'),
    hasLicense: startsWith('license') || startsWith('licence'),
  }
}

/** Non-fork, non-empty repos, top `MAX_REPOS` by stars. Pure — fixture-tested. */
export function selectReposForSignals(repos: GhRepo[]): GhRepo[] {
  return repos
    .filter((r) => !r.fork && r.size > 0)
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, MAX_REPOS)
}

async function fetchWorkflowsExist(fullName: string): Promise<boolean> {
  const res = await ghFetch(`/repos/${fullName}/contents/.github/workflows`)
  return res.ok
}

/**
 * Fetches real per-repo hygiene signals for a GitHub username: repo list →
 * top 5 non-fork repos by stars → per repo: issues (state=all), root
 * listing, workflow existence. At most 1 + 5*3 = 16 requests total.
 * Throws `GitHubTokenMissingError`/`GitHubRateLimitedError` on those
 * specific conditions; other failures propagate to the caller.
 */
export async function fetchRepoSignals(username: string): Promise<RepoSignals[]> {
  const reposRes = await ghFetch(`/users/${encodeURIComponent(username)}/repos?per_page=100&sort=pushed`)
  if (!reposRes.ok) return []
  const allRepos = (await reposRes.json()) as GhRepo[]
  const selected = selectReposForSignals(allRepos)

  const results: RepoSignals[] = []
  for (const repo of selected) {
    const [issuesRes, contentsRes, hasWorkflows] = await Promise.all([
      ghFetch(`/repos/${repo.full_name}/issues?state=all&per_page=100`),
      ghFetch(`/repos/${repo.full_name}/contents/`),
      fetchWorkflowsExist(repo.full_name),
    ])
    const issues = issuesRes.ok ? ((await issuesRes.json()) as GhIssue[]) : []
    const contents = contentsRes.ok ? ((await contentsRes.json()) as GhContentEntry[]) : []

    const { openIssues, closedIssues, averageCloseDays } = issuesToSignals(issues)
    const { hasReadme, hasContributing, hasLicense } = docsFromRootListing(contents)

    results.push({
      name: repo.name,
      stars: repo.stargazers_count,
      openIssues,
      closedIssues,
      hasReadme,
      hasContributing,
      hasLicense,
      hasWorkflows,
      averageCloseDays,
      pushedAt: Date.parse(repo.pushed_at) || Date.now(),
    })
  }
  return results
}
