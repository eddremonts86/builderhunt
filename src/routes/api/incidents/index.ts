import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { listPublicIncidents } from '~/shared/lib/repositories/public-content'

export const Route = createFileRoute('/api/incidents/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

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
