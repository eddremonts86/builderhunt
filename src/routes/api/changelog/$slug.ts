import { createFileRoute } from '@tanstack/react-router'
import { findPublicChangelogEntryBySlug } from '~/shared/lib/repositories/public-content'

export const Route = createFileRoute('/api/changelog/$slug')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const row = await findPublicChangelogEntryBySlug(params.slug)
          if (!row) return Response.json({ error: 'Not found' }, { status: 404 })
          return Response.json(row)
        } catch (err) {
          console.error('changelog get error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
