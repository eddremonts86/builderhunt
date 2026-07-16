import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { planChanges } from '~/shared/lib/db/schema'
import { desc, eq } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'

export const Route = createFileRoute('/api/me/plan-changes/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const rows = await db
            .select()
            .from(planChanges)
            .where(eq(planChanges.userId, session.user.id))
            .orderBy(desc(planChanges.createdAt))
            .limit(20)
          return Response.json(
            rows.map((r) => ({
              id: r.id,
              fromPlan: r.fromPlan,
              toPlan: r.toPlan,
              changedBy: r.changedBy,
              reason: r.reason,
              createdAt: r.createdAt,
            })),
          )
        } catch (err) {
          console.error('plan changes error:', err)
          return Response.json([])
        }
      },
    },
  },
})
