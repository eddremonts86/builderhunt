import type { RawBuilder } from '~/lib/sources/types'

/**
 * Devpost source — reads the durable `devpost_profiles` store, never scrapes
 * live (Devpost has no API and bot-challenges plain server-side fetch). Data
 * is populated by src/lib/devpost/worker.ts on a cron cadence; see
 * plans/phase-1/devpost-integration/spec.md. Degrades to `[]` like every
 * other connector if the query has no matches or the DB read fails.
 *
 * `searchDevpostProfiles` is imported dynamically inside `searchDevpost`,
 * not statically at the top of this file: this module is reachable from
 * several `src/routes/api/**` route files via `~/lib/search`'s connector
 * fan-out, and those route modules are pulled into the **client** bundle too
 * (TanStack Start's generated route tree needs every route client-side for
 * navigation, even ones whose only client-relevant export is `component:
 * () => null`). `devpost-profiles.ts` imports `publicDb`, which eagerly
 * constructs a real `postgres()` client at module-evaluation time — and the
 * `postgres` package's own internals reference the Node-only `Buffer`
 * global, so merely *importing* this chain (never mind calling it) crashed
 * with `ReferenceError: Buffer is not defined` the moment the browser
 * evaluated that chunk, silently breaking hydration for the entire app (no
 * console error surfaces through normal means for this — it only shows up
 * via `window.addEventListener('unhandledrejection', ...)`). A dynamic
 * `import()` here means Vite code-splits this chain into its own chunk that
 * the browser never actually fetches, since the client never calls this
 * function.
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
    const { searchDevpostProfiles } = await import('~/shared/lib/repositories/devpost-profiles')
    const rows = await searchDevpostProfiles(query, perPage * page)
    const start = (page - 1) * perPage
    return rows.slice(start, start + perPage).map(profileToBuilder)
  } catch {
    return []
  }
}
