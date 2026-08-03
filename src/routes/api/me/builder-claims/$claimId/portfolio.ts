import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { PortfolioDraftInputSchema } from '~/shared/lib/portfolio'
import { purgePortfolioCache } from '~/shared/lib/portfolio-cache'
import { fetchPortfolioProjectCandidates } from '~/lib/github/content'
import { getPortfolioForOwner, savePortfolioDraft } from '~/shared/lib/repositories/builder-claims'
import { findClaimantOwnedAiEnrichment } from '~/shared/lib/repositories/organization-builders'
import { portfolioIntegrationsAvailable } from '~/shared/lib/portfolio-integrations'
import { getBuilderTimeline } from '~/lib/timeline'

// `tenant-principal.ts` keeps its principal type internal, so both are inferred from the functions themselves
// rather than re-declared here — a local restatement would drift from the real shape without any error.
type Principal = Awaited<ReturnType<typeof requireTenantPrincipal>>
type OwnedPortfolio = NonNullable<Awaited<ReturnType<typeof getPortfolioForOwner>>>

/**
 * Whether each optional integration would actually render something, for this owner's own builder.
 *
 * This used to be the literal `{ aiPersona: false, timeline: false }`, and nothing consumed it — so both toggles
 * in the draft editor were always live and an owner could enable "Show AI-summarized profile", publish, and see
 * no change at all. The two reads below are the same ones the public page makes, so the answer the owner is shown
 * matches what a visitor would get.
 *
 * Fail-closed and never fatal: a draft must still load when an integration cannot be resolved. Reporting `false`
 * on failure is the safe direction — it hides a toggle that might have worked, where reporting `true` would
 * promise something the published page then does not deliver.
 */
async function resolveIntegrationsAvailable(principal: Principal, owned: OwnedPortfolio) {
  const [aiEnrichment, timelineEvents] = await Promise.all([
    // SECURITY DEFINER (migration 0119), and documented as safe from a tenant transaction or publicDb alike —
    // so this returns the same artifact the anonymous public page resolves, not an RLS-narrowed subset.
    withTenantContext(principal, (tx) =>
      findClaimantOwnedAiEnrichment(tx, owned.builderIdentityId, principal.userId),
    ).catch(() => null),
    getBuilderTimeline({ source: owned.source as never, sourceId: owned.sourceId, username: owned.username })
      .then((result) => result.events.map((event) => ({
        id: event.id,
        occurredAt: event.timestamp,
        kind: event.type,
        title: event.title,
        summary: event.description ?? '',
      })))
      .catch(() => []),
  ])
  return portfolioIntegrationsAvailable({ aiEnrichment, timelineEvents })
}

/** Owner-only draft read/write. Publish/unpublish are separate explicit transitions (portfolio/publish.ts, portfolio/unpublish.ts) — a PATCH here never makes anything publicly visible. */
export const Route = createFileRoute('/api/me/builder-claims/$claimId/portfolio')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'PATCH']),

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

          const integrationsAvailable = await resolveIntegrationsAvailable(principal, owned)

          return Response.json({
            claimId: owned.claimId,
            source: owned.source,
            username: owned.username,
            displayName: owned.displayName,
            avatarUrl: owned.avatarUrl,
            profileUrl: owned.profileUrl,
            settings: owned.settings,
            projectCandidates: candidates,
            integrationsAvailable,
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
