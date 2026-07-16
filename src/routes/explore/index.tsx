import * as React from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Search, Sparkles, ArrowRight, AlertCircle } from 'lucide-react'
import { z } from 'zod'
import { searchBuilders } from '~/lib/search'
import { PersonResultCard, type PersonCardData } from '~/modules/search/components/PersonResultCard'
import type { ScoredBuilder } from '~/lib/search'

const SearchSchema = z.object({
  q: z.string().optional().default(''),
  sources: z.string().optional(),
})

export const Route = createFileRoute('/explore/')({
  validateSearch: SearchSchema,
  loaderDeps: ({ search: { q, sources } }) => ({ q, sources }),
  loader: async ({ deps }) => {
    const { q, sources } = deps
    if (!q || q.trim().length < 2) {
      return { results: [], query: q, sources: sources ?? '' }
    }
    try {
      const list = sources
        ? q.split(/\s+/).map((kw) => kw).filter(Boolean)
        : q.split(/\s+/)
      const sourceArr = sources ? sources.split(',').filter(Boolean) : undefined
      const builders = await searchBuilders({
        keywords: list,
        sources: sourceArr,
        perPage: 50, // search a larger pool so we can show top 20
        page: 1,
      })
      return { results: builders.slice(0, 20), query: q, sources: sources ?? '' }
    } catch (err) {
      console.error('explore search error:', err)
      return { results: [], query: q, sources: sources ?? '' }
    }
  },
  head: ({ loaderData }) => {
    const q = loaderData?.query?.trim() ?? ''
    const count = loaderData?.results?.length ?? 0
    const title = q
      ? `${count > 0 ? count : ''} ${q} developers — BuilderHunt`.replace(/\s+/g, ' ').trim()
      : 'Explore — BuilderHunt'
    const description = q
      ? `Discover active ${q} developers across GitHub, Hacker News, Reddit, DEV.to, npm and more. Free during public beta.`
      : 'Discover active open-source developers across the open web. Free during public beta.'
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

const POPULAR_QUERIES = [
  'rust async runtime',
  'react server components',
  'typescript developer',
  'ai engineers',
  'kubernetes operators',
  'svelte',
  'deno runtime',
  'webassembly',
  'open source maintainers',
  'indie hackers',
  'postgres extensions',
  'edge computing',
]

function toCardData(b: ScoredBuilder): PersonCardData {
  return {
    id: b.id,
    username: b.username,
    displayName: b.displayName ?? b.username,
    source: b.source,
    avatarUrl: b.avatarUrl ?? null,
    bio: b.bio ?? null,
    followersCount: b.followersCount ?? 0,
    profileUrl: b.profileUrl,
    language: b.language ?? null,
    country: b.country ?? null,
    topics: b.topics ?? [],
    score: b.score,
  }
}

function ExplorePage() {
  const { results, query, sources } = Route.useLoaderData()
  const navigate = useNavigate({ from: Route.fullPath })
  const [input, setInput] = React.useState(query ?? '')

  React.useEffect(() => { setInput(query ?? '') }, [query])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = input.trim()
    if (trimmed.length < 2) return
    navigate({
      search: { q: trimmed, sources: sources || undefined },
    })
  }

  const itemListJsonLd = query && results.length > 0 ? {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `${query} developers`,
    numberOfItems: results.length,
    itemListElement: results.slice(0, 20).map((b, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: typeof window !== 'undefined'
        ? `${window.location.origin}/builders/${b.id}`
        : `https://builderhunt.dev/builders/${b.id}`,
      name: b.displayName ?? b.username,
    })),
  } : null

  return (
    <div className="min-h-[calc(100vh-4rem)] p-6 max-w-5xl mx-auto" data-testid="explore-page">
      <header className="mb-6">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-2 flex items-center gap-3">
          <Sparkles className="w-7 h-7 text-bh-accent" aria-hidden="true" />
          Explore
        </h1>
        <p className="text-bh-text-muted">
          Search across 12 sources: GitHub, Hacker News, Reddit, DEV.to, npm, Hugging Face, Stack Overflow and more.
        </p>
      </header>

      {/* Search box */}
      <form onSubmit={submit} className="mb-6" data-testid="explore-form">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-bh-text-dim" aria-hidden="true" />
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder='Try "rust async runtime" or "react"'
              className="input w-full pl-9"
              data-testid="explore-input"
              autoFocus
            />
          </div>
          <button type="submit" className="btn-primary" data-testid="explore-submit">
            Search
          </button>
        </div>
      </form>

      {/* Results */}
      {query && query.length >= 2 && (
        <section data-testid="explore-results">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim">
              {results.length > 0
                ? `${results.length} ${query} developers`
                : `No results for "${query}"`}
            </h2>
            {results.length > 0 && (
              <span className="text-xs text-bh-text-dim">
                Top {Math.min(results.length, 20)}
              </span>
            )}
          </div>

          {results.length === 0 && (
            <div className="card text-center py-12" data-testid="explore-empty">
              <AlertCircle className="w-8 h-8 text-bh-warning mx-auto mb-3" aria-hidden="true" />
              <p className="text-bh-text-muted mb-2">No builders found for "{query}".</p>
              <p className="text-xs text-bh-text-dim">
                Try a broader query or check the spelling.
              </p>
            </div>
          )}

          {results.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="explore-grid">
              {results.slice(0, 20).map((b) => (
                <PersonResultCard key={b.id} builder={toCardData(b)} />
              ))}
            </div>
          )}

          {results.length > 0 && (
            <div className="card mt-6 text-center p-6 bg-gradient-to-br from-bh-accent/5 to-bh-cyan/5 border-bh-accent/20">
              <h3 className="text-lg font-semibold mb-1">Save this radar</h3>
              <p className="text-sm text-bh-text-muted mb-4">
                Sign up free to save "{query}" and get daily alerts when new builders appear.
              </p>
              <Link
                to="/auth/sign-up"
                search={{ next: `/search?q=${encodeURIComponent(query)}` }}
                className="btn-primary inline-flex"
                data-testid="explore-cta-signup"
              >
                Sign up free
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </Link>
            </div>
          )}
        </section>
      )}

      {/* Empty state — popular queries */}
      {(!query || query.length < 2) && (
        <section data-testid="explore-popular">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-3">
            Popular searches
          </h2>
          <div className="flex flex-wrap gap-2">
            {POPULAR_QUERIES.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => {
                  setInput(q)
                  navigate({ search: { q, sources: undefined } })
                }}
                className="btn-secondary btn-sm"
                data-testid={`explore-popular-${q.replace(/\s+/g, '-')}`}
              >
                {q}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* JSON-LD structured data */}
      {itemListJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd) }}
        />
      )}
    </div>
  )
}
