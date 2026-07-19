import { createFileRoute } from '@tanstack/react-router'
import { searchBuilders } from '~/lib/search'
import { rateLimit, getRateLimitId } from '~/shared/lib/rate-limit'
import { auth } from '~/shared/lib/auth/better-auth'
import { getTrackedKeySet, trackedKey } from '~/shared/lib/tracked-builders'

export const Route = createFileRoute('/api/search/builders')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const rl = await rateLimit('search-builders', getRateLimitId(request), 60, 60)
          if (!rl.allowed) {
            return Response.json(
              { error: 'Too many search requests. Please slow down.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.resetMs / 1000)) } },
            )
          }

          const body = await request.json()
          const {
            keywords,
            sources,
            language,
            country,
            page = 1,
            perPage = 30,
          } = body
          const keywordsArray = typeof keywords === 'string'
            ? keywords.split(/[,\s]+/).filter(Boolean)
            : Array.isArray(keywords) ? keywords : []
          const results = await searchBuilders({
            keywords: keywordsArray,
            sources: Array.isArray(sources) ? sources : undefined,
            language,
            country,
            page,
            perPage,
          })

          const session = await auth.api.getSession({ headers: request.headers })
          let trackedKeys = new Set<string>()
          if (session?.user?.id) {
            try {
              trackedKeys = await getTrackedKeySet(session.user.id)
            } catch (err) {
              // Best-effort: a tracked-state lookup failure shouldn't fail
              // the whole search — just show everyone as untracked.
              console.error('getTrackedKeySet error:', err)
            }
          }
          const annotated = results.map((b) => ({
            ...b,
            tracked: trackedKeys.has(trackedKey(b.source, b.sourceId)),
          }))

          return Response.json({
            builders: annotated,
            page,
            perPage,
            hasMore: results.length >= perPage,
          })
        } catch (err) {
          console.error('Search error:', err)
          return Response.json({ error: 'Search failed' }, { status: 500 })
        }
      },
    },
  },
})
