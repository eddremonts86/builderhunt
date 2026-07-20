// Pure result/snapshot helpers for the ai-sourcing-sprints plan. No I/O —
// consumed by both the worker (src/lib/sprints/worker.ts) and the results
// API route for sorting/filtering/faceting persisted sprint results.
import { trackedKey } from '~/shared/lib/tracked-builders'
import type { ScoredBuilder } from '~/lib/search'
import type { SprintFilter, SprintProfileSnapshot } from '~/shared/lib/sprints-shared'

/** Strips a federated search hit down to the public snapshot shape stored
 * in `sprint_results.profile` — no private/tenant fields ever persisted. */
export function toSprintProfileSnapshot(builder: ScoredBuilder): SprintProfileSnapshot {
  return {
    username: builder.username,
    ...(builder.displayName ? { displayName: builder.displayName } : {}),
    ...(builder.avatarUrl ? { avatarUrl: builder.avatarUrl } : {}),
    ...(builder.bio ? { bio: builder.bio } : {}),
    profileUrl: builder.profileUrl,
    ...(builder.followersCount != null ? { followersCount: builder.followersCount } : {}),
    ...(builder.language ? { language: builder.language } : {}),
    ...(builder.country ? { country: builder.country } : {}),
    topics: builder.topics,
  }
}

export interface QuotaClipResult<T> {
  kept: T[]
  clipped: number
}

/** Clips a batch of new items to whatever remains of a sprint's quota. */
export function clipToQuota<T>(items: T[], currentCount: number, quota: number): QuotaClipResult<T> {
  const remaining = Math.max(0, quota - currentCount)
  return { kept: items.slice(0, remaining), clipped: Math.max(0, items.length - remaining) }
}

export interface LocationFacet {
  location: string
  count: number
}

/** Groups by the raw, unnormalized `country` string; missing/blank values
 * bucket into an explicit "Unknown" facet rather than being dropped. */
export function computeLocationFacets(profiles: Array<{ country?: string }>): LocationFacet[] {
  const counts = new Map<string, number>()
  for (const profile of profiles) {
    const key = profile.country?.trim() || 'Unknown'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([location, count]) => ({ location, count }))
    .sort((a, b) => b.count - a.count || a.location.localeCompare(b.location))
}

export interface SprintResultRow {
  id: string
  source: string
  sourceId: string
  profile: SprintProfileSnapshot
  matchedVariant: string
  score: number
  createdAt: string
}

export type SprintResultSort = 'score' | 'date'

export function sortSprintResults(rows: SprintResultRow[], sort: SprintResultSort): SprintResultRow[] {
  const copy = [...rows]
  if (sort === 'score') {
    copy.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt))
  } else {
    copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  return copy
}

export function filterSprintResults(rows: SprintResultRow[], filter: SprintFilter): SprintResultRow[] {
  return rows.filter((row) => {
    if (filter.keywords.length > 0) {
      const haystack = `${row.profile.bio ?? ''} ${row.profile.topics.join(' ')}`.toLowerCase()
      const matchesAny = filter.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))
      if (!matchesAny) return false
    }
    if (filter.sources && filter.sources.length > 0 && !filter.sources.includes(row.source as (typeof filter.sources)[number])) {
      return false
    }
    if (filter.country && (row.profile.country ?? '').toLowerCase() !== filter.country.toLowerCase()) return false
    if (filter.minFollowers != null && (row.profile.followersCount ?? 0) < filter.minFollowers) return false
    return true
  })
}

export interface TrackedSprintResultRow extends SprintResultRow {
  tracked: boolean
}

/** Annotates rows with the viewer's tracked state, same `trackedKey`
 * convention used by `/api/search/builders` — never persisted per-row. */
export function annotateTrackedResults(rows: SprintResultRow[], trackedKeySet: Set<string>): TrackedSprintResultRow[] {
  return rows.map((row) => ({ ...row, tracked: trackedKeySet.has(trackedKey(row.source, row.sourceId)) }))
}
