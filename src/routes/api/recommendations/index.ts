import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { searchBuilders } from '~/lib/search'
import { rateLimit } from '~/shared/lib/rate-limit'
import { getTrackedKeySet, trackedKey } from '~/shared/lib/tracked-builders'
import { listRecentSavedQueries } from '~/shared/lib/repositories/saved-queries'

/**
 * Proactive Discovery — "For you" recommendations.
 *
 * Strategy (v1):
 *   1. Pull the user's most recent saved queries (cap to 3 to stay
 *      within reasonable latency)
 *   2. Re-run those queries via the search pipeline (fresh, accurate)
 *   3. Dedupe across queries
 *   4. Exclude builders the user has already saved
 *   5. Score by:
 *        - Multi-query matches (a builder matching 2+ saved searches
 *          ranks higher — these are the most adjacent)
 *        - Recency (last_seen within 90 days)
 *        - Relevance (the score the search pipeline already computed)
 *   6. Return top 8
 *
 * Empty states:
 *   - No saved queries → return { recommendations: [], reason: 'no_saved_searches' }
 *   - No matches       → return { recommendations: [], reason: 'no_matches' }
 */

interface RawBuilder {
  id: string
  username: string
  displayName?: string | null
  source: string
  sourceId: string
  profileUrl: string
  followersCount?: number | null
  topics?: string[]
  bio?: string | null
  lastSeen?: string | Date | null
  score?: number
  metadata?: Record<string, unknown>
}

interface Recommendation {
  builder: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
    bio: string | null
    source: string
    followersCount: number | null
    topics: string[]
  }
  reasons: Array<{
    type: 'keyword' | 'source' | 'topic'
    value: string
    matchedSearchName: string
  }>
  score: number
}

const MAX_QUERIES_TO_RUN = 3
const PER_QUERY_LIMIT = 20
const MAX_RECOMMENDATIONS = 8

export const Route = createFileRoute('/api/recommendations/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)

          const rl = await rateLimit('recommendations', `${principal.organizationId}:${principal.userId}`, 30, 60)
          if (!rl.allowed) {
            return Response.json(
              { error: 'Too many requests. Please slow down.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.resetMs / 1000)) } },
            )
          }

          // 1. Pull most recent saved queries
          const { userQueries, savedKey } = await withTenantContext(principal, async (tx) => ({
            userQueries: await listRecentSavedQueries(tx, principal.organizationId, MAX_QUERIES_TO_RUN),
            savedKey: await getTrackedKeySet(tx, principal.organizationId),
          }))

          if (userQueries.length === 0) {
            return Response.json({
              recommendations: [],
              meta: { reason: 'no_saved_searches', basedOnSearches: 0, totalCandidates: 0 },
            })
          }

          // 2. Build a sources union across all queries (so we don't waste
          //    API calls on sources the user disabled)
          const sourcesUnion = Array.from(
            new Set(userQueries.flatMap((q) => (q.sources ?? []) as string[])),
          )

          // 3. Run all queries in parallel via the search pipeline
          const queryResults = await Promise.all(
            userQueries.map(async (q) => {
              const keywords = (q.keywords ?? []) as string[]
              if (keywords.length === 0) return { name: q.name, results: [] as RawBuilder[] }
              const results = (await searchBuilders({
                keywords,
                sources: sourcesUnion,
                perPage: PER_QUERY_LIMIT,
              })) as RawBuilder[]
              return { name: q.name, results }
            }),
          )

          // 4. Aggregate by builder id, tracking which queries matched
          const aggregated = new Map<
            string,
            {
              builder: RawBuilder
              matchedSearches: string[]
              matchCount: number
              maxScore: number
            }
          >()
          for (const { name, results } of queryResults) {
            for (const r of results) {
              const existing = aggregated.get(r.id)
              if (existing) {
                existing.matchedSearches.push(name)
                existing.matchCount++
                if ((r.score ?? 0) > existing.maxScore) existing.maxScore = r.score ?? 0
              } else {
                aggregated.set(r.id, {
                  builder: r,
                  matchedSearches: [name],
                  matchCount: 1,
                  maxScore: r.score ?? 0,
                })
              }
            }
          }

          // 5. Exclude builders the user has already tracked — sourceId+source
          //    is the key since builders.id is per-user (see tracked-builders.ts)
          const candidates = Array.from(aggregated.values()).filter(
            (a) => !savedKey.has(trackedKey(a.builder.source, a.builder.sourceId)),
          )

          if (candidates.length === 0) {
            return Response.json({
              recommendations: [],
              meta: {
                reason: 'no_matches',
                basedOnSearches: userQueries.length,
                totalCandidates: 0,
              },
            })
          }

          // 6. Sort by: match count desc, maxScore desc, recency desc
          candidates.sort((a, b) => {
            if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount
            if (b.maxScore !== a.maxScore) return b.maxScore - a.maxScore
            const aTime = a.builder.lastSeen ? new Date(a.builder.lastSeen).getTime() : 0
            const bTime = b.builder.lastSeen ? new Date(b.builder.lastSeen).getTime() : 0
            return bTime - aTime
          })

          // 7. Format recommendations
          const top = candidates.slice(0, MAX_RECOMMENDATIONS)
          const recommendations: Recommendation[] = top.map((c) => {
            const b = c.builder
            const reasons: Recommendation['reasons'] = []
            // Topic matches
            const queryTopics = new Set<string>()
            for (const q of userQueries) {
              for (const k of (q.keywords ?? []) as string[]) queryTopics.add(k.toLowerCase())
            }
            for (const t of b.topics ?? []) {
              if (queryTopics.has(t.toLowerCase())) {
                for (const q of userQueries) {
                  if (((q.keywords ?? []) as string[]).some((k) => k.toLowerCase() === t.toLowerCase())) {
                    reasons.push({
                      type: 'topic',
                      value: t,
                      matchedSearchName: q.name,
                    })
                  }
                }
              }
            }
            // Source matches
            for (const q of userQueries) {
              if (((q.sources ?? []) as string[]).includes(b.source)) {
                reasons.push({
                  type: 'source',
                  value: b.source,
                  matchedSearchName: q.name,
                })
              }
            }
            // Keyword matches in bio / displayName / username
            for (const q of userQueries) {
              for (const k of (q.keywords ?? []) as string[]) {
                const kl = k.toLowerCase()
                if (
                  b.username.toLowerCase().includes(kl) ||
                  (b.displayName?.toLowerCase().includes(kl) ?? false) ||
                  (b.bio?.toLowerCase().includes(kl) ?? false)
                ) {
                  reasons.push({
                    type: 'keyword',
                    value: k,
                    matchedSearchName: q.name,
                  })
                }
              }
            }
            // Dedupe reasons by (type, value, matchedSearchName)
            const seen = new Set<string>()
            const uniqueReasons = reasons.filter((r) => {
              const k = `${r.type}:${r.value}:${r.matchedSearchName}`
              if (seen.has(k)) return false
              seen.add(k)
              return true
            })

            return {
              builder: {
                id: b.id,
                username: b.username,
                displayName: b.displayName ?? b.username,
                avatarUrl: null,
                bio: b.bio ?? null,
                source: b.source,
                followersCount: b.followersCount ?? null,
                topics: b.topics ?? [],
              },
              reasons: uniqueReasons.slice(0, 4),
              score: Math.round(
                Math.min(100, c.maxScore + c.matchCount * 5),
              ),
            }
          })

          return Response.json({
            recommendations,
            meta: {
              basedOnSearches: userQueries.length,
              totalCandidates: candidates.length,
            },
          })
        } catch (err) {
          if (err instanceof TenantAuthorizationError) {
            return Response.json({ error: err.message }, { status: err.status })
          }
          console.error('Recommendations error:', err)
          return Response.json({
            recommendations: [],
            meta: { reason: 'error', basedOnSearches: 0, totalCandidates: 0 },
          })
        }
      },
    },
  },
})
