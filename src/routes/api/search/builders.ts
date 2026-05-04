import { createFileRoute } from '@tanstack/react-router'
import { searchBuilders } from '~/lib/search'

export const Route = createFileRoute('/api/search/builders')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json()
          const { keywords, sources, language, country } = body
          const keywordsArray = typeof keywords === 'string'
            ? keywords.split(/[,\s]+/).filter(Boolean)
            : Array.isArray(keywords) ? keywords : []
          const results = await searchBuilders({
            keywords: keywordsArray,
            sources: Array.isArray(sources) ? sources : ['github'],
            language,
            country,
          })
          return Response.json({ builders: results })
        } catch (err) {
          console.error('Search error:', err)
          return Response.json({ error: 'Search failed' }, { status: 500 })
        }
      },
    },
  },
})