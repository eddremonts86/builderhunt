import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { changelog } from '~/shared/lib/db/schema'
import { eq } from 'drizzle-orm'

export const Route = createFileRoute('/api/changelog/$slug')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const [row] = await db
            .select()
            .from(changelog)
            .where(eq(changelog.slug, params.slug))
            .limit(1)
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
