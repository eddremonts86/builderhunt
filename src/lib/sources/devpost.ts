import type { RawBuilder } from '~/lib/sources/types'
import { searchDevpostProfiles } from '~/shared/lib/repositories/devpost-profiles'

/**
 * Devpost source — reads the durable `devpost_profiles` store, never scrapes
 * live (Devpost has no API and bot-challenges plain server-side fetch). Data
 * is populated by src/lib/devpost/worker.ts on a cron cadence; see
 * plans/phase-1/devpost-integration/spec.md. Degrades to `[]` like every
 * other connector if the query has no matches or the DB read fails.
 */
function profileToBuilder(row: {
  username: string
  displayName: string | null
  avatarUrl: string | null
  bio: string | null
  profileUrl: string
  projectsCount: number
  topics: string[]
  lastSeenAt: Date
}): RawBuilder {
  return {
    id: `devpost-${row.username}`,
    kind: 'person',
    source: 'devpost',
    sourceId: row.username,
    username: row.username,
    displayName: row.displayName ?? row.username,
    avatarUrl: row.avatarUrl ?? undefined,
    bio: row.bio ?? undefined,
    profileUrl: row.profileUrl,
    // Devpost exposes no follower count — do not fake it with project count.
    followersCount: undefined,
    language: undefined,
    country: undefined,
    topics: row.topics,
    metadata: {
      projectsCount: row.projectsCount,
      lastSeen: row.lastSeenAt.getTime(),
    },
  }
}

export interface SearchDevpostOptions {
  page?: number
  perPage?: number
}

export async function searchDevpost(
  keywords: string[],
  options: SearchDevpostOptions = {},
): Promise<RawBuilder[]> {
  const { page = 1, perPage = 30 } = options
  const query = keywords.join(' ').trim()
  if (!query) return []

  try {
    const rows = await searchDevpostProfiles(query, perPage * page)
    const start = (page - 1) * perPage
    return rows.slice(start, start + perPage).map(profileToBuilder)
  } catch {
    return []
  }
}
