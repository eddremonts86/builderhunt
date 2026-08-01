import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { revokeBuilderClaim } from '~/shared/lib/repositories/builder-claims'
import { platformDb } from '~/shared/lib/db/client'
import { purgePortfolioCache } from '~/shared/lib/portfolio-cache'

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

          // `platformDb` (builderhunt_platform), not `publicDb` — the caller is never the claim's
          // own subject, so `builderhunt_app`'s owner-scoped RLS policy would silently match zero
          // rows here (see drizzle/0116_grant_platform_builder_claims_revoke.sql).
          const revoked = await revokeBuilderClaim(platformDb, {
            claimId: params.claimId,
            adminUserId: principal.userId,
            reason: parsed.data.reason,
          })
          if (!revoked) {
            return Response.json({ error: 'No active verified claim found for that id' }, { status: 404 })
          }
          // A revoked claim's own public read independently rechecks status
          // on every uncached fetch, but a warm cache entry from before the
          // revocation would otherwise keep serving for up to the cache TTL.
          await purgePortfolioCache(params.claimId)

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
