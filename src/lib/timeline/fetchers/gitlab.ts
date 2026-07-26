import { env } from '~/shared/lib/env'
import type { TimelineEvent } from '~/lib/timeline/types'

interface GitlabPushData {
  commit_count?: number
  ref?: string
  commit_title?: string
}

interface GitlabRawEvent {
  id: number
  project_id: number
  action_name: string
  target_type?: string | null
  target_title?: string | null
  target_iid?: number | null
  created_at: string
  push_data?: GitlabPushData | null
}

/**
 * Pure mapper: one raw GitLab event + its project's already-resolved web
 * URL -> one timeline event, or `null` for actions we don't surface (Issue/
 * Note activity, etc. — the spec scopes GitLab to pushed/created/merged).
 * `projectUrl` is resolved separately (see `fetchGitlabEvents`) since the
 * events API itself never includes a project's path, only its numeric id.
 */
export function mapGitlabEvent(raw: GitlabRawEvent, projectUrl: string | null): TimelineEvent | null {
  if (!projectUrl) return null

  if (raw.push_data && (raw.action_name === 'pushed to' || raw.action_name === 'pushed new')) {
    const count = raw.push_data.commit_count ?? 0
    if (count <= 0) return null
    return {
      id: `gitlab:${raw.id}`,
      type: 'repo',
      source: 'gitlab',
      title: `Pushed ${count} commit${count === 1 ? '' : 's'} to ${projectUrl.split('/').slice(-2).join('/')}`,
      description: raw.push_data.commit_title ?? undefined,
      url: projectUrl,
      timestamp: raw.created_at,
    }
  }

  if (raw.action_name === 'created' && !raw.target_type) {
    return {
      id: `gitlab:${raw.id}`,
      type: 'repo',
      source: 'gitlab',
      title: `Created ${projectUrl.split('/').slice(-2).join('/')}`,
      url: projectUrl,
      timestamp: raw.created_at,
    }
  }

  if (raw.target_type === 'MergeRequest' && (raw.action_name === 'opened' || raw.action_name === 'accepted')) {
    const url = raw.target_iid ? `${projectUrl}/-/merge_requests/${raw.target_iid}` : projectUrl
    return {
      id: `gitlab:${raw.id}`,
      type: 'pr',
      source: 'gitlab',
      title: `${raw.action_name === 'accepted' ? 'Merged' : 'Opened'} MR: ${raw.target_title ?? ''}`.trim(),
      url,
      timestamp: raw.created_at,
    }
  }

  return null
}

async function resolveProjectUrls(projectIds: number[], headers: Record<string, string>): Promise<Map<number, string>> {
  const unique = Array.from(new Set(projectIds)).slice(0, 20)
  const entries = await Promise.all(unique.map(async (id): Promise<[number, string] | null> => {
    try {
      const res = await fetch(`https://gitlab.com/api/v4/projects/${id}`, { headers, signal: AbortSignal.timeout(5000) })
      if (!res.ok) return null
      const data = (await res.json()) as { web_url?: string }
      return data.web_url ? [id, data.web_url] : null
    } catch {
      return null
    }
  }))
  return new Map(entries.filter((e): e is [number, string] => e !== null))
}

export async function fetchGitlabEvents({ sourceId }: { sourceId: string }): Promise<TimelineEvent[]> {
  try {
    const headers: Record<string, string> = { 'User-Agent': 'BuilderHunt/1.0' }
    if (env.GITLAB_TOKEN) headers['PRIVATE-TOKEN'] = env.GITLAB_TOKEN

    const url = new URL(`https://gitlab.com/api/v4/users/${encodeURIComponent(sourceId)}/events`)
    url.searchParams.set('per_page', '30')

    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(5000) })
    if (!res.ok) return []

    const raw = (await res.json()) as GitlabRawEvent[]
    if (!Array.isArray(raw)) return []

    const projectUrls = await resolveProjectUrls(raw.map((e) => e.project_id), headers)

    const events: TimelineEvent[] = []
    for (const item of raw) {
      const mapped = mapGitlabEvent(item, projectUrls.get(item.project_id) ?? null)
      if (mapped) events.push(mapped)
    }
    return events
  } catch {
    return []
  }
}
