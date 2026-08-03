import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { SeatLimitExceededError } from '~/shared/lib/auth/organization-lifecycle'
import {
  findPlanRequest,
  LegacyPlanMutationDisabledError,
  listPlanRequestsWithUsers,
  resolvePlanRequest,
  setUserPlan,
} from '~/shared/lib/billing'

const ResolveBody = z.object({
  requestId: z.string(),
  decision: z.enum(['approved', 'declined']),
  reason: z.string().max(500).optional(),
})

export const Route = createFileRoute('/api/admin/plan-requests/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST']),

      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)
          const rows = await listPlanRequestsWithUsers()
          return Response.json(rows)
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin plan requests error:', err)
          return Response.json([])
        }
      },
      POST: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
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
              await setUserPlan(req.userId, req.requestedPlan as 'pro' | 'team', principal.userId, parsed.data.reason, endsAt)
            }
          }
          await auditPlatformAdminAction(principal, {
            action: 'admin.plan-request.resolve',
            targetType: 'plan-request',
            targetId: parsed.data.requestId,
            result: 'allowed',
            details: { decision: parsed.data.decision },
          })
          return Response.json({ ok: true })
        } catch (err) {
          if (err instanceof SeatLimitExceededError) {
            return Response.json(
              { error: 'This user has more members in their personal workspace than the requested plan allows' },
              { status: 409 },
            )
          }
          if (err instanceof LegacyPlanMutationDisabledError) {
            return Response.json(
              { error: 'Self-service plan requests are retired now that Stripe billing is canonical — direct the user to Checkout, or use the operator grant tool on /admin/users for a manual exception.', migrationGuidance: true },
              { status: 409 },
            )
          }
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin plan requests resolve error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
