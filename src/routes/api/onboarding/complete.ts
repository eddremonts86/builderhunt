import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auth } from '~/shared/lib/auth/better-auth'
import { advanceOnboarding } from '~/shared/lib/onboarding'

const Body = z.object({
  step: z.number().int().min(0).max(3).optional(),
  firstQueryId: z.string().optional(),
  builderId: z.string().optional(),
  completed: z.boolean().optional(),
})

export const Route = createFileRoute('/api/onboarding/complete')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const body = await request.json().catch(() => ({}))
          const parsed = Body.safeParse(body)
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body' }, { status: 400 })
          }
          const status = await advanceOnboarding(session.user.id, parsed.data)
          return Response.json({ ok: true, status })
        } catch (err) {
          console.error('Onboarding complete error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
