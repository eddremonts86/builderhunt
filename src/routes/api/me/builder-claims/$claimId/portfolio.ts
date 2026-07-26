import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { PortfolioDraftInputSchema } from '~/shared/lib/portfolio'
import { purgePortfolioCache } from '~/shared/lib/portfolio-cache'
import { fetchPortfolioProjectCandidates } from '~/lib/github/content'
import { getPortfolioForOwner, savePortfolioDraft } from '~/shared/lib/repositories/builder-claims'

/** Owner-only draft read/write. Publish/unpublish are separate explicit transitions (portfolio/publish.ts, portfolio/unpublish.ts) — a PATCH here never makes anything publicly visible. */
export const Route = createFileRoute('/api/me/builder-claims/$claimId/portfolio')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          if (env.PORTFOLIOS_ENABLED === 'false') {
            return Response.json({ error: 'Portfolios are temporarily unavailable' }, { status: 503 })
          }
          const principal = await requireTenantPrincipal(request)
          const owned = await withTenantContext(principal, (tx) =>
            getPortfolioForOwner(tx, { subjectUserId: principal.userId, claimId: params.claimId }),
          )
          if (!owned) return Response.json({ error: 'Not found' }, { status: 404 })

          // Project candidates: real repos only for sources we can actually
          // fetch from. GITHUB_TOKEN absent (or any other source) means an
          // honest empty list, never invented placeholder projects.
          const candidates = owned.source === 'github'
            ? await fetchPortfolioProjectCandidates(owned.username).catch(() => [])
            : []

          return Response.json({
            claimId: owned.claimId,
            source: owned.source,
            username: owned.username,
            displayName: owned.displayName,
            avatarUrl: owned.avatarUrl,
            profileUrl: owned.profileUrl,
            settings: owned.settings,
            projectCandidates: candidates,
            integrationsAvailable: { aiPersona: false, timeline: false },
          })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Portfolio draft GET error:', error)
          return Response.json({ error: 'Failed to load portfolio' }, { status: 500 })
        }
      },
      PATCH: async ({ request, params }) => {
        try {
          if (env.PORTFOLIOS_ENABLED === 'false') {
            return Response.json({ error: 'Portfolios are temporarily unavailable' }, { status: 503 })
          }
          const principal = await requireTenantPrincipal(request)
          const parsed = PortfolioDraftInputSchema.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) return Response.json({ error: 'Invalid portfolio input' }, { status: 400 })

          const updated = await withTenantContext(principal, (tx) =>
            savePortfolioDraft(tx, { subjectUserId: principal.userId, claimId: params.claimId, draft: parsed.data }),
          )
          if (!updated) return Response.json({ error: 'Not found' }, { status: 404 })
          await purgePortfolioCache(params.claimId)
          return Response.json({ ok: true, settings: updated })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Portfolio draft PATCH error:', error)
          return Response.json({ error: 'Failed to save portfolio' }, { status: 500 })
        }
      },
    },
  },
})
