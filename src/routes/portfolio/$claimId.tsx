import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { PublicPortfolio } from '~/modules/builder-profile/components/PublicPortfolio'
import type { PublicPortfolio as PublicPortfolioData } from '~/shared/lib/portfolio'
import { ThemeProvider } from '~/shared/lib/theme/ThemeProvider'

const SITE_URL = 'https://builderhunt.dev'
const SITE_NAME = 'BuilderHunt'

// createServerFn + dynamic imports inside .handler() keeps node-only deps
// (postgres, node:crypto via the repository/cache modules) out of the
// client bundle — the exact bug class that crashed hydration app-wide
// earlier this session when a client component imported them directly.
const getPublicPortfolioForRoute = createServerFn({ method: 'GET' })
  .validator(z.string())
  .handler(async ({ data: claimId }): Promise<PublicPortfolioData | null> => {
    const [
      { publicDb },
      { buildPublicPortfolio, parsePortfolioSettings },
      { getCachedPortfolio, setCachedPortfolio },
      { fetchPortfolioProjectCandidates },
      { getPublicPortfolioClaim },
      { env },
    ] = await Promise.all([
      import('~/shared/lib/db/client'),
      import('~/shared/lib/portfolio'),
      import('~/shared/lib/portfolio-cache'),
      import('~/lib/github/content'),
      import('~/shared/lib/repositories/builder-claims'),
      import('~/shared/lib/env'),
    ])
    if (env.PORTFOLIOS_ENABLED === 'false') return null

    const cached = await getCachedPortfolio(claimId)
    if (cached) return cached

    const claim = await getPublicPortfolioClaim(publicDb, claimId)
    if (!claim) return null

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
    if (!portfolio) return null

    await setCachedPortfolio(claimId, portfolio)
    return portfolio
  })

export const Route = createFileRoute('/portfolio/$claimId')({
  loader: async ({ params }) => {
    try {
      const portfolio = await getPublicPortfolioForRoute({ data: params.claimId })
      return { portfolio }
    } catch (err) {
      console.error('Portfolio loader error:', err)
      return { portfolio: null }
    }
  },
  head: ({ loaderData, params }) => {
    const portfolio = loaderData?.portfolio
    const url = `${SITE_URL}/portfolio/${params.claimId}`
    if (!portfolio) {
      return {
        meta: [
          { title: `Portfolio not found — ${SITE_NAME}` },
          { name: 'robots', content: 'noindex' },
        ],
      }
    }
    const name = portfolio.displayName ?? portfolio.username
    const title = portfolio.headline ? `${name} — ${portfolio.headline}` : `${name} — ${SITE_NAME}`
    const description = portfolio.introduction || `${name}'s verified builder portfolio on ${SITE_NAME}.`
    const image = portfolio.avatarUrl ?? `${SITE_URL}/brand/og-image.png`
    return {
      meta: [
        { title },
        { name: 'description', content: description },
        { property: 'og:title', content: title },
        { property: 'og:description', content: description },
        { property: 'og:type', content: 'profile' },
        { property: 'og:url', content: url },
        { property: 'og:image', content: image },
        { name: 'twitter:card', content: 'summary' },
        { name: 'twitter:title', content: title },
        { name: 'twitter:description', content: description },
        { name: 'twitter:image', content: image },
      ],
      links: [{ rel: 'canonical', href: url }],
    }
  },
  component: PortfolioRouteComponent,
})

function PortfolioRouteComponent() {
  const { portfolio } = Route.useLoaderData()
  return (
    <ThemeProvider>
      <PublicPortfolio portfolio={portfolio} />
    </ThemeProvider>
  )
}
