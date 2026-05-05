import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { builders } from '~/shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'

export const Route = createFileRoute('/api/export/builders')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const userId = session.user.id

          const allBuilders = await db
            .select()
            .from(builders)
            .where(eq(builders.userId, userId))

          const header = ['username', 'source', 'score', 'language', 'country', 'topics', 'profileUrl']
          const rows = allBuilders.map(b => [
            b.username,
            b.source,
            b.metadata && typeof b.metadata === 'object' && 'score' in (b.metadata as Record<string, unknown>)
              ? String((b.metadata as Record<string, unknown>).score)
              : '0',
            b.language ?? '',
            b.country ?? '',
            (b.topics ?? []).join('; '),
            b.profileUrl,
          ])

          const csv = [
            header.join(','),
            ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
          ].join('\n')

          return new Response(csv, {
            headers: {
              'Content-Type': 'text/csv',
              'Content-Disposition': 'attachment; filename="builders.csv"',
            },
          })
        } catch (err) {
          console.error('Export error:', err)
          return Response.json({ error: 'Export failed' }, { status: 500 })
        }
      },
    },
  },
})
