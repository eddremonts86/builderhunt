import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
import { metrics } from '~/shared/lib/metrics'
import { getPlatformAccountMetrics } from '~/shared/lib/repositories/platform-billing'

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

          const accountMetrics = await getPlatformAccountMetrics(oneDayAgo, oneWeekAgo)

          return Response.json({
            inProcess,
            db: {
              ...accountMetrics,
              totalSavedQueries: null,
              totalBuilders: null,
              totalNotes: null,
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
