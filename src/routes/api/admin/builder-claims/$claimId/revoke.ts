import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { revokeBuilderClaim } from '~/shared/lib/repositories/builder-claims'
import { publicDb } from '~/shared/lib/db/client'

const Body = z.object({ reason: z.string().min(3).max(500) })

export const Route = createFileRoute('/api/admin/builder-claims/$claimId/revoke')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const parsed = Body.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) return Response.json({ error: 'A reason (3-500 chars) is required' }, { status: 400 })

          const revoked = await revokeBuilderClaim(publicDb, {
            claimId: params.claimId,
            adminUserId: principal.userId,
            reason: parsed.data.reason,
          })
          if (!revoked) {
            return Response.json({ error: 'No active verified claim found for that id' }, { status: 404 })
          }

          await auditPlatformAdminAction(principal, {
            action: 'admin.builder-claim.revoke',
            targetType: 'builder-claim',
            targetId: params.claimId,
            result: 'allowed',
            details: { reason: parsed.data.reason, builderIdentityId: revoked.builderIdentityId },
          })
          return Response.json({ ok: true })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin builder-claim revoke error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
