import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { purgePortfolioCache } from '~/shared/lib/portfolio-cache'
import { publishPortfolioClaim } from '~/shared/lib/repositories/builder-claims'
import { emitSecurityAudit } from '~/shared/lib/security/audit'
import { consoleSecurityAuditSink } from '~/shared/lib/security/audit-sink'

export const Route = createFileRoute('/api/me/builder-claims/$claimId/portfolio/publish')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          if (env.PORTFOLIOS_ENABLED === 'false') {
            return Response.json({ error: 'Portfolios are temporarily unavailable' }, { status: 503 })
          }
          const principal = await requireTenantPrincipal(request)
          const published = await withTenantContext(principal, (tx) =>
            publishPortfolioClaim(tx, { subjectUserId: principal.userId, claimId: params.claimId }),
          )
          if (!published) return Response.json({ error: 'Not found' }, { status: 404 })
          await purgePortfolioCache(params.claimId)
          await emitSecurityAudit(
            { organizationId: null, actorUserId: principal.userId, action: 'portfolio.publish', targetType: 'builder_claim', targetId: params.claimId, result: 'allowed', requestId: principal.requestId },
            consoleSecurityAuditSink,
          )
          return Response.json({ ok: true, settings: published })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Portfolio publish error:', error)
          return Response.json({ error: 'Failed to publish portfolio' }, { status: 500 })
        }
      },
    },
  },
})
