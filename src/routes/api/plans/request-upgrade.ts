import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { auth } from '~/shared/lib/auth/better-auth'
import { LegacyPlanMutationDisabledError, requestPlanUpgrade } from '~/shared/lib/billing'
import { env } from '~/shared/lib/env'

const Body = z.object({
  requestedPlan: z.enum(['pro', 'team']),
  message: z.string().max(500).optional(),
})

export const Route = createFileRoute('/api/plans/request-upgrade')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })
          // abuse-and-usage-integrity plan, Phase 3 task "Email verification gate":
          // when SIGNUP_REQUIRE_VERIFIED_EMAIL=true, an unverified account may
          // still log in and read (basic-login is never gated) but cannot request
          // a paid plan upgrade. Better-auth returns emailVerified on the
          // session object, so the check is a property read, not a query.
          if (env.SIGNUP_REQUIRE_VERIFIED_EMAIL === 'true' && !session.user.emailVerified) {
            return Response.json(
              {
                error: 'email_verification_required',
                message: 'Verify your email before requesting a paid plan upgrade.',
              },
              { status: 403 },
            )
          }
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
