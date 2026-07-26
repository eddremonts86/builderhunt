import { env } from '~/shared/lib/env'
import type { TimelineEvent } from '~/lib/timeline/types'

interface GithubRepoRef {
  name: string
  url: string
}

interface GithubRawEvent {
  id: string
  type: string
  repo: GithubRepoRef
  created_at: string
  payload: Record<string, unknown>
}

function repoHtmlUrl(repo: GithubRepoRef): string {
  return `https://github.com/${repo.name}`
}

/**
 * Pure mapper: one raw GitHub public event -> one timeline event, or `null`
 * for event types we don't surface (WatchEvent, ForkEvent, IssueCommentEvent,
 * etc. — noisy relative to the four kinds the spec calls out).
 */
export function mapGithubEvent(raw: GithubRawEvent): TimelineEvent | null {
  const repoUrl = repoHtmlUrl(raw.repo)

  if (raw.type === 'PushEvent') {
    const commits = raw.payload.commits as Array<{ message?: string }> | undefined
    const size = typeof raw.payload.size === 'number' ? raw.payload.size : (commits?.length ?? 0)
    if (size <= 0) return null
    return {
      id: `github:${raw.id}`,
      type: 'repo',
      source: 'github',
      title: `Pushed ${size} commit${size === 1 ? '' : 's'} to ${raw.repo.name}`,
      description: commits?.[0]?.message,
      url: repoUrl,
      timestamp: raw.created_at,
    }
  }

  if (raw.type === 'CreateEvent' && raw.payload.ref_type === 'repository') {
    return {
      id: `github:${raw.id}`,
      type: 'repo',
      source: 'github',
      title: `Created ${raw.repo.name}`,
      url: repoUrl,
      timestamp: raw.created_at,
    }
  }

  if (raw.type === 'ReleaseEvent') {
    const release = raw.payload.release as { tag_name?: string; html_url?: string; name?: string; body?: string } | undefined
    if (!release) return null
    return {
      id: `github:${raw.id}`,
      type: 'release',
      source: 'github',
      title: `Released ${release.name || release.tag_name || ''} — ${raw.repo.name}`.trim(),
      description: release.body ?? undefined,
      url: release.html_url ?? repoUrl,
      timestamp: raw.created_at,
    }
  }

  if (raw.type === 'PullRequestEvent' && raw.payload.action === 'opened') {
    const pr = raw.payload.pull_request as { number?: number; title?: string; html_url?: string; body?: string } | undefined
    if (!pr) return null
    // GitHub's public events feed sends a stripped-down `pull_request` object
    // (verified live: only url/id/number/head/base — never `title` or
    // `html_url`, unlike the full Pull Requests API used elsewhere in this
    // codebase). Build both from `number` + the repo name instead of trusting
    // fields that in practice are never present, so every PR event gets a
    // real, PR-specific link rather than silently falling back to the repo.
    const number = pr.number ?? raw.payload.number as number | undefined
    return {
      id: `github:${raw.id}`,
      type: 'pr',
      source: 'github',
      title: pr.title ? `Opened PR: ${pr.title}` : `Opened PR #${number ?? '?'} in ${raw.repo.name}`,
      description: pr.body ?? undefined,
      url: pr.html_url ?? (number ? `${repoUrl}/pull/${number}` : repoUrl),
      timestamp: raw.created_at,
    }
  }

  return null
}

/**
 * `username` for a `kind: 'repo'` tracked row is `owner/name`, not a user —
 * GitHub's per-user events endpoint doesn't apply, and a per-repo timeline
 * is a different endpoint entirely (Future). Bail early rather than 404.
 */
export async function fetchGithubEvents({ username }: { username: string }): Promise<TimelineEvent[]> {
  if (username.includes('/')) return []

  try {
    const headers: Record<string, string> = {
      'User-Agent': 'BuilderHunt/1.0',
      Accept: 'application/vnd.github+json',
    }
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`

    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}/events/public`, {
      headers,
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return []

    const raw = (await res.json()) as GithubRawEvent[]
    if (!Array.isArray(raw)) return []

    const events: TimelineEvent[] = []
    for (const item of raw) {
      const mapped = mapGithubEvent(item)
      if (mapped) events.push(mapped)
    }
    return events
  } catch {
    return []
  }
}
