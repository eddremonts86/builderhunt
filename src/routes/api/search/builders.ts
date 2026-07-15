import { createFileRoute } from '@tanstack/react-router'
import { searchBuilders } from '~/lib/search'

export const Route = createFileRoute('/api/search/builders')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
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
            sources: Array.isArray(sources) ? sources : ['github'],
            language,
            country,
            page,
            perPage,
          })
          return Response.json({
            builders: results,
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
