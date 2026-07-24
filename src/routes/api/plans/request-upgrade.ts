import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auth } from '~/shared/lib/auth/better-auth'
import { LegacyPlanMutationDisabledError, requestPlanUpgrade } from '~/shared/lib/billing'

const Body = z.object({
  requestedPlan: z.enum(['pro', 'team']),
  message: z.string().max(500).optional(),
})

export const Route = createFileRoute('/api/plans/request-upgrade')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })
          const body = await request.json().catch(() => ({}))
          const parsed = Body.safeParse(body)
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })
          const result = await requestPlanUpgrade(session.user.id, parsed.data.requestedPlan, parsed.data.message)
          // In dev: log to console (no email)
          console.log(
            `[billing] Plan upgrade requested by user ${session.user.id}: ` +
            `${parsed.data.requestedPlan} (request ${result.id}${result.alreadyPending ? ' already pending' : ''})`,
          )
          return Response.json({ ok: true, ...result })
        } catch (err) {
          if (err instanceof LegacyPlanMutationDisabledError) {
            return Response.json({ error: err.message, migrationGuidance: true, checkoutUrl: '/settings/billing' }, { status: 409 })
          }
          console.error('plan request error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
