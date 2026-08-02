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
): string {
  const keywordsPart = [...keywords].sort().join(',')
  const sourcesPart = [...sources].sort().join(',')
  return `search:${[keywordsPart, sourcesPart, '', '', '1', String(perPage)].join('-')}`
}

/**
 * Deterministic, avatar-less results. No `avatarUrl` at all — the point is that the browser has no
 * third-party image to fetch, so the card renders its initials fallback.
 */
export function cachedSearchBuilders(label: string, count: number): CachedSearchBuilder[] {
  const safe = label.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  return Array.from({ length: count }, (_, index) => {
    const username = `${safe}-builder-${index}`
    return {
      id: `github:${username}`,
      kind: 'person' as const,
      source: 'github',
      sourceId: username,
      username,
      displayName: `Seeded Builder ${index} ${safe}`,
      bio: `Deterministic E2E search result ${index} for ${safe}.`,
      // Must satisfy src/shared/lib/security/url-policy.ts for the declared source, or a later
      // POST /api/builders/track on this row is rejected.
      profileUrl: `https://github.com/${username}`,
      followersCount: 100 + index,
      topics: [],
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
