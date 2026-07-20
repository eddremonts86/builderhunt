import { createFileRoute } from '@tanstack/react-router'
import { listPublicIncidents } from '~/shared/lib/repositories/public-content'

export const Route = createFileRoute('/api/incidents/')({
  component: () => null,
  server: {
    handlers: {
      GET: async () => {
        try {
          const rows = await listPublicIncidents()
          return Response.json(rows)
        } catch (err) {
          console.error('incidents list error:', err)
          return Response.json([])
        }
      },
    },
  },
})
