import { createFileRoute } from '@tanstack/react-router'
import { listPublicChangelogEntries } from '~/shared/lib/repositories/public-content'

export const Route = createFileRoute('/api/changelog/')({
  component: () => null,
  server: {
    handlers: {
      GET: async () => {
        try {
          const rows = await listPublicChangelogEntries()
          return Response.json(rows)
        } catch (err) {
          console.error('changelog list error:', err)
          return Response.json([])
        }
      },
    },
  },
})
