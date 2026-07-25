import { desc, ilike, or, sql } from 'drizzle-orm'
import { publicDb } from '../db/client'
import { devpostIngestionState, devpostProfiles } from '../db/schema'
import { eq } from 'drizzle-orm'

export interface DevpostProfileUpsert {
  username: string
  displayName?: string | null
  avatarUrl?: string | null
  bio?: string | null
  profileUrl: string
  projectsCount: number
  /** The discovery keyword(s) that surfaced this profile this run (see schema.ts's `topics` comment). */
  topics: string[]
}

/** Keyed by Devpost username (globally unique on Devpost, so it's both `id` and `username`). */
export async function upsertDevpostProfile(input: DevpostProfileUpsert): Promise<void> {
  const [existing] = await publicDb.select({ topics: devpostProfiles.topics })
    .from(devpostProfiles).where(eq(devpostProfiles.id, input.username)).limit(1)
  const topics = [...new Set([...(existing?.topics ?? []), ...input.topics])]

  await publicDb.insert(devpostProfiles).values({
    id: input.username,
    username: input.username,
    displayName: input.displayName ?? null,
    avatarUrl: input.avatarUrl ?? null,
    bio: input.bio ?? null,
    profileUrl: input.profileUrl,
    projectsCount: input.projectsCount,
    topics,
  }).onConflictDoUpdate({
    target: devpostProfiles.id,
    set: {
      displayName: input.displayName ?? null,
      avatarUrl: input.avatarUrl ?? null,
      bio: input.bio ?? null,
      profileUrl: input.profileUrl,
      projectsCount: input.projectsCount,
      topics,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    },
  })
}

/**
 * Read-only: the `devpost` source connector's only access to scraped data —
 * never scrapes live. Matches `topics` (the hackathon project keyword that
 * surfaced this profile) alongside username/displayName/bio, since Devpost
 * bios are frequently empty (verified live) and rarely restate the project's
 * own topic.
 */
export async function searchDevpostProfiles(keyword: string, limit: number) {
  const pattern = `%${keyword}%`
  return publicDb.select().from(devpostProfiles)
    .where(or(
      ilike(devpostProfiles.username, pattern),
      ilike(devpostProfiles.displayName, pattern),
      ilike(devpostProfiles.bio, pattern),
      sql`${devpostProfiles.topics}::text ilike ${pattern}`,
    ))
    .orderBy(desc(devpostProfiles.projectsCount))
    .limit(limit)
}

const STATE_ID = 'default'

export interface DevpostIngestionStateRow {
  id: string
  keywordIndex: number
  page: number
  lastRunAt: Date | null
  stats: { runs: number; projectsSeen: number; profilesUpserted: number; errors: number }
}

export async function loadDevpostIngestionState(): Promise<DevpostIngestionStateRow> {
  const [row] = await publicDb.select().from(devpostIngestionState).where(eq(devpostIngestionState.id, STATE_ID)).limit(1)
  if (row) return row as DevpostIngestionStateRow
  const initial: DevpostIngestionStateRow = {
    id: STATE_ID,
    keywordIndex: 0,
    page: 1,
    lastRunAt: null,
    stats: { runs: 0, projectsSeen: 0, profilesUpserted: 0, errors: 0 },
  }
  await publicDb.insert(devpostIngestionState).values(initial).onConflictDoNothing()
  return initial
}

export async function saveDevpostIngestionState(state: DevpostIngestionStateRow): Promise<void> {
  await publicDb.update(devpostIngestionState)
    .set({ keywordIndex: state.keywordIndex, page: state.page, lastRunAt: new Date(), stats: state.stats })
    .where(eq(devpostIngestionState.id, STATE_ID))
}
