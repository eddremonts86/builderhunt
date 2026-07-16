import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auth } from '~/shared/lib/auth/better-auth'
import { setUserPlan } from '~/shared/lib/billing'

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean)
function isAdmin(userId: string) {
  return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(userId)
}

const UpdateBody = z.object({
  plan: z.enum(['free', 'pro', 'team']),
  planEndsAt: z.string().optional(),
  reason: z.string().max(500).optional(),
})

export const Route = createFileRoute('/api/admin/users/$userId')({
  component: () => null,
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id || !isAdmin(session.user.id)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const body = await request.json().catch(() => ({}))
          const parsed = UpdateBody.safeParse(body)
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          const result = await setUserPlan(
            params.userId,
            parsed.data.plan,
            session.user.id,
            parsed.data.reason,
            parsed.data.planEndsAt ? new Date(parsed.data.planEndsAt) : undefined,
          )
          console.log(
            `[billing] Admin ${session.user.id} changed plan for user ${params.userId}: ` +
            `${result.from} -> ${parsed.data.plan}`,
          )
          return Response.json({ ok: true, ...result })
        } catch (err) {
          console.error('admin user patch error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
