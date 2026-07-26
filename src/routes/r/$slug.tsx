import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowRight, Radio, Sparkles } from 'lucide-react'
import { PersonResultCard, type PersonCardData } from '~/modules/search/components/PersonResultCard'
import { resolvePublicRadar, searchPublicBuilders, type PublicSearchBuilder } from '~/shared/lib/public-data'
import { ThemeProvider } from '~/shared/lib/theme/ThemeProvider'
import { LinkButton } from '~/components/ui/link'
import { SITE_URL } from '~/shared/lib/site-url'
const SITE_NAME = 'BuilderHunt'

interface RadarLoaderData {
  queryName: string
  ownerName: string
  results: PublicSearchBuilder[]
}

export const Route = createFileRoute('/r/$slug')({
  loader: async ({ params }): Promise<RadarLoaderData> => {
    const radar = await resolvePublicRadar({ data: params.slug })
    if (!radar) throw notFound()

    let results: PublicSearchBuilder[] = []
    try {
      const all = await searchPublicBuilders({
        data: {
          keywords: radar.keywords,
          sources: radar.sources ?? undefined,
          language: radar.language ?? undefined,
          country: radar.country ?? undefined,
          perPage: 30,
          page: 1,
        },
      })
      results = all.filter((builder) => builder.kind === 'person')
    } catch (err) {
      console.error('Public radar search error:', err)
    }

    return { queryName: radar.queryName, ownerName: radar.ownerName, results }
  },
  head: ({ loaderData, params }) => {
    if (!loaderData) return { meta: [{ title: `Radar not found — ${SITE_NAME}` }] }
    const { queryName, ownerName, results } = loaderData
    const title = `${queryName} — a radar by ${ownerName} — ${SITE_NAME}`
    const description = `${results.length} builders matching "${queryName}", curated by ${ownerName} on ${SITE_NAME}.`
    const url = `${SITE_URL}/r/${params.slug}`
    const ogImage = `${SITE_URL}/api/og/explore?radar=${encodeURIComponent(params.slug)}`
    return {
      meta: [
        { title },
        { name: 'description', content: description },
        { property: 'og:title', content: title },
        { property: 'og:description', content: description },
        { property: 'og:type', content: 'website' },
        { property: 'og:url', content: url },
        { property: 'og:image', content: ogImage },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:title', content: title },
        { name: 'twitter:description', content: description },
        { name: 'twitter:image', content: ogImage },
      ],
    }
  },
  component: PublicRadarPage,
})

function toCardData(builder: PublicSearchBuilder): PersonCardData {
  return {
    id: builder.id,
    username: builder.username,
    displayName: builder.displayName ?? builder.username,
    source: builder.source,
    avatarUrl: builder.avatarUrl ?? null,
    bio: builder.bio ?? null,
    followersCount: builder.followersCount ?? 0,
    profileUrl: builder.profileUrl,
    language: builder.language ?? null,
    country: builder.country ?? null,
    topics: builder.topics ?? [],
    score: builder.score,
  }
}

function PublicRadarPage() {
  const { queryName, ownerName, results } = Route.useLoaderData()

  const itemListJsonLd = results.length > 0 ? {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: queryName,
    numberOfItems: results.length,
    itemListElement: results.slice(0, 20).map((builder, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      url: `${SITE_URL}/builders/${builder.id}`,
      name: builder.displayName ?? builder.username,
    })),
  } : null

  return (
    <ThemeProvider>
      <div className="min-h-screen bg-bh-bg">
        <header className="border-b border-bh-border/60 bg-bh-surface">
          <div className="container flex items-center justify-between py-4">
            <Link to="/" className="text-lg font-bold tracking-tight text-bh-text">{SITE_NAME}</Link>
            <LinkButton to="/auth/sign-up" variant="primary" size="sm">
              Sign up free
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </LinkButton>
          </div>
        </header>

        <main className="container py-10 md:py-14" data-testid="public-radar-page">
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-bh-accent/20 bg-bh-accent/8 px-3 py-1.5 text-xs font-semibold text-bh-accent">
            <Radio className="h-3.5 w-3.5" aria-hidden="true" />
            Radar by {ownerName}
          </div>
          <h1 className="mt-4 max-w-3xl text-balance text-3xl font-bold tracking-tight text-bh-text md:text-5xl">
            {queryName}
          </h1>
          <p className="mt-3 max-w-2xl text-base leading-7 text-bh-text-muted">
            {results.length > 0
              ? `${results.length} builders matching this search, kept fresh by ${SITE_NAME}.`
              : `No builders currently match this search.`}
          </p>

          {results.length > 0 ? (
            <div className="mt-8 grid gap-3 lg:grid-cols-2" data-testid="public-radar-grid">
              {results.map((builder) => <PersonResultCard key={builder.id} builder={toCardData(builder)} />)}
            </div>
          ) : (
            <div className="mt-8 rounded-[28px] border border-bh-border bg-bh-surface p-8 text-center md:p-12" data-testid="public-radar-empty">
              <p className="text-bh-text-muted">Check back soon — this radar refreshes automatically.</p>
            </div>
          )}

          <div className="mt-10 flex flex-col items-start gap-5 rounded-[28px] border border-bh-accent/20 bg-gradient-to-br from-bh-accent/8 to-bh-cyan/8 p-7 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-bh-text">
                <Sparkles className="h-4 w-4 text-bh-accent" aria-hidden="true" />
                Build your own radar
              </h2>
              <p className="mt-1 text-sm text-bh-text-muted">
                Search across 12 sources, save queries, and get alerts when new builders appear.
              </p>
            </div>
            <LinkButton to="/auth/sign-up" variant="primary" className="whitespace-nowrap" data-testid="radar-cta-signup">
              Sign up free
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </LinkButton>
          </div>
        </main>

        {itemListJsonLd && (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd) }}
          />
        )}
      </div>
    </ThemeProvider>
  )
}
