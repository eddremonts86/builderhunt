import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { publicDb } from '~/shared/lib/db/client'
import { env } from '~/shared/lib/env'
import { buildPublicPortfolio, parsePortfolioSettings } from '~/shared/lib/portfolio'
import { getCachedPortfolio, setCachedPortfolio } from '~/shared/lib/portfolio-cache'
import { fetchPortfolioProjectCandidates } from '~/lib/github/content'
import { getPublicPortfolioClaim } from '~/shared/lib/repositories/builder-claims'

/**
 * Fail-closed by construction: every branch that isn't "found, verified,
 * published, schema-valid" returns 404 — never a distinguishable error for
 * "exists but unpublished" vs "doesn't exist" vs "revoked", so this can't be
 * used to enumerate claim ids or their state.
 */
export const Route = createFileRoute('/api/portfolio/$claimId')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ params }) => {
        try {
          if (env.PORTFOLIOS_ENABLED === 'false') {
            return Response.json({ error: 'Not found' }, { status: 404 })
          }

          const cached = await getCachedPortfolio(params.claimId)
          if (cached) return Response.json(cached)

          const claim = await getPublicPortfolioClaim(publicDb, params.claimId)
          if (!claim) return Response.json({ error: 'Not found' }, { status: 404 })

          const settings = parsePortfolioSettings((claim.metadata as Record<string, unknown>).portfolio)
          const candidates = claim.source === 'github'
            ? await fetchPortfolioProjectCandidates(claim.username).catch(() => [])
            : []

          const portfolio = buildPublicPortfolio({
            claimId: claim.claimId,
            source: claim.source,
            username: claim.username,
            displayName: claim.displayName,
            avatarUrl: claim.avatarUrl,
            profileUrl: claim.profileUrl,
            settings,
            projectCandidates: candidates,
          })
          if (!portfolio) return Response.json({ error: 'Not found' }, { status: 404 })

          await setCachedPortfolio(params.claimId, portfolio)
          return Response.json(portfolio)
        } catch (error) {
          console.error('Public portfolio fetch error:', error)
          return Response.json({ error: 'Not found' }, { status: 404 })
        }
      },
    },
  },
})
