import * as React from 'react'
import { RecommendationsSection } from './RecommendationsSection'
import { OnboardingBanner } from './OnboardingBanner'
import { Link } from '@tanstack/react-router'
import {
  Users, TrendingUp, Bookmark, StickyNote, ExternalLink, Plus,
  Search, ArrowRight, Sparkles, Activity, Download, Rss, Trash2,
  MoreVertical, Loader2, Check, X,
} from 'lucide-react'

interface Stats {
  totalBuilders: number
  activeThisWeek: number
  savedQueries: number
  totalNotes: number
}

interface SavedQuery {
  id: string
  name: string
  keywords: string[]
  sources: string[]
  createdAt: string
}

interface RecentBuilder {
  id: string
  username: string
  displayName: string | null
  source: 'github' | 'reddit' | 'hn' | 'devto'
  bio: string | null
  followersCount: number | null
  topics: string[]
  lastSeen: string
}

export function DashboardPage() {
  const [stats, setStats] = React.useState<Stats | null>(null)
  const [queries, setQueries] = React.useState<SavedQuery[]>([])
  const [recent, setRecent] = React.useState<RecentBuilder[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const refetchQueries = React.useCallback(async () => {
    try {
      const q = await fetch('/api/queries', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [])
      setQueries(Array.isArray(q) ? q : [])
    } catch (err) {
      console.error('Refetch queries error:', err)
    }
  }, [])

  React.useEffect(() => {
    Promise.all([
      fetch('/api/dashboard/stats', { credentials: 'include' }).then(async (r) => {
        if (!r.ok) throw new Error(`stats: ${r.status}`)
        return r.json()
      }),
      fetch('/api/queries', { credentials: 'include' }).then(async (r) => {
        if (!r.ok) return []
        return r.json()
      }).catch(() => []),
      fetch('/api/builders/recent', { credentials: 'include' }).then(async (r) => {
        if (!r.ok) return []
        return r.json()
      }).catch(() => []),
    ])
      .then(([s, q, r]) => {
        setStats(s)
        setQueries(Array.isArray(q) ? q : [])
        setRecent(Array.isArray(r) ? r : [])
        setLoading(false)
      })
      .catch((err) => {
        console.error('Dashboard load error:', err)
        setError(err.message ?? 'Failed to load dashboard')
        setLoading(false)
      })
  }, [])

  if (loading) {
    return (
      <div className="p-8 max-w-6xl mx-auto">
        <div className="animate-pulse space-y-6">
          <div className="h-8 w-48 bg-bh-surface rounded" />
          <div className="h-4 w-72 bg-bh-surface rounded" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="card h-24 bg-bh-surface/50" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  const statsData = [
    {
      label: 'Builders tracked',
      value: stats?.totalBuilders ?? 0,
      icon: Users,
      tone: 'accent' as const,
      hint: 'People saved to your lists',
    },
    {
      label: 'Active this week',
      value: stats?.activeThisWeek ?? 0,
      icon: TrendingUp,
      tone: 'success' as const,
      hint: 'Shipped something in the last 7 days',
    },
    {
      label: 'Saved searches',
      value: stats?.savedQueries ?? 0,
      icon: Bookmark,
      tone: 'warning' as const,
      hint: 'Hunts you can re-run anytime',
    },
    {
      label: 'Private notes',
      value: stats?.totalNotes ?? 0,
      icon: StickyNote,
      tone: 'cyan' as const,
      hint: 'Context you\'ve attached to builders',
    },
  ]

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto">
      {/* Header */}
      <header className="mb-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-1">
              Welcome back<span className="text-bh-accent">.</span>
            </h1>
            <p className="text-bh-text-muted">
              Here's what your hunts turned up.
              {stats?.activeThisWeek ? ` ${stats.activeThisWeek} builder${stats.activeThisWeek === 1 ? '' : 's'} active this week.` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/search" className="btn-secondary">
              <Search className="w-4 h-4" aria-hidden="true" /> Search
            </Link>
            <Link to="/search" className="btn-primary">
              <Plus className="w-4 h-4" aria-hidden="true" /> New hunt
            </Link>
          </div>
        </div>
      </header>

      {/* Onboarding banner — only for eligible users */}
      <OnboardingBanner />

      {/* For you — proactive recommendations */}
      <RecommendationsSection />

      {/* Stats */}
      <section aria-labelledby="stats-heading" className="mb-10">
        <h2 id="stats-heading" className="sr-only">Your stats</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {statsData.map((s) => (
            <StatCard key={s.label} {...s} />
          ))}
        </div>
      </section>

      {/* Quick actions */}
      {(!stats || stats.totalBuilders === 0) && !error && (
        <section className="card-glow mb-10 animate-fade-in">
          <div className="p-8 md:p-10 text-center">
            <div className="inline-flex w-14 h-14 rounded-2xl bg-bh-accent-soft border border-bh-accent/20 items-center justify-center mb-5">
              <Sparkles className="w-7 h-7 text-bh-accent" aria-hidden="true" />
            </div>
            <h3 className="text-2xl font-semibold mb-2">Run your first hunt</h3>
            <p className="text-bh-text-muted max-w-md mx-auto mb-6">
              Pick a topic you care about — a framework, a stack, a community — and we'll surface
              the people actively shipping in it across GitHub, Reddit, Hacker News and DEV.to.
            </p>
            <Link to="/search" className="btn-primary btn-lg">
              Start your first hunt <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </Link>
          </div>
        </section>
      )}

      {/* Saved searches */}
      <section aria-labelledby="queries-heading" className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 id="queries-heading" className="text-lg font-semibold flex items-center gap-2">
            <Bookmark className="w-5 h-5 text-bh-warning" aria-hidden="true" />
            Saved searches
          </h2>
          {queries.length > 0 && (
            <Link to="/search" className="text-sm text-bh-accent hover:underline flex items-center gap-1">
              New search <ArrowRight className="w-3 h-3" aria-hidden="true" />
            </Link>
          )}
        </div>
        {queries.length === 0 ? (
          <EmptyState
            icon={Bookmark}
            title="No saved searches yet"
            body="Saved searches let you re-run the same hunt with one click. Set one up from the Search page."
            cta={{ to: '/search', label: 'Set up a search' }}
          />
        ) : (
          <ul className="card divide-y divide-bh-border p-0">
            {queries.map((q) => (
              <SavedSearchRow key={q.id} query={q} onDeleted={refetchQueries} />
            ))}
          </ul>
        )}
      </section>

      {/* Recent builders */}
      <section aria-labelledby="builders-heading">
        <div className="flex items-center justify-between mb-4">
          <h2 id="builders-heading" className="text-lg font-semibold flex items-center gap-2">
            <Activity className="w-5 h-5 text-bh-success" aria-hidden="true" />
            Recent builders
          </h2>
          {recent.length > 0 && (
            <Link to="/search" className="text-sm text-bh-accent hover:underline flex items-center gap-1">
              See all <ArrowRight className="w-3 h-3" aria-hidden="true" />
            </Link>
          )}
        </div>
        {recent.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No builders tracked yet"
            body="Once you save a builder from a search result, they'll show up here. Use the search to find people matching your stack."
            cta={{ to: '/search', label: 'Run your first search' }}
          />
        ) : (
          <ul className="grid sm:grid-cols-2 gap-4">
            {recent.map((b) => (
              <li key={b.id}>
                <Link
                  to="/builder/$builderId"
                  params={{ builderId: b.id }}
                  className="card card-hover flex items-start gap-3 h-full"
                >
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-bh-accent to-bh-cyan flex items-center justify-center text-white font-semibold shrink-0">
                    {(b.displayName ?? b.username)[0]?.toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="font-medium text-bh-text truncate">
                        {b.displayName ?? b.username}
                      </p>
                      <span className={`badge badge-${b.source}`}>{b.source}</span>
                    </div>
                    {b.bio && <p className="text-xs text-bh-text-muted line-clamp-2 mb-2">{b.bio}</p>}
                    <p className="text-xs text-bh-text-dim">
                      {b.followersCount?.toLocaleString() ?? 0} followers
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && (
        <div className="mt-6 p-4 rounded-lg border border-bh-danger/30 bg-bh-danger/10 text-sm text-bh-danger">
          <strong>Heads up:</strong> {error}. Some data may be missing.
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Subcomponents                                                              */
/* ─────────────────────────────────────────────────────────────────────────── */

const TONE_ICON: Record<'accent' | 'success' | 'warning' | 'cyan', string> = {
  accent: 'text-bh-accent bg-bh-accent-soft border-bh-accent/20',
  success: 'text-bh-success bg-bh-success/10 border-bh-success/20',
  warning: 'text-bh-warning bg-bh-warning/10 border-bh-warning/20',
  cyan: 'text-bh-cyan bg-bh-cyan-soft border-bh-cyan/20',
}

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string
  value: number
  hint: string
  icon: React.ComponentType<{ className?: string }>
  tone: 'accent' | 'success' | 'warning' | 'cyan'
}) {
  return (
    <div className="card card-hover">
      <div className="flex items-start justify-between mb-3">
        <div className={`w-10 h-10 rounded-lg border flex items-center justify-center ${TONE_ICON[tone]}`}>
          <Icon className="w-5 h-5" aria-hidden="true" />
        </div>
      </div>
      <p className="text-3xl font-bold tracking-tight text-bh-text mb-1">
        {value.toLocaleString()}
      </p>
      <p className="text-sm font-medium text-bh-text">{label}</p>
      <p className="text-xs text-bh-text-dim mt-1">{hint}</p>
    </div>
  )
}

function EmptyState({
  icon: Icon,
  title,
  body,
  cta,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  body: string
  cta: { to: string; label: string }
}) {
  return (
    <div className="card text-center py-10">
      <div className="inline-flex w-12 h-12 rounded-xl bg-bh-surface-2 border border-bh-border items-center justify-center mb-4">
        <Icon className="w-6 h-6 text-bh-text-muted" aria-hidden="true" />
      </div>
      <p className="font-semibold text-bh-text mb-1">{title}</p>
      <p className="text-sm text-bh-text-muted max-w-sm mx-auto mb-4">{body}</p>
      <Link to={cta.to} className="btn-secondary btn-sm inline-flex">
        {cta.label} <ArrowRight className="w-3 h-3" aria-hidden="true" />
      </Link>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  SavedSearchRow — Run / Export / RSS / Delete actions per query              */
/* -------------------------------------------------------------------------- */
function SavedSearchRow({
  query,
  onDeleted,
}: {
  query: SavedQuery
  onDeleted: () => Promise<void> | void
}) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [exporting, setExporting] = React.useState<'people' | 'resources' | null>(null)
  const [exportMsg, setExportMsg] = React.useState<{ ok: boolean; text: string } | null>(null)
  const [confirming, setConfirming] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const menuRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const runUrl = `/search?q=${encodeURIComponent(query.keywords.join(' '))}`
  const rssUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/api/feeds/${query.id}?format=rss`

  const handleExport = async (kind: 'people' | 'resources') => {
    setExporting(kind)
    setMenuOpen(false)
    setExportMsg(null)
    try {
      const res = await fetch('/api/search/builders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          keywords: query.keywords,
          sources: query.sources,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      const all = (data.builders ?? []) as ExportableBuilder[]
      const filtered = all.filter((b) =>
        kind === 'people' ? b.kind === 'person' : b.kind !== 'person',
      )
      const filename = `${slugify(query.name)}-${kind}-${new Date().toISOString().slice(0, 10)}.csv`
      const csv = buildersToCsv(filtered)
      downloadBlob(csv, filename, 'text/csv')
      setExportMsg({ ok: true, text: `Exported ${filtered.length} ${kind} to ${filename}` })
      setTimeout(() => setExportMsg(null), 5000)
    } catch (e: any) {
      setExportMsg({ ok: false, text: e.message ?? 'Export failed' })
      setTimeout(() => setExportMsg(null), 5000)
    } finally {
      setExporting(null)
    }
  }

  const copyRss = async () => {
    setMenuOpen(false)
    try {
      await navigator.clipboard.writeText(rssUrl)
      setExportMsg({ ok: true, text: 'RSS feed URL copied to clipboard' })
      setTimeout(() => setExportMsg(null), 4000)
    } catch {
      setExportMsg({ ok: false, text: 'Copy failed — RSS URL: ' + rssUrl })
      setTimeout(() => setExportMsg(null), 6000)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      const res = await fetch('/api/queries', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id: query.id }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      await onDeleted()
    } catch (e: any) {
      setExportMsg({ ok: false, text: e.message ?? 'Delete failed' })
      setTimeout(() => setExportMsg(null), 5000)
    } finally {
      setDeleting(false)
      setConfirming(false)
    }
  }

  return (
    <li className="p-4 hover:bg-bh-surface-2/30 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-bh-text truncate">{query.name}</p>
          <p className="text-xs text-bh-text-muted truncate mt-0.5">
            {query.keywords.join(', ')} · {query.sources.length} source{query.sources.length === 1 ? '' : 's'}
            {query.country && ` · ${query.country}`}
            {query.language && ` · ${query.language}`}
          </p>
          {exportMsg && (
            <p
              role={exportMsg.ok ? 'status' : 'alert'}
              className={`text-xs mt-1.5 ${exportMsg.ok ? 'text-bh-success' : 'text-bh-danger'}`}
            >
              {exportMsg.text}
            </p>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <a href={runUrl} className="btn-secondary btn-sm" title="Re-run this search">
            Run <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </a>

          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              disabled={exporting !== null || deleting}
              className="btn-secondary btn-sm p-1.5"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="More actions"
              title="Export & RSS"
            >
              {exporting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <MoreVertical className="w-3.5 h-3.5" aria-hidden="true" />
              )}
            </button>
            {menuOpen && (
              <ul role="menu" className="absolute right-0 mt-1 w-56 card p-1 z-10 animate-fade-in">
                <li role="none">
                  <button
                    role="menuitem"
                    onClick={() => handleExport('people')}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-bh-text hover:bg-bh-surface-2"
                  >
                    <Download className="w-3.5 h-3.5" aria-hidden="true" />
                    Export people (CSV)
                  </button>
                </li>
                <li role="none">
                  <button
                    role="menuitem"
                    onClick={() => handleExport('resources')}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-bh-text hover:bg-bh-surface-2"
                  >
                    <Download className="w-3.5 h-3.5" aria-hidden="true" />
                    Export resources (CSV)
                  </button>
                </li>
                <li role="none">
                  <div className="my-1 border-t border-bh-border" />
                </li>
                <li role="none">
                  <button
                    role="menuitem"
                    onClick={copyRss}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-bh-text hover:bg-bh-surface-2"
                  >
                    <Rss className="w-3.5 h-3.5 text-bh-warning" aria-hidden="true" />
                    Copy RSS feed URL
                  </button>
                </li>
              </ul>
            )}
          </div>

          {!confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={deleting || exporting !== null}
              className="btn-ghost btn-sm p-1.5 text-bh-text-dim hover:text-bh-danger"
              aria-label="Delete saved search"
              title="Delete"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          ) : (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="btn-sm p-1.5 bg-bh-danger/20 text-bh-danger border border-bh-danger/30 rounded hover:bg-bh-danger/30"
                aria-label="Confirm delete"
                title="Confirm delete"
              >
                {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={deleting}
                className="btn-ghost btn-sm p-1.5"
                aria-label="Cancel delete"
                title="Cancel"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </li>
  )
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 60) || 'export'
  )
}

interface ExportableBuilder {
  kind?: 'person' | 'repo'
  source: string
  username: string
  displayName?: string
  bio?: string
  profileUrl: string
  followersCount?: number
  language?: string
  country?: string
  topics?: string[]
  score?: number
}

function buildersToCsv(builders: ExportableBuilder[]): string {
  const header = [
    'username',
    'display_name',
    'kind',
    'source',
    'score',
    'followers_or_stars',
    'language',
    'country',
    'topics',
    'bio',
    'profile_url',
  ]
  const rows = builders.map((b) => [
    b.username,
    b.displayName ?? '',
    b.kind ?? '',
    b.source,
    b.score != null ? String(Math.round(b.score)) : '',
    b.followersCount != null ? String(b.followersCount) : '',
    b.language ?? '',
    b.country ?? '',
    (b.topics ?? []).join('; '),
    (b.bio ?? '').replace(/\s+/g, ' ').trim(),
    b.profileUrl,
  ])
  const escape = (s: string) => `"${String(s).replace(/"/g, '""')}"`
  return [header.join(','), ...rows.map((r) => r.map(escape).join(','))].join('\n')
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 0)
}
