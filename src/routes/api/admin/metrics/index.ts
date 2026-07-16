import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
import { metrics } from '~/shared/lib/metrics'
import { db } from '~/shared/lib/db/index'
import { authUsers, savedQueries, builders, builderNotes } from '~/shared/lib/db/schema'
import { count, sql, gte, desc } from 'drizzle-orm'

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean)
function isAdmin(userId: string) {
  return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(userId)
}

export const Route = createFileRoute('/api/admin/metrics/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id || !isAdmin(session.user.id)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }

          // In-process metrics
          const inProcess = metrics.get()

          // DB aggregates
          const now = new Date()
          const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
          const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

          const [userCount] = await db.select({ c: count() }).from(authUsers)
          const [dauCount] = await db.select({ c: count() }).from(authUsers).where(gte(authUsers.createdAt, oneDayAgo))
          const [wauCount] = await db.select({ c: count() }).from(authUsers).where(gte(authUsers.createdAt, oneWeekAgo))
          const [sqCount] = await db.select({ c: count() }).from(savedQueries)
          const [bCount] = await db.select({ c: count() }).from(builders)
          const [nCount] = await db.select({ c: count() }).from(builderNotes)

          return Response.json({
            inProcess,
            db: {
              totalUsers: Number(userCount?.c ?? 0),
              newUsersLast24h: Number(dauCount?.c ?? 0),
              newUsersLast7d: Number(wauCount?.c ?? 0),
              totalSavedQueries: Number(sqCount?.c ?? 0),
              totalBuilders: Number(bCount?.c ?? 0),
              totalNotes: Number(nCount?.c ?? 0),
            },
            server: {
              nodeVersion: process.version,
              platform: process.platform,
              pid: process.pid,
              memoryUsage: process.memoryUsage(),
            },
          })
        } catch (err) {
          console.error('admin metrics error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
