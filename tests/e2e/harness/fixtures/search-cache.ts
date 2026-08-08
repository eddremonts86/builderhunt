/**
 * Seeds the app's own search cache so a page that searches on mount is deterministic.
 *
 * ## The problem this exists for
 *
 * `SearchPage` POSTs `/api/search/builders` with `FEATURED_QUERY` as soon as it mounts — a deliberate
 * product decision to show real results before the user types anything. In an e2e run that means the
 * page's content is whatever the live internet returned this minute, and the results carry avatars on
 * third-party CDNs. Any spec that visits `/search` under a strict browser guard then fails on
 * `third-party egress: https://media2.dev.to/...` — sometimes. It depends on which builders came back,
 * which is why the two specs affected passed alone and failed in a full run.
 *
 * Seeding the featured query's exact cache key makes the preview deterministic and avatar-less. The app
 * reads its own Redis cache before contacting any connector, so nothing external is touched.
 *
 * ## What this does not fix
 *
 * The egress guard in `../fakes/egress.ts` overrides `globalThis.fetch` in the *test worker* process.
 * The app under test is a separate `vite dev` child that never installs it, so the server can still
 * reach the real internet through any path a spec has not seeded. That is a real hole in the harness's
 * hermeticity, recorded in `plans/UI/tasks.md`; this helper closes the one hole that was actually
 * breaking tests, not the class of them.
 */
import { redis } from '../cache'

/** Mirrors `FEATURED_QUERY` in `src/modules/search/components/SearchPage.tsx`. */
export const FEATURED_QUERY = 'open source maintainers'

/** The featured preview asks for six. */
const FEATURED_PER_PAGE = 6

export interface CachedSearchBuilder {
  id: string
  kind: 'person'
  source: string
  sourceId: string
  username: string
  displayName: string
  bio: string
  profileUrl: string
  followersCount: number
  topics: string[]
  metadata: Record<string, unknown>
}

/**
 * Mirrors `cacheKey` in `src/lib/search.ts`: keywords sorted and comma-joined, then sources, country,
 * language, page, perPage. The route splits a string query on `/[,\s]+/` before it gets there.
 */
export function searchCacheKey(
  keywords: readonly string[],
  perPage: number,
  sources: readonly string[] = [],
  /**
   * Provider page. Part of the key because `searchBuildersWithStatus` passes it straight to each
   * connector — page two of a federated search is a different upstream request, not a slice of a
   * set already held. A spec that pages therefore has to seed every page it will ask for.
   */
  page = 1,
): string {
  const keywordsPart = [...keywords].sort().join(',')
  const sourcesPart = [...sources].sort().join(',')
  return `search:${[keywordsPart, sourcesPart, '', '', String(page), String(perPage)].join('-')}`
}

/**
 * Where a seeded row's `profileUrl` has to live, per `src/shared/lib/security/url-policy.ts`.
 *
 * A row whose URL is off its source's allowed host is rejected by a later
 * `POST /api/builders/track`, so getting this wrong produces a failure two steps from its cause.
 */
const SOURCE_PROFILE_URL: Record<string, (username: string) => string> = {
  github: (username) => `https://github.com/${username}`,
  hn: (username) => `https://news.ycombinator.com/user?id=${username}`,
  devto: (username) => `https://dev.to/${username}`,
}

export interface CachedSearchBuilderOptions {
  /** Defaults to `github`, which is what every caller before the ranking fixtures wanted. */
  source?: keyof typeof SOURCE_PROFILE_URL
  /** Follower count per index. Drives `scoreBuilders`' popularity term, so it drives the ranking. */
  followers?: (index: number) => number
  /** Topics per index. Drives the topic-match term, capped at 15 points. */
  topics?: (index: number) => string[]
}

/**
 * Deterministic, avatar-less results. No `avatarUrl` at all — the point is that the browser has no
 * third-party image to fetch, so the card renders its initials fallback.
 *
 * Nothing here carries `metadata.lastSeen`. That is what makes the *score* deterministic as well as
 * the rows: `scoreBuilders` reads `Date.now()` only inside the recency branch, so a row without it
 * takes the neutral five points and scores the same in every run.
 */
export function cachedSearchBuilders(
  label: string,
  count: number,
  options: CachedSearchBuilderOptions = {},
): CachedSearchBuilder[] {
  const source = options.source ?? 'github'
  const profileUrl = SOURCE_PROFILE_URL[source]
  const safe = label.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  return Array.from({ length: count }, (_, index) => {
    const username = `${safe}-builder-${index}`
    return {
      id: `${source}:${username}`,
      kind: 'person' as const,
      source,
      sourceId: username,
      username,
      displayName: `Seeded Builder ${index} ${safe}`,
      bio: `Deterministic E2E search result ${index} for ${safe}.`,
      profileUrl: profileUrl(username),
      followersCount: options.followers?.(index) ?? 100 + index,
      topics: options.topics?.(index) ?? [],
      metadata: {},
    }
  })
}

/** Writes one cache entry, self-expiring so a crashed run cannot leave a stale key behind. */
export async function seedSearchCache(
  redisPrefix: string,
  key: string,
  builders: readonly CachedSearchBuilder[],
): Promise<void> {
  const client = await redis.client(redisPrefix)
  try {
    await client.set(key, JSON.stringify(builders), 'EX', 900)
  } finally {
    await client.quit()
  }
}

/**
 * Call from `beforeAll` in any spec whose browser reaches `/search`.
 *
 * Cheap and idempotent — one Redis `SET` against the worker's own namespace.
 */
export async function seedFeaturedSearchCache(redisPrefix: string): Promise<void> {
  await seedSearchCache(
    redisPrefix,
    searchCacheKey(FEATURED_QUERY.split(/[,\s]+/).filter(Boolean), FEATURED_PER_PAGE),
    cachedSearchBuilders('featured', FEATURED_PER_PAGE),
  )
}
