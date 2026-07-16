import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { changelog } from '~/shared/lib/db/schema'
import { desc } from 'drizzle-orm'

export const Route = createFileRoute('/api/changelog/')({
  component: () => null,
  server: {
    handlers: {
      GET: async () => {
        try {
          const rows = await db
            .select()
            .from(changelog)
            .orderBy(desc(changelog.publishedAt))
            .limit(50)
          return Response.json(rows)
        } catch (err) {
          console.error('changelog list error:', err)
          return Response.json([])
        }
      },
    },
  },
})
