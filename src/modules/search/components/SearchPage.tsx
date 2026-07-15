import * as React from 'react'
import {
  Search, X, Bookmark, ExternalLink, Code, Filter, Clock, Hash,
  TrendingUp, Activity, Save, Lightbulb, ChevronDown, Sparkles,
  Users, BookMarked, Star, GitFork, Loader2,
} from 'lucide-react'
import { Input, Button, ScoreRing, getScoreBreakdown } from '~/components/ui'
import { GithubIcon, RedditIcon, HackerNewsIcon, DevToIcon, LobstersIcon, StackOverflowIcon, NpmIcon, HuggingFaceIcon, GitLabIcon, CodebergIcon, HashnodeIcon } from '~/modules/landing/components/BrandIcons'

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */
type BuilderKind = 'person' | 'repo'

interface Builder {
  id: string
  kind: BuilderKind
  source: 'github' | 'reddit' | 'hn' | 'devto' | 'lobsters' | 'stackoverflow' | 'npm' | 'huggingface' | 'gitlab' | 'codeberg' | 'hashnode'
  username: string
  displayName?: string
  avatarUrl?: string
  bio?: string
  profileUrl: string
  followersCount?: number
  topics?: string[]
  score?: number
  lastSeen?: string
  language?: string
  country?: string
}

type Source = Builder['source']
type SortBy = 'score' | 'recency' | 'followers'
type ResultTab = 'people' | 'resources'

/** All supported sources. Visible in the source-pills UI. */
const ALL_SOURCES: Source[] = ['github', 'reddit', 'hn', 'devto', 'lobsters', 'stackoverflow', 'npm', 'huggingface', 'gitlab', 'codeberg', 'hashnode']
/** Sources that are ON by default. Niche sources are opt-in. */
const DEFAULT_ACTIVE_SOURCES: Source[] = ['github', 'reddit', 'hn', 'devto', 'lobsters']

const SOURCE_META: Record<Source, { label: string; color: string; Icon: React.ComponentType<{ className?: string; title?: string }> }> = {
  github: { label: 'GitHub', color: 'badge-github', Icon: GithubIcon },
  reddit: { label: 'Reddit', color: 'badge-reddit', Icon: RedditIcon },
  hn: { label: 'Hacker News', color: 'badge-hn', Icon: HackerNewsIcon },
  devto: { label: 'DEV.to', color: 'badge-devto', Icon: DevToIcon },
  lobsters: { label: 'Lobsters', color: 'badge-lobsters', Icon: LobstersIcon },
  stackoverflow: { label: 'Stack Overflow', color: 'badge-stackoverflow', Icon: StackOverflowIcon },
  npm: { label: 'npm', color: 'badge-npm', Icon: NpmIcon },
  huggingface: { label: 'Hugging Face', color: 'badge-huggingface', Icon: HuggingFaceIcon },
  gitlab: { label: 'GitLab', color: 'badge-gitlab', Icon: GitLabIcon },
  codeberg: { label: 'Codeberg', color: 'badge-codeberg', Icon: CodebergIcon },
  hashnode: { label: 'Hashnode', color: 'badge-hashnode', Icon: HashnodeIcon },
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */
const POPULAR_QUERIES = [
  { label: 'rust async runtime', emoji: '⚡' },
  { label: 'AI agents in production', emoji: '🤖' },
  { label: 'indie hackers in EU', emoji: '🚀' },
  { label: 'kubernetes operators', emoji: '☸️' },
  { label: 'svelte developers', emoji: '🔥' },
  { label: 'python ML engineers', emoji: '🧠' },
  { label: 'react performance', emoji: '⚛️' },
  { label: 'open source maintainers', emoji: '🛠️' },
]

const PRO_TIPS = [
  { icon: Hash, text: 'Combine 2-3 keywords for sharper results (e.g. "rust", "async", "tokio")' },
  { icon: Filter, text: 'Toggle the source pills above to narrow down to one platform' },
  { icon: Bookmark, text: 'Save searches to get alerts the moment a new builder shows up' },
]

const RECENT_KEY = 'builderhunt.recent_searches'
const MAX_RECENT = 5

/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */
export function SearchPage() {
  const [query, setQuery] = React.useState('')
  const [location, setLocation] = React.useState('')
  const [language, setLanguage] = React.useState('')
  const [filtersOpen, setFiltersOpen] = React.useState(false)
  const [results, setResults] = React.useState<Builder[]>([])
  const [loading, setLoading] = React.useState(false)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [page, setPage] = React.useState(1)
  const [hasMore, setHasMore] = React.useState(true)
  const sentinelRef = React.useRef<HTMLDivElement>(null)
  const [searched, setSearched] = React.useState(false)
  const [activeSources, setActiveSources] = React.useState<Set<Source>>(
    new Set(DEFAULT_ACTIVE_SOURCES),
  )
  const [sortBy, setSortBy] = React.useState<SortBy>('score')
  const [activeTab, setActiveTab] = React.useState<ResultTab>('people')
  const [recent, setRecent] = React.useState<string[]>([])
  const [showSave, setShowSave] = React.useState(false)
  const [saveName, setSaveName] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [saveMsg, setSaveMsg] = React.useState<{ ok: boolean; text: string } | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const inputRef = React.useRef<HTMLInputElement>(null)

  /* Mount: load recent searches from localStorage */
  React.useEffect(() => {
    try {
      const stored = localStorage.getItem(RECENT_KEY)
      if (stored) setRecent(JSON.parse(stored))
    } catch {
      // ignore
    }
  }, [])

  /* ⌘K / Ctrl+K to focus search */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
      if (e.key === 'Escape' && document.activeElement === inputRef.current) {
        if (query) {
          setQuery('')
        } else {
          inputRef.current?.blur()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [query])

  /* Re-run search when active sources change (after first search) */
  const initialSourcesRef = React.useRef<string>('')
  React.useEffect(() => {
    const sig = Array.from(activeSources).sort().join(',')
    if (initialSourcesRef.current === '') {
      initialSourcesRef.current = sig
      return
    }
    if (initialSourcesRef.current !== sig && searched && query.trim()) {
      initialSourcesRef.current = sig
      runSearch(query)
    }
  }, [activeSources]) // eslint-disable-line react-hooks/exhaustive-deps

  /* Persist recent searches */
  const rememberSearch = React.useCallback((q: string) => {
    if (!q.trim()) return
    setRecent((prev) => {
      const next = [q, ...prev.filter((x) => x !== q)].slice(0, MAX_RECENT)
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next))
      } catch {
        // ignore
      }
      return next
    })
  }, [])

  const clearRecent = () => {
    setRecent([])
    try {
      localStorage.removeItem(RECENT_KEY)
    } catch {
      // ignore
    }
  }

  /* Search */
  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault()
    const q = query.trim()
    if (!q) return
    await runSearch(q)
  }

  const runSearch = async (q: string) => {
    setLoading(true)
    setSearched(true)
    setShowSave(false)
    setSaveMsg(null)
    setError(null)
    setPage(1)
    setHasMore(true)
    rememberSearch(q)
    try {
      const res = await fetch('/api/search/builders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keywords: q,
          sources: Array.from(activeSources),
          country: location.trim() || undefined,
          language: language.trim() || undefined,
          page: 1,
          perPage: 30,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setResults(data.builders ?? [])
      setHasMore(Boolean(data.hasMore) && (data.builders?.length ?? 0) > 0)
    } catch (e: any) {
      setError(e.message ?? 'Search failed. Please try again.')
      setResults([])
      setHasMore(false)
    } finally {
      setLoading(false)
    }
  }

  // Infinite scroll: load next page when sentinel intersects viewport.
  const loadMore = React.useCallback(async () => {
    if (loadingMore || !hasMore || loading || !searched) return
    setLoadingMore(true)
    try {
      const next = page + 1
      const res = await fetch('/api/search/builders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keywords: query,
          sources: Array.from(activeSources),
          country: location.trim() || undefined,
          language: language.trim() || undefined,
          page: next,
          perPage: 30,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const newOnes: Builder[] = data.builders ?? []
      // Dedupe by id (server should already dedup, but safety)
      setResults((prev) => {
        const seen = new Set(prev.map((b) => b.id))
        return [...prev, ...newOnes.filter((b) => !seen.has(b.id))]
      })
      setPage(next)
      setHasMore(Boolean(data.hasMore) && newOnes.length > 0)
    } catch {
      setHasMore(false)
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, hasMore, loading, searched, page, query, activeSources, location, language])

  React.useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) loadMore()
        }
      },
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [loadMore])

  /* Split results by kind */
  const people = React.useMemo(() => results.filter((b) => b.kind === 'person'), [results])
  const resources = React.useMemo(() => results.filter((b) => b.kind !== 'person'), [results])

  /* Sort the active tab's results */
  const sorted = React.useMemo(() => {
    const list = activeTab === 'people' ? people : resources
    const copy = [...list]
    if (sortBy === 'recency') {
      copy.sort((a, b) => (b.lastSeen ? Date.parse(b.lastSeen) : 0) - (a.lastSeen ? Date.parse(a.lastSeen) : 0))
    } else if (sortBy === 'followers') {
      copy.sort((a, b) => (b.followersCount ?? 0) - (a.followersCount ?? 0))
    } else {
      copy.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    }
    return copy
  }, [people, resources, sortBy, activeTab])

  /* Source toggle */
  const toggleSource = (s: Source) => {
    setActiveSources((prev) => {
      const next = new Set(prev)
      if (next.has(s)) {
        // Don't allow disabling all sources
        if (next.size === 1) return prev
        next.delete(s)
      } else {
        next.add(s)
      }
      return next
    })
  }

  /* Save search */
  const handleSaveSearch = async () => {
    if (!saveName.trim() || !query.trim()) return
    setSaving(true)
    setSaveMsg(null)
    try {
      const keywords = query.split(/[,\s]+/).filter(Boolean)
      const res = await fetch('/api/queries', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: saveName,
          keywords,
          sources: Array.from(activeSources),
          country: location.trim() || undefined,
          language: language.trim() || undefined,
        }),
      })
      if (res.ok) {
        setSaveMsg({ ok: true, text: 'Search saved! You\'ll get alerts when new matches appear.' })
        setSaveName('')
        setShowSave(false)
        setTimeout(() => setSaveMsg(null), 4000)
      } else {
        const err = await res.json().catch(() => ({}))
        setSaveMsg({ ok: false, text: err.error ?? 'Failed to save. Make sure you are signed in.' })
      }
    } catch {
      setSaveMsg({ ok: false, text: 'Failed to save search.' })
    } finally {
      setSaving(false)
    }
  }

  /* ---------------------------------------------------------------------- */

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto">
      {/* Header */}
      <header className="mb-8">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-1">
          Search builders
        </h1>
        <p className="text-bh-text-muted">
          Find active developers across{' '}
          {ALL_SOURCES.map((s, i) => (
            <React.Fragment key={s}>
              <span className="text-bh-text font-medium">{SOURCE_META[s].label}</span>
              {i < ALL_SOURCES.length - 1 && ', '}
            </React.Fragment>
          ))}
          .
        </p>
      </header>

      {/* Search input + filters */}
      <form onSubmit={handleSearch} className="mb-6" role="search" aria-label="Search builders">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search
              className="absolute left-5 top-1/2 -translate-y-1/2 w-5 h-5 text-bh-text-dim pointer-events-none"
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. rust async runtime, indie hackers, AI agents..."
              className="input-field !pl-14 pr-32 py-3.5 text-base"
              aria-label="Search keywords"
              autoComplete="off"
            />
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(''); inputRef.current?.focus() }}
                className="absolute right-4 top-1/2 -translate-y-1/2 p-1 text-bh-text-dim hover:text-bh-text rounded"
                aria-label="Clear search"
              >
                <X className="w-4 h-4" />
              </button>
            )}
            {!query && (
              <kbd className="hidden sm:flex absolute right-4 top-1/2 -translate-y-1/2 items-center gap-1 px-2 py-0.5 rounded border border-bh-border bg-bh-bg-alt text-[10px] font-mono text-bh-text-dim">
                ⌘K
              </kbd>
            )}
          </div>
          <Button
            type="submit"
            disabled={loading || !query.trim()}
            loading={loading}
            size="md"
            className="px-6"
          >
            {loading ? 'Searching' : 'Search'}
          </Button>
        </div>

        {/* Source filter pills */}
        <div className="flex flex-wrap items-center gap-2 mt-4">
          <span className="text-xs font-semibold text-bh-text-dim uppercase tracking-wider mr-1">
            Sources
          </span>
          {ALL_SOURCES.map((s) => {
            const meta = SOURCE_META[s]
            const active = activeSources.has(s)
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleSource(s)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${
                  active
                    ? `${meta.color} shadow-sm`
                    : 'bg-transparent text-bh-text-dim border-bh-border hover:border-bh-border-strong hover:text-bh-text-muted'
                }`}
                aria-pressed={active}
              >
                <meta.Icon className="w-3.5 h-3.5" title={meta.label} />
                {meta.label}
              </button>
            )
          })}

          {/* Filters toggle */}
          <button
            type="button"
            onClick={() => setFiltersOpen((o) => !o)}
            className={`ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${
              filtersOpen || location || language
                ? 'bg-bh-accent-soft text-bh-accent border-bh-accent/30'
                : 'bg-transparent text-bh-text-dim border-bh-border hover:border-bh-border-strong hover:text-bh-text-muted'
            }`}
            aria-expanded={filtersOpen}
            aria-controls="advanced-filters"
          >
            <Filter className="w-3.5 h-3.5" aria-hidden="true" />
            Filters
            {(location || language) && (
              <span className="inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded-full bg-bh-accent text-white text-[10px] font-bold">
                {(location ? 1 : 0) + (language ? 1 : 0)}
              </span>
            )}
          </button>
        </div>

        {/* Advanced filters (Location, Language) */}
        {filtersOpen && (
          <div
            id="advanced-filters"
            className="mt-3 p-4 rounded-lg border border-bh-border bg-bh-bg-alt/40 grid sm:grid-cols-2 gap-3 animate-fade-in"
          >
            <div>
              <label htmlFor="location-input" className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-1.5">
                Location
              </label>
              <input
                id="location-input"
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="e.g. France, Spain, Brazil"
                className="input-field"
                autoComplete="off"
              />
              <p className="text-[10px] text-bh-text-dim mt-1 leading-snug">
                Only GitHub supports this. Other sources don't expose location.
              </p>
            </div>
            <div>
              <label htmlFor="language-input" className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-1.5">
                Primary language
              </label>
              <input
                id="language-input"
                type="text"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                placeholder="e.g. TypeScript, Rust, Go"
                className="input-field"
                autoComplete="off"
              />
            </div>
          </div>
        )}
      </form>

      {/* Inline save bar */}
      {showSave && (
        <div className="card flex flex-wrap items-center gap-3 mb-6 animate-fade-in-up">
          <Bookmark className="w-4 h-4 text-bh-warning shrink-0" aria-hidden="true" />
          <Input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="Name this search..."
            className="flex-1 min-w-[200px]"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleSaveSearch())}
          />
          <Button onClick={handleSaveSearch} loading={saving} disabled={!saveName.trim()} size="sm">
            <Save className="w-4 h-4" /> Save
          </Button>
          <Button
            onClick={() => { setShowSave(false); setSaveName(''); setSaveMsg(null) }}
            variant="ghost"
            size="sm"
            aria-label="Cancel"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      )}

      {saveMsg && (
        <div
          role="status"
          className={`mb-6 p-3 rounded-lg border text-sm ${
            saveMsg.ok
              ? 'border-bh-success/30 bg-bh-success/10 text-bh-success'
              : 'border-bh-danger/30 bg-bh-danger/10 text-bh-danger'
          }`}
        >
          {saveMsg.text}
        </div>
      )}

      {/* Landing state (before first search) */}
      {!searched && (
        <LandingState
          recent={recent}
          onPickQuery={(q) => { setQuery(q); runSearch(q) }}
          onClearRecent={clearRecent}
        />
      )}

      {/* Loading skeleton */}
      {loading && <SearchSkeleton />}

      {/* Results header (sort + count) */}
      {searched && !loading && results.length > 0 && (
        <div className="mb-4">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <p className="text-sm text-bh-text-muted">
              <span className="font-semibold text-bh-text">{results.length}</span> result
              {results.length === 1 ? '' : 's'} matching{' '}
              <span className="font-medium text-bh-text">"{query}"</span>
            </p>
            <div className="flex items-center gap-2">
              <SortMenu value={sortBy} onChange={setSortBy} />
              {searched && !showSave && (
                <Button onClick={() => setShowSave(true)} variant="secondary" size="sm">
                  <Bookmark className="w-4 h-4" /> Save search
                </Button>
              )}
            </div>
          </div>

          {/* Tabs: People | Resources */}
          <div role="tablist" aria-label="Result type" className="flex items-center gap-1 border-b border-bh-border">
            <ResultTabButton
              active={activeTab === 'people'}
              onClick={() => setActiveTab('people')}
              icon={Users}
              label="People"
              count={people.length}
            />
            <ResultTabButton
              active={activeTab === 'resources'}
              onClick={() => setActiveTab('resources')}
              icon={BookMarked}
              label="Resources"
              count={resources.length}
              disabled={resources.length === 0}
            />
          </div>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div
          role="alert"
          className="card border border-bh-danger/30 bg-bh-danger/10 text-bh-danger p-6 text-center"
        >
          <p className="font-semibold mb-1">Search failed</p>
          <p className="text-sm">{error}</p>
          <Button onClick={() => runSearch(query)} variant="secondary" size="sm" className="mt-3">
            Try again
          </Button>
        </div>
      )}

      {/* No results */}
      {searched && !loading && !error && results.length === 0 && (
        <NoResults query={query} onTryPopular={(q) => { setQuery(q); runSearch(q) }} />
      )}

      {/* Empty active tab (results exist but none in this kind) */}
      {searched && !loading && !error && results.length > 0 && sorted.length === 0 && (
        <div className="card text-center py-12">
          <div className="inline-flex w-12 h-12 rounded-xl bg-bh-surface-2 border border-bh-border items-center justify-center mb-3">
            {activeTab === 'people' ? <Users className="w-6 h-6 text-bh-text-muted" /> : <BookMarked className="w-6 h-6 text-bh-text-muted" />}
          </div>
          <p className="font-semibold text-bh-text mb-1">
            No {activeTab === 'people' ? 'people' : 'resources'} in this search
          </p>
          <p className="text-sm text-bh-text-muted max-w-sm mx-auto">
            {activeTab === 'people'
              ? `We found ${resources.length} resource${resources.length === 1 ? '' : 's'} but no people matching "${query}".`
              : `We found ${people.length} people but no resources. Check the People tab or try GitHub.`
            }
          </p>
          {activeTab === 'people' && resources.length > 0 && (
            <button
              onClick={() => setActiveTab('resources')}
              className="btn-secondary btn-sm mt-4"
            >
              View {resources.length} resource{resources.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}

      {/* Results list */}
      {searched && !loading && !error && sorted.length > 0 && (
        <>
          <ul className="space-y-3" role="list">
            {sorted.map((builder) => (
              <li key={`${builder.source}-${builder.id}`}>
                <BuilderResultCard builder={builder} query={query} />
              </li>
            ))}
          </ul>

          {/* Infinite scroll sentinel + status */}
          <div
            ref={sentinelRef}
            className="h-4 mt-2"
            aria-hidden="true"
            data-testid="infinite-scroll-sentinel"
          />

          {/* Loading more indicator */}
          {loadingMore && (
            <div
              className="flex items-center justify-center gap-2 py-6 text-sm text-bh-text-muted"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              Loading more results…
            </div>
          )}

          {/* Explicit Load more fallback (for users w/o IO) */}
          {!loadingMore && hasMore && sorted.length >= 30 && (
            <div className="flex justify-center py-6">
              <Button
                variant="secondary"
                size="sm"
                onClick={loadMore}
                data-testid="load-more-button"
              >
                Load more results
              </Button>
            </div>
          )}

          {/* End of results */}
          {!hasMore && (
            <div
              className="flex items-center justify-center gap-2 py-8 text-xs text-bh-text-dim"
              role="status"
              data-testid="end-of-results"
            >
              <span className="h-px w-8 bg-bh-border" aria-hidden="true" />
              End of results · {results.length} total
              <span className="h-px w-8 bg-bh-border" aria-hidden="true" />
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Subcomponents                                                              */
/* -------------------------------------------------------------------------- */

function LandingState({
  recent,
  onPickQuery,
  onClearRecent,
}: {
  recent: string[]
  onPickQuery: (q: string) => void
  onClearRecent: () => void
}) {
  return (
    <div className="space-y-8 mt-2">
      {/* Popular queries */}
      <section aria-labelledby="popular-heading">
        <h2 id="popular-heading" className="text-xs font-semibold uppercase tracking-widest text-bh-text-dim mb-3 flex items-center gap-2">
          <TrendingUp className="w-3.5 h-3.5" /> Popular searches
        </h2>
        <div className="flex flex-wrap gap-2">
          {POPULAR_QUERIES.map((p) => (
            <button
              key={p.label}
              onClick={() => onPickQuery(p.label)}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-full bg-bh-surface border border-bh-border text-sm text-bh-text hover:border-bh-accent hover:text-bh-accent hover:bg-bh-accent-soft/30 transition-all"
            >
              <span aria-hidden="true">{p.emoji}</span>
              {p.label}
            </button>
          ))}
        </div>
      </section>

      {/* Recent searches */}
      {recent.length > 0 && (
        <section aria-labelledby="recent-heading">
          <div className="flex items-center justify-between mb-3">
            <h2 id="recent-heading" className="text-xs font-semibold uppercase tracking-widest text-bh-text-dim flex items-center gap-2">
              <Clock className="w-3.5 h-3.5" /> Your recent searches
            </h2>
            <button
              onClick={onClearRecent}
              className="text-xs text-bh-text-dim hover:text-bh-text-muted"
            >
              Clear
            </button>
          </div>
          <ul className="space-y-1">
            {recent.map((q) => (
              <li key={q}>
                <button
                  onClick={() => onPickQuery(q)}
                  className="w-full text-left flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-bh-text-muted hover:bg-bh-surface hover:text-bh-text transition-colors"
                >
                  <Search className="w-3.5 h-3.5 text-bh-text-dim" aria-hidden="true" />
                  <span className="flex-1">{q}</span>
                  <ChevronDown className="w-3.5 h-3.5 -rotate-90 text-bh-text-dim" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Pro tips */}
      <section
        aria-labelledby="tips-heading"
        className="card-glow"
      >
        <div className="p-6">
          <h2 id="tips-heading" className="text-sm font-semibold text-bh-text flex items-center gap-2 mb-4">
            <Lightbulb className="w-4 h-4 text-bh-warning" aria-hidden="true" />
            Search tips
          </h2>
          <ul className="space-y-2.5">
            {PRO_TIPS.map((tip, i) => (
              <li key={i} className="flex items-start gap-3 text-sm text-bh-text-muted">
                <tip.icon className="w-4 h-4 text-bh-text-dim shrink-0 mt-0.5" aria-hidden="true" />
                <span>{tip.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  )
}

function SearchSkeleton() {
  return (
    <ul className="space-y-3" role="list" aria-busy="true" aria-label="Loading search results">
      {[...Array(4)].map((_, i) => (
        <li key={i} className="card animate-pulse">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-full bg-bh-surface-2 shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-1/3 bg-bh-surface-2 rounded" />
              <div className="h-3 w-1/2 bg-bh-surface-2 rounded" />
              <div className="h-3 w-2/3 bg-bh-surface-2 rounded" />
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

function NoResults({ query, onTryPopular }: { query: string; onTryPopular: (q: string) => void }) {
  return (
    <div className="card text-center py-16">
      <div className="inline-flex w-14 h-14 rounded-2xl bg-bh-surface-2 border border-bh-border items-center justify-center mb-4">
        <Search className="w-7 h-7 text-bh-text-muted" aria-hidden="true" />
      </div>
      <h2 className="text-xl font-semibold mb-2">No builders found for "{query}"</h2>
      <p className="text-bh-text-muted max-w-md mx-auto mb-6">
        Try fewer keywords, broader terms, or enable more sources. The most successful
        searches use 1-3 specific terms.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <span className="text-xs text-bh-text-dim uppercase tracking-wider mr-1">Try instead</span>
        {POPULAR_QUERIES.slice(0, 3).map((p) => (
          <button
            key={p.label}
            onClick={() => onTryPopular(p.label)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-bh-surface border border-bh-border text-xs text-bh-text-muted hover:border-bh-accent hover:text-bh-accent transition-colors"
          >
            <span aria-hidden="true">{p.emoji}</span>
            {p.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function BuilderResultCard({ builder, query }: { builder: Builder; query: string }) {
  if (builder.kind === 'repo') {
    return <ResourceResultCard builder={builder} query={query} />
  }
  return <PersonResultCard builder={builder} query={query} />
}

/* -------------------------------------------------------------------------- */
/*  Match highlights — find query terms that hit topics, name, handle, or bio */
/* -------------------------------------------------------------------------- */
function getMatchHighlights(builder: Builder, query: string): {
  topics: string[]
  terms: string[]    // query terms that matched somewhere
  fields: Array<'topic' | 'name' | 'handle' | 'bio'>
} {
  const queryTerms = query
    .toLowerCase()
    .split(/[,\s]+/)
    .filter(Boolean)
  if (queryTerms.length === 0) return { topics: [], terms: [], fields: [] }

  const topics = (builder.topics ?? []).filter((t) =>
    queryTerms.some((term) => t.toLowerCase().includes(term)),
  )

  const haystack = {
    name: (builder.displayName ?? '').toLowerCase(),
    handle: builder.username.toLowerCase(),
    bio: (builder.bio ?? '').toLowerCase(),
  }

  const matchedTerms = new Set<string>()
  const fields = new Set<'topic' | 'name' | 'handle' | 'bio'>()

  for (const term of queryTerms) {
    if (topics.some((t) => t.toLowerCase().includes(term))) {
      fields.add('topic')
      matchedTerms.add(term)
    }
    if (haystack.name && haystack.name.includes(term)) {
      fields.add('name')
      matchedTerms.add(term)
    }
    if (haystack.handle && haystack.handle.includes(term)) {
      fields.add('handle')
      matchedTerms.add(term)
    }
    if (haystack.bio && haystack.bio.includes(term)) {
      fields.add('bio')
      matchedTerms.add(term)
    }
  }

  return { topics, terms: [...matchedTerms], fields: [...fields] }
}

/* -------------------------------------------------------------------------- */
/*  PersonResultCard — compact single-line                                   */
/* -------------------------------------------------------------------------- */
function PersonResultCard({ builder, query }: { builder: Builder; query: string }) {
  const meta = SOURCE_META[builder.source]
  const { topics: matchedTopics, terms: matchedTerms, fields } = getMatchHighlights(builder, query)

  return (
    <article className="card card-hover group">
      <div className="flex items-center gap-4">
        {/* Avatar */}
        {builder.avatarUrl ? (
          <img
            src={builder.avatarUrl}
            alt={`${builder.displayName ?? builder.username} avatar`}
            className="w-10 h-10 rounded-full border border-bh-border shrink-0"
            loading="lazy"
            width={40}
            height={40}
          />
        ) : (
          <div
            className="w-10 h-10 rounded-full bg-gradient-to-br from-bh-accent to-bh-cyan flex items-center justify-center text-white font-semibold shrink-0 text-sm"
            aria-hidden="true"
          >
            {(builder.displayName ?? builder.username)[0]?.toUpperCase()}
          </div>
        )}

        {/* Single-line body: name + handle + source + tags + meta */}
        <div className="flex-1 min-w-0 flex items-center gap-2 overflow-hidden">
          {/* Name + handle */}
          <div className="flex items-center gap-1.5 shrink-0">
            <h3 className="font-semibold text-bh-text text-sm whitespace-nowrap">
              {builder.displayName ?? builder.username}
            </h3>
            {builder.displayName && (
              <span className="text-xs text-bh-text-dim whitespace-nowrap">@{builder.username}</span>
            )}
          </div>

          <span className={`badge ${meta.color} inline-flex items-center gap-1 shrink-0`}>
            <meta.Icon className="w-3 h-3" title={meta.label} />
            {meta.label}
          </span>

          {/* Matched topics — inline */}
          {matchedTopics.slice(0, 2).map((t) => (
            <span key={t} className="badge text-xs shrink-0">{t}</span>
          ))}

          {/* Meta — followers / country / last seen, in muted text */}
          <div className="flex items-center gap-3 text-xs text-bh-text-muted shrink min-w-0">
            {builder.followersCount != null && (
              <span className="inline-flex items-center gap-1 shrink-0">
                <Users className="w-3 h-3" aria-hidden="true" />
                {(builder.followersCount ?? 0).toLocaleString()}
              </span>
            )}
            {builder.country && (
              <span className="hidden sm:inline whitespace-nowrap">{builder.country}</span>
            )}
          </div>

          {/* Why this match — show what hit, taking remaining space */}
          {matchedTerms.length > 0 && (
            <span className="hidden md:inline-flex items-center gap-1 text-xs text-bh-text-dim ml-auto truncate">
              <Sparkles className="w-3 h-3 text-bh-accent shrink-0" aria-hidden="true" />
              <span className="truncate">
                matches{' '}
                {matchedTerms.slice(0, 3).map((t, i) => (
                  <span key={t}>
                    <span className="text-bh-text-muted font-medium">"{t}"</span>
                    {i < Math.min(matchedTerms.length, 3) - 1 && ', '}
                  </span>
                ))}
                {matchedTerms.length > 3 && ` +${matchedTerms.length - 3}`}
                {' '}
                <span className="text-bh-text-dim">in {fields.join(' + ')}</span>
              </span>
            </span>
          )}
        </div>

        {/* Score + action */}
        <div className="flex items-center gap-3 shrink-0">
          {builder.score != null && (
            <ScoreRing
              score={builder.score}
              size={40}
              showLabel={false}
              breakdown={getScoreBreakdown(builder)}
            />
          )}
          <a
            href={builder.profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary btn-sm"
            title="Open profile"
          >
            View <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </a>
        </div>
      </div>
    </article>
  )
}

/* -------------------------------------------------------------------------- */
/*  ResourceResultCard — taller, with description                             */
/* -------------------------------------------------------------------------- */
function ResourceResultCard({ builder, query }: { builder: Builder; query: string }) {
  const meta = SOURCE_META[builder.source]
  const { topics: matchedTopics, terms: matchedTerms, fields } = getMatchHighlights(builder, query)

  return (
    <article className="card card-hover group">
      <div className="flex items-start gap-4">
        {/* Icon */}
        <div
          className="w-10 h-10 rounded-lg bg-gradient-to-br from-yellow-500 to-orange-500 flex items-center justify-center text-white shrink-0"
          aria-hidden="true"
        >
          <GitFork className="w-5 h-5" />
        </div>

        {/* Body */}
        <div className="flex-1 min-w-0">
          {/* Name + source */}
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <h3 className="font-semibold text-bh-text text-base">
              {builder.displayName ?? builder.username}
            </h3>
            <span className={`badge ${meta.color} inline-flex items-center gap-1`}>
              <meta.Icon className="w-3 h-3" title={meta.label} />
              {meta.label}
            </span>
            <span className="badge-neutral badge text-xs inline-flex items-center gap-1">
              <GitFork className="w-3 h-3" /> Repository
            </span>
            {matchedTopics.slice(0, 3).map((t) => (
              <span key={t} className="badge text-xs">
                {t}
              </span>
            ))}
          </div>

          {/* Description */}
          {builder.bio && (
            <p className="text-sm text-bh-text-muted line-clamp-2 mb-3 leading-relaxed">
              {builder.bio}
            </p>
          )}

          {/* Meta row */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-bh-text-muted mb-2">
            <a
              href={builder.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-bh-accent hover:underline"
            >
              <Code className="w-3 h-3" aria-hidden="true" />
              {builder.username}
              <ExternalLink className="w-2.5 h-2.5" aria-hidden="true" />
            </a>
            {builder.followersCount != null && (
              <span className="inline-flex items-center gap-1">
                <Star className="w-3 h-3" aria-hidden="true" />
                {(builder.followersCount ?? 0).toLocaleString()} stars
              </span>
            )}
            {builder.language && <span>{builder.language}</span>}
          </div>

          {/* Why this match */}
          {matchedTerms.length > 0 && (
            <p className="text-xs text-bh-text-dim flex items-start gap-1.5">
              <Sparkles className="w-3 h-3 text-bh-accent shrink-0 mt-0.5" aria-hidden="true" />
              <span>
                Matches{' '}
                {matchedTerms.slice(0, 4).map((t, i) => (
                  <span key={t}>
                    <span className="text-bh-text-muted font-medium">"{t}"</span>
                    {i < Math.min(matchedTerms.length, 4) - 1 && ', '}
                  </span>
                ))}
                {matchedTerms.length > 4 && ` +${matchedTerms.length - 4} more`}
                {fields.length > 0 && (
                  <span className="text-bh-text-dim"> · in {fields.join(' + ')}</span>
                )}
              </span>
            </p>
          )}
        </div>

        {/* Score + actions */}
        <div className="flex flex-col items-end gap-3 shrink-0">
          {builder.score != null && (
            <ScoreRing
              score={builder.score}
              size={56}
              breakdown={getScoreBreakdown(builder)}
            />
          )}
          <a
            href={builder.profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary btn-sm"
          >
            View <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </a>
        </div>
      </div>
    </article>
  )
}

function ResultTabButton({
  active,
  onClick,
  icon: Icon,
  label,
  count,
  disabled = false,
}: {
  active: boolean
  onClick: () => void
  icon: React.ComponentType<{ className?: string }>
  label: string
  count: number
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      disabled={disabled}
      className={`relative inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold transition-colors ${
        active
          ? 'text-bh-text'
          : disabled
            ? 'text-bh-text-dim cursor-not-allowed'
            : 'text-bh-text-muted hover:text-bh-text'
      }`}
    >
      <Icon className="w-4 h-4" aria-hidden="true" />
      {label}
      <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-bold ${
        active
          ? 'bg-bh-accent-soft text-bh-accent'
          : 'bg-bh-surface-2 text-bh-text-muted'
      }`}>
        {count}
      </span>
      {active && (
        <span
          className="absolute bottom-0 left-2 right-2 h-0.5 bg-bh-accent rounded-t"
          aria-hidden="true"
        />
      )}
    </button>
  )
}

function SortMenu({ value, onChange }: { value: SortBy; onChange: (v: SortBy) => void }) {
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const options: { value: SortBy; label: string; icon: typeof TrendingUp }[] = [
    { value: 'score', label: 'Best match', icon: Sparkles },
    { value: 'recency', label: 'Most recent', icon: Clock },
    { value: 'followers', label: 'Most followers', icon: TrendingUp },
  ]
  const current = options.find((o) => o.value === value)!

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="btn-secondary btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <current.icon className="w-3.5 h-3.5" aria-hidden="true" />
        {current.label}
        <ChevronDown className="w-3 h-3" aria-hidden="true" />
      </button>
      {open && (
        <ul
          role="menu"
          className="absolute right-0 mt-1 w-48 card p-1 z-10 animate-fade-in"
        >
          {options.map((opt) => (
            <li key={opt.value} role="none">
              <button
                role="menuitemradio"
                aria-checked={value === opt.value}
                onClick={() => { onChange(opt.value); setOpen(false) }}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded text-sm ${
                  value === opt.value
                    ? 'bg-bh-accent-soft text-bh-accent font-semibold'
                    : 'text-bh-text hover:bg-bh-surface-2'
                }`}
              >
                <opt.icon className="w-3.5 h-3.5" aria-hidden="true" />
                {opt.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function formatRelativeDate(iso: string): string {
  const date = Date.parse(iso)
  if (isNaN(date)) return ''
  const diff = Date.now() - date
  const day = 24 * 60 * 60 * 1000
  if (diff < day) return 'today'
  if (diff < 2 * day) return 'yesterday'
  if (diff < 7 * day) return `${Math.floor(diff / day)} days ago`
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))} weeks ago`
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))} months ago`
  return `${Math.floor(diff / (365 * day))} years ago`
}
