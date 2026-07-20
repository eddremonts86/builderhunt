import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auth } from '~/shared/lib/auth/better-auth'
import {
  findPlanRequest,
  listPlanRequestsWithUsers,
  resolvePlanRequest,
  setUserPlan,
} from '~/shared/lib/billing'

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean)
function isAdmin(userId: string) {
  return ADMIN_IDS.length > 0 && ADMIN_IDS.includes(userId)
}

const ResolveBody = z.object({
  requestId: z.string(),
  decision: z.enum(['approved', 'declined']),
  reason: z.string().max(500).optional(),
})

export const Route = createFileRoute('/api/admin/plan-requests/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id || !isAdmin(session.user.id)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const rows = await listPlanRequestsWithUsers()
          return Response.json(rows)
        } catch (err) {
          console.error('admin plan requests error:', err)
          return Response.json([])
        }
      },
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id || !isAdmin(session.user.id)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
          }
          const body = await request.json().catch(() => ({}))
          const parsed = ResolveBody.safeParse(body)
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          await resolvePlanRequest(parsed.data.requestId, parsed.data.decision)
          // If approved, set the user's plan
          if (parsed.data.decision === 'approved') {
            const req = await findPlanRequest(parsed.data.requestId)
            if (req) {
              // Default 30 days from now
              const endsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
              await setUserPlan(req.userId, req.requestedPlan as 'pro' | 'team', session.user.id, parsed.data.reason, endsAt)
            }
          }
          return Response.json({ ok: true })
        } catch (err) {
          console.error('admin plan requests resolve error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
