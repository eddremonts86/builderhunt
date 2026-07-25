import * as React from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
  AlertCircle,
  ArrowRight,
  ArrowUpRight,
  BriefcaseBusiness,
  Code2,
  Compass,
  Globe2,
  Network,
  Radio,
  Search,
  Sparkles,
  UsersRound,
} from 'lucide-react'
import { z } from 'zod'
import { PersonResultCard, type PersonCardData } from '~/modules/search/components/PersonResultCard'
import { ResourceResultCard } from './-ResourceResultCard'
import {
  CodebergIcon,
  DevToIcon,
  GithubIcon,
  HackerNewsIcon,
  HuggingFaceIcon,
  NpmIcon,
  RedditIcon,
  StackOverflowIcon,
} from '~/modules/landing/components/BrandIcons'
import { searchPublicBuilders, type PublicSearchBuilder } from '~/shared/lib/public-data'
import { Button, Input, LinkButton } from '~/components/ui'

const SearchSchema = z.object({
  q: z.string().optional().default(''),
  sources: z.string().optional(),
  type: z.enum(['people', 'resources']).optional().default('people'),
})

const FEATURED_QUERY = 'open source maintainers'

export const Route = createFileRoute('/_landing/explore/')({
  validateSearch: SearchSchema,
  loaderDeps: ({ search: { q, sources } }) => ({ q, sources }),
  loader: async ({ deps }) => {
    const { q, sources } = deps
    const cleanQuery = q.trim()
    const hasQuery = cleanQuery.length >= 2
    const sourceArr = sources ? sources.split(',').filter(Boolean) : undefined

    const searchPromise = hasQuery
      ? searchPublicBuilders({
          data: {
            keywords: cleanQuery.split(/\s+/).filter(Boolean),
            sources: sourceArr,
            perPage: 50,
            page: 1,
          },
        })
      : Promise.resolve([] as PublicSearchBuilder[])
    const featuredPromise = !hasQuery
      ? searchPublicBuilders({
          data: {
            keywords: FEATURED_QUERY.split(/\s+/),
            perPage: 6,
            page: 1,
          },
        })
      : Promise.resolve([] as PublicSearchBuilder[])

    const [searchOutcome, featuredOutcome] = await Promise.allSettled([
      searchPromise,
      featuredPromise,
    ])
    const searchResults = searchOutcome.status === 'fulfilled' ? searchOutcome.value : []
    const featuredBuilders = featuredOutcome.status === 'fulfilled' ? featuredOutcome.value : []

    if (searchOutcome.status === 'rejected') {
      console.error('explore search error:', searchOutcome.reason)
    }
    if (featuredOutcome.status === 'rejected') {
      console.error('explore featured builders error:', featuredOutcome.reason)
    }

    return {
      results: searchResults.slice(0, 20),
      featured: featuredBuilders.filter((builder) => builder.kind === 'person').slice(0, 6),
      query: q,
      sources: sources ?? '',
    }
  },
  head: ({ loaderData }) => {
    const q = loaderData?.query?.trim() ?? ''
    const count = loaderData?.results?.length ?? 0
    const title = q
      ? `${count > 0 ? count : ''} results for ${q} — BuilderHunt`.replace(/\s+/g, ' ').trim()
      : 'Explore — BuilderHunt'
    const description = q
      ? `Discover people and technical resources related to ${q} across GitHub, Hacker News, Reddit, DEV.to, npm and more.`
      : 'Discover active developers and technical resources across the open web. Free during public beta.'
    const ogUrl = q
      ? `${typeof window !== 'undefined' ? window.location.origin : 'https://builderhunt.dev'}/api/og/explore?q=${encodeURIComponent(q)}`
      : `${typeof window !== 'undefined' ? window.location.origin : 'https://builderhunt.dev'}/brand/og-image.png`
    return {
      meta: [
        { title },
        { name: 'description', content: description },
        { property: 'og:title', content: title },
        { property: 'og:description', content: description },
        { property: 'og:image', content: ogUrl },
        { property: 'og:type', content: 'website' },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:title', content: title },
        { name: 'twitter:description', content: description },
        { name: 'twitter:image', content: ogUrl },
      ],
    }
  },
  component: ExplorePage,
})

const EXPLORE_INTENTS = [
  {
    title: 'Find technical talent',
    description: 'Surface active developers with visible work, not polished résumés.',
    query: 'typescript developer',
    Icon: BriefcaseBusiness,
  },
  {
    title: 'Grow an open-source project',
    description: 'Meet maintainers and contributors already working in your ecosystem.',
    query: 'open source maintainers',
    Icon: Network,
  },
  {
    title: 'Map an emerging stack',
    description: 'See who is building around a language, runtime, or new protocol.',
    query: 'rust async runtime',
    Icon: Code2,
  },
  {
    title: 'Find developer voices',
    description: 'Discover technical writers and community builders with real reach.',
    query: 'developer advocates',
    Icon: Radio,
  },
]

const POPULAR_QUERIES = [
  'AI agents in production',
  'react performance',
  'kubernetes operators',
  'postgres extensions',
  'indie hackers',
]

const SOURCES = [
  { label: 'GitHub', Icon: GithubIcon },
  { label: 'Hacker News', Icon: HackerNewsIcon },
  { label: 'Reddit', Icon: RedditIcon },
  { label: 'DEV.to', Icon: DevToIcon },
  { label: 'npm', Icon: NpmIcon },
  { label: 'Hugging Face', Icon: HuggingFaceIcon },
  { label: 'Stack Overflow', Icon: StackOverflowIcon },
  { label: 'Codeberg', Icon: CodebergIcon },
]

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

function ExplorePage() {
  const data = Route.useLoaderData()
  const { type } = Route.useSearch()

  return <ExplorePageContent key={`${data.query}:${data.sources}`} {...data} resultType={type} />
}

interface ExplorePageContentProps {
  results: PublicSearchBuilder[]
  featured: PublicSearchBuilder[]
  query: string
  sources: string
  resultType: 'people' | 'resources'
}

function ExplorePageContent({ results, featured, query, sources, resultType }: ExplorePageContentProps) {
  const navigate = useNavigate({ from: Route.fullPath })
  const [input, setInput] = React.useState(query ?? '')
  const hasQuery = query.trim().length >= 2

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = input.trim()
    if (trimmed.length < 2) return
    navigate({ search: { q: trimmed, sources: sources || undefined, type: resultType } })
  }

  const people = results.filter((builder) => builder.kind === 'person')
  const resources = results.filter((builder) => builder.kind === 'repo')
  const activeResults = resultType === 'people' ? people : resources
  const activeLabel = resultType === 'people' ? 'People' : 'Resources'
  const heroTitle = resultType === 'resources' && hasQuery
    ? 'Find the work shaping what\'s next.'
    : 'Find the people building what\'s next.'
  const heroDescription = resultType === 'resources' && hasQuery
    ? 'Search repositories, packages, models, and projects across the open technical web.'
    : 'Search active developers across the communities where technical work actually happens.'

  const itemListJsonLd = hasQuery && activeResults.length > 0 ? {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `${query} ${activeLabel.toLowerCase()}`,
    numberOfItems: activeResults.length,
    itemListElement: activeResults.slice(0, 20).map((builder, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      url: typeof window !== 'undefined'
        ? `${window.location.origin}/builders/${builder.id}`
        : `https://builderhunt.dev/builders/${builder.id}`,
      name: builder.displayName ?? builder.username,
    })),
  } : null

  return (
    <div className="container pb-20 pt-8 md:pt-12" data-testid="explore-page">
      <section
        className={`relative isolate overflow-hidden border border-bh-border/70 bg-bh-surface shadow-[0_24px_80px_-44px_rgba(24,24,27,0.35)] ${hasQuery ? 'rounded-[28px] px-5 py-8 md:px-10' : 'rounded-[32px] px-5 py-12 md:px-12 md:py-16'}`}
      >
        <div className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-bh-accent/10 blur-3xl" aria-hidden="true" />
        <div className="pointer-events-none absolute -bottom-32 left-1/4 h-64 w-64 rounded-full bg-bh-cyan/10 blur-3xl" aria-hidden="true" />

        <div className="relative max-w-4xl">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-bh-accent/20 bg-bh-accent/8 px-3 py-1.5 text-xs font-semibold text-bh-accent">
            <Compass className="h-3.5 w-3.5" aria-hidden="true" />
            Open-web talent discovery
          </div>
          <h1 className={`${hasQuery ? 'text-3xl md:text-4xl' : 'text-4xl md:text-6xl'} max-w-3xl text-balance font-bold tracking-[-0.04em] text-bh-text`}>
            {heroTitle}
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-bh-text-muted md:text-lg">
            {heroDescription}
          </p>

          <form onSubmit={submit} className="mt-8" data-testid="explore-form">
            <label htmlFor="explore-query" className="mb-2 block text-sm font-semibold text-bh-text">
              What kind of builder are you looking for?
            </label>
            <div className="flex flex-col gap-3 rounded-2xl border border-bh-border bg-bh-surface p-2 shadow-[0_12px_32px_-18px_rgba(24,24,27,0.3)] sm:flex-row">
              <div className="relative min-w-0 flex-1">
                <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-bh-text-dim" aria-hidden="true" />
                <Input
                  id="explore-query"
                  name="query"
                  type="search"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="Try “rust async runtime” or “developer advocates”…"
                  autoComplete="off"
                  className="h-12 w-full !rounded-xl !border-0 !bg-transparent !pl-12 !pr-4 !py-0 !shadow-none text-base text-bh-text outline-none placeholder:text-bh-text-dim focus-visible:ring-2 focus-visible:ring-bh-accent/30"
                  data-testid="explore-input"
                />
              </div>
              <Button type="submit" className="min-h-12 whitespace-nowrap px-6" data-testid="explore-submit">
                Search builders
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </form>
        </div>
      </section>

      {!hasQuery && (
        <>
          <section className="border-x border-b-bh-border/60 px-5 py-6 md:px-10" data-testid="explore-sources" aria-labelledby="explore-sources-title">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 id="explore-sources-title" className="text-sm font-semibold text-bh-text">Search across 12 communities</h2>
                <p className="mt-1 text-sm text-bh-text-muted">Compare activity across code, conversation, publishing, and packages.</p>
              </div>
              <ul className="flex flex-wrap items-center gap-x-5 gap-y-3" aria-label="Supported sources">
                {SOURCES.map(({ label, Icon }) => (
                  <li key={label} className="flex items-center gap-1.5 text-xs font-medium text-bh-text-muted" title={label}>
                    <span aria-hidden="true"><Icon className="h-4 w-4" /></span>
                    <span>{label}</span>
                  </li>
                ))}
                <li className="text-xs font-semibold text-bh-accent">+4 more</li>
              </ul>
            </div>
          </section>

          <section className="py-14 md:py-18" data-testid="explore-intents" aria-labelledby="explore-intents-title">
            <div className="max-w-2xl">
              <h2 id="explore-intents-title" className="text-2xl font-bold tracking-tight text-bh-text md:text-3xl">Start with what you need</h2>
              <p className="mt-2 text-bh-text-muted">Choose a search direction, then refine it with your own technical context.</p>
            </div>
            <div className="mt-7 grid gap-4 md:grid-cols-2">
              {EXPLORE_INTENTS.map(({ title, description, query: intentQuery, Icon }) => (
                <Link
                  key={title}
                  to="/explore"
                  search={{ q: intentQuery }}
                  className="group min-h-44 rounded-3xl border border-bh-border bg-bh-surface p-6 text-left shadow-[0_12px_30px_-24px_rgba(24,24,27,0.32)] transition-[transform,border-color,box-shadow] hover:-translate-y-1 hover:border-bh-accent/35 hover:shadow-[0_20px_44px_-26px_rgba(224,115,56,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 active:translate-y-0 motion-reduce:transform-none"
                  aria-label={`${title}: search for ${intentQuery}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-bh-accent/10 text-bh-accent">
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <ArrowUpRight className="h-5 w-5 text-bh-text-dim transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 motion-reduce:transform-none" aria-hidden="true" />
                  </div>
                  <h3 className="mt-7 text-lg font-semibold text-bh-text">{title}</h3>
                  <p className="mt-1.5 max-w-md text-sm leading-6 text-bh-text-muted">{description}</p>
                  <span className="mt-4 inline-flex rounded-lg bg-bh-surface-2 px-2.5 py-1 text-xs font-medium text-bh-text-muted">{intentQuery}</span>
                </Link>
              ))}
            </div>
          </section>

          <section className="rounded-[32px] border border-bh-border bg-bh-surface p-5 md:p-8" data-testid="explore-featured" aria-labelledby="explore-featured-title">
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="flex items-center gap-2 text-bh-accent">
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                  <span className="text-xs font-semibold">Live from the index</span>
                </div>
                <h2 id="explore-featured-title" className="mt-2 text-2xl font-bold tracking-tight text-bh-text">Builders worth discovering</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-bh-text-muted">A live sample of maintainers and contributors found across the open web.</p>
              </div>
              <LinkButton to="/explore" search={{ q: FEATURED_QUERY }} variant="secondary" className="whitespace-nowrap self-start md:self-auto">
                View all maintainers
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </LinkButton>
            </div>

            {featured.length > 0 ? (
              <div className="mt-7 grid gap-3 lg:grid-cols-2">
                {featured.map((builder) => (
                  <PersonResultCard key={builder.id} builder={toCardData(builder)} />
                ))}
              </div>
            ) : (
              <div className="mt-7 grid gap-3 sm:grid-cols-3">
                {[
                  { Icon: UsersRound, title: 'People, not repositories', text: 'Profiles are ranked around visible builder activity.' },
                  { Icon: Globe2, title: 'Cross-community signal', text: 'Find work that a single platform search would miss.' },
                  { Icon: Sparkles, title: 'Context before outreach', text: 'Understand interests, reach, and recent contribution signals.' },
                ].map(({ Icon, title, text }) => (
                  <div key={title} className="rounded-2xl bg-bh-surface-2 p-5">
                    <Icon className="h-5 w-5 text-bh-accent" aria-hidden="true" />
                    <h3 className="mt-4 text-sm font-semibold text-bh-text">{title}</h3>
                    <p className="mt-1.5 text-xs leading-5 text-bh-text-muted">{text}</p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-5 py-12 md:flex-row md:items-center md:justify-between" data-testid="explore-popular">
            <div>
              <h2 className="text-lg font-semibold text-bh-text">Or try a focused search</h2>
              <p className="mt-1 text-sm text-bh-text-muted">Specific technology and intent produce stronger matches.</p>
            </div>
            <div className="flex max-w-2xl flex-wrap gap-2">
              {POPULAR_QUERIES.map((popularQuery) => (
                <LinkButton
                  key={popularQuery}
                  to="/explore"
                  search={{ q: popularQuery }}
                  variant="secondary"
                  size="sm"
                  data-testid={`explore-popular-${popularQuery.replace(/\s+/g, '-')}`}
                >
                  {popularQuery}
                </LinkButton>
              ))}
            </div>
          </section>
        </>
      )}

      {hasQuery && (
        <section className="py-10" data-testid="explore-results" aria-labelledby="explore-results-title">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm font-medium text-bh-accent">Search results</p>
              <h2 id="explore-results-title" className="mt-1 text-balance text-2xl font-bold tracking-tight text-bh-text md:text-3xl">
                {activeResults.length > 0 ? `${activeLabel} matching “${query}”` : `No ${activeLabel.toLowerCase()} matching “${query}”`}
              </h2>
            </div>
            {results.length > 0 && <span className="text-sm text-bh-text-muted">{results.length} indexed matches</span>}
          </div>

          {results.length > 0 && (
            <nav className="my-6 flex w-fit rounded-xl border border-bh-border bg-bh-surface p-1" role="tablist" aria-label="Result type">
              <Link
                to="/explore"
                search={{ q: query, sources: sources || undefined, type: 'people' }}
                id="explore-tab-people"
                role="tab"
                aria-selected={resultType === 'people'}
                aria-controls="explore-result-panel"
                className={`inline-flex min-h-10 items-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent ${resultType === 'people' ? 'bg-bh-accent text-[color:var(--color-bh-accent-contrast)] shadow-sm' : 'text-bh-text-muted hover:bg-bh-surface-2 hover:text-bh-text'}`}
                data-testid="explore-tab-people"
              >
                People
                <span className={`rounded-full px-2 py-0.5 text-xs tabular-nums ${resultType === 'people' ? 'bg-[color:var(--color-bh-accent-contrast)]/15 text-[color:var(--color-bh-accent-contrast)]' : 'bg-bh-surface-2 text-bh-text-dim'}`}>{people.length}</span>
              </Link>
              <Link
                to="/explore"
                search={{ q: query, sources: sources || undefined, type: 'resources' }}
                id="explore-tab-resources"
                role="tab"
                aria-selected={resultType === 'resources'}
                aria-controls="explore-result-panel"
                className={`inline-flex min-h-10 items-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent ${resultType === 'resources' ? 'bg-bh-accent text-[color:var(--color-bh-accent-contrast)] shadow-sm' : 'text-bh-text-muted hover:bg-bh-surface-2 hover:text-bh-text'}`}
                data-testid="explore-tab-resources"
              >
                Resources
                <span className={`rounded-full px-2 py-0.5 text-xs tabular-nums ${resultType === 'resources' ? 'bg-[color:var(--color-bh-accent-contrast)]/15 text-[color:var(--color-bh-accent-contrast)]' : 'bg-bh-surface-2 text-bh-text-dim'}`}>{resources.length}</span>
              </Link>
            </nav>
          )}

          <div
            id="explore-result-panel"
            role="tabpanel"
            aria-labelledby={`explore-tab-${resultType}`}
          >
          {results.length === 0 ? (
            <div className="rounded-[28px] border border-bh-border bg-bh-surface p-8 text-center md:p-12" data-testid="explore-empty">
              <AlertCircle className="mx-auto h-8 w-8 text-bh-warning" aria-hidden="true" />
              <h3 className="mt-4 text-lg font-semibold text-bh-text">Try widening the search</h3>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-bh-text-muted">Use a technology, role, or community instead of a very specific phrase.</p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {POPULAR_QUERIES.slice(0, 3).map((popularQuery) => (
                  <LinkButton key={popularQuery} to="/explore" search={{ q: popularQuery }} variant="secondary" size="sm">
                    {popularQuery}
                  </LinkButton>
                ))}
              </div>
            </div>
          ) : activeResults.length === 0 ? (
            <div className="rounded-[28px] border border-bh-border bg-bh-surface p-8 text-center md:p-12" data-testid="explore-type-empty">
              <h3 className="text-lg font-semibold text-bh-text">No {activeLabel.toLowerCase()} in this search</h3>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-bh-text-muted">
                {resultType === 'people'
                  ? `This search found ${resources.length} resources. Open the Resources tab to explore them.`
                  : `This search found ${people.length} people. Open the People tab or try a repository-focused query.`}
              </p>
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2" data-testid="explore-grid">
              {activeResults.map((builder) => resultType === 'people'
                ? <PersonResultCard key={builder.id} builder={toCardData(builder)} />
                : <ResourceResultCard key={builder.id} resource={builder} />)}
            </div>
          )}

          {activeResults.length > 0 && (
            <div className="mt-8 flex flex-col items-start gap-5 rounded-[28px] border border-bh-accent/20 bg-gradient-to-br from-bh-accent/8 to-bh-cyan/8 p-7 md:flex-row md:items-center md:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-bh-text">Keep this search working for you</h3>
                <p className="mt-1 text-sm text-bh-text-muted">Save “{query}” and get alerts when new builders appear.</p>
              </div>
              <Link
                to="/auth/sign-up"
                search={{ next: `/search?q=${encodeURIComponent(query)}` }}
                className="btn-primary whitespace-nowrap"
                data-testid="explore-cta-signup"
              >
                Sign up free
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          )}
          </div>
        </section>
      )}

      {itemListJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd) }}
        />
      )}
    </div>
  )
}
