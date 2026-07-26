import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { purgePortfolioCache } from '~/shared/lib/portfolio-cache'
import { unpublishPortfolioClaim } from '~/shared/lib/repositories/builder-claims'
import { emitSecurityAudit } from '~/shared/lib/security/audit'
import { consoleSecurityAuditSink } from '~/shared/lib/security/audit-sink'

export const Route = createFileRoute('/api/me/builder-claims/$claimId/portfolio/unpublish')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          if (env.PORTFOLIOS_ENABLED === 'false') {
            return Response.json({ error: 'Portfolios are temporarily unavailable' }, { status: 503 })
          }
          const principal = await requireTenantPrincipal(request)
          const unpublished = await withTenantContext(principal, (tx) =>
            unpublishPortfolioClaim(tx, { subjectUserId: principal.userId, claimId: params.claimId }),
          )
          if (!unpublished) return Response.json({ error: 'Not found' }, { status: 404 })
          await purgePortfolioCache(params.claimId)
          await emitSecurityAudit(
            { organizationId: null, actorUserId: principal.userId, action: 'portfolio.unpublish', targetType: 'builder_claim', targetId: params.claimId, result: 'allowed', requestId: principal.requestId },
            consoleSecurityAuditSink,
          )
          return Response.json({ ok: true, settings: unpublished })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Portfolio unpublish error:', error)
          return Response.json({ error: 'Failed to unpublish portfolio' }, { status: 500 })
        }
      },
    },
  },
})
