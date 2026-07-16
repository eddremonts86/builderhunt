import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { incidents } from '~/shared/lib/db/schema'
import { desc } from 'drizzle-orm'

export const Route = createFileRoute('/api/incidents/')({
  component: () => null,
  server: {
    handlers: {
      GET: async () => {
        try {
          const rows = await db
            .select()
            .from(incidents)
            .orderBy(desc(incidents.startedAt))
            .limit(50)
          return Response.json(rows)
        } catch (err) {
          console.error('incidents list error:', err)
          return Response.json([])
        }
      },
    },
  },
})
