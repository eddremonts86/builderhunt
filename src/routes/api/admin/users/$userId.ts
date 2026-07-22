import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { SeatLimitExceededError } from '~/shared/lib/auth/organization-lifecycle'
import { setUserPlan } from '~/shared/lib/billing'

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
          const principal = await requirePlatformAdminPrincipal(request)
          const body = await request.json().catch(() => ({}))
          const parsed = UpdateBody.safeParse(body)
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          const result = await setUserPlan(
            params.userId,
            parsed.data.plan,
            principal.userId,
            parsed.data.reason,
            parsed.data.planEndsAt ? new Date(parsed.data.planEndsAt) : undefined,
          )
          await auditPlatformAdminAction(principal, {
            action: 'admin.user.plan-change',
            targetType: 'user',
            targetId: params.userId,
            result: 'allowed',
            details: { from: result.from, to: parsed.data.plan },
          })
          return Response.json({ ok: true, ...result })
        } catch (err) {
          if (err instanceof SeatLimitExceededError) {
            return Response.json(
              { error: 'This user has more members in their personal workspace than the new plan allows — remove members first' },
              { status: 409 },
            )
          }
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin user patch error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
