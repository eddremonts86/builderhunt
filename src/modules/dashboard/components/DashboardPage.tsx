import * as React from 'react'
import { RecommendationsSection } from './RecommendationsSection'
import { OnboardingBanner } from './OnboardingBanner'
import { PendingInvitationsBanner } from './PendingInvitationsBanner'
import { Link } from '@tanstack/react-router'
import {
  Users, TrendingUp, Bookmark, StickyNote, ExternalLink, Plus,
  Search, ArrowRight, Sparkles, Activity, Download, Rss, Trash2,
  MoreVertical, Loader2, Check, X, Clock,
} from 'lucide-react'
import { formatDistanceToNow } from '~/shared/lib/format'

interface Stats {
  totalBuilders: number
  activeThisWeek: number
  savedQueries: number
  totalNotes: number
  dailyActivity?: Array<{ date: string; label: string; count: number }>
}

interface SavedQuery {
  id: string
  name: string
  keywords: string[]
  sources: string[]
  createdAt: string
  country?: string
  language?: string
}

interface RecentBuilder {
  id: string
  /** builder_identities.id — use this for the profile page link, not `id`. */
  identityId: string
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

  // Every badge below is derived from data we actually have — no placeholder
  // counts that could contradict the headline number.
  const latestQuery = [...queries].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )[0]
  const activeSharePct = stats && stats.totalBuilders > 0
    ? Math.round((stats.activeThisWeek / stats.totalBuilders) * 100)
    : null
  const notesPerBuilder = stats && stats.totalBuilders > 0 && stats.totalNotes > 0
    ? (stats.totalNotes / stats.totalBuilders).toFixed(1)
    : null

  const statsData = [
    {
      label: 'Builders tracked',
      value: stats?.totalBuilders ?? 0,
      icon: Users,
      tone: 'accent' as const,
      hint: 'People saved to your lists',
      badge: stats && stats.activeThisWeek > 0 ? `${stats.activeThisWeek} active now` : undefined,
    },
    {
      label: 'Active this week',
      value: stats?.activeThisWeek ?? 0,
      icon: TrendingUp,
      tone: 'success' as const,
      hint: 'Shipped something in the last 7 days',
      badge: activeSharePct !== null ? `${activeSharePct}% of tracked` : undefined,
    },
    {
      label: 'Saved searches',
      value: stats?.savedQueries ?? 0,
      icon: Bookmark,
      tone: 'warning' as const,
      hint: 'Hunts you can re-run anytime',
      badge: latestQuery ? `Latest: ${truncate(latestQuery.name, 16)}` : undefined,
    },
    {
      label: 'Private notes',
      value: stats?.totalNotes ?? 0,
      icon: StickyNote,
      tone: 'cyan' as const,
      hint: 'Context you\'ve attached to builders',
      badge: notesPerBuilder !== null ? `${notesPerBuilder}/builder` : undefined,
    },
  ]

  const dailyActivity = stats?.dailyActivity ?? []
  const activityMax = Math.max(1, ...dailyActivity.map((d) => d.count))
  const hasActivity = dailyActivity.some((d) => d.count > 0)
  const peakIndex = hasActivity
    ? dailyActivity.reduce((best, d, i, arr) => (d.count > arr[best].count ? i : best), 0)
    : -1

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto">
      {/* Header */}
      <header className="mb-8 space-y-6">
        {/* Title block */}
        <div className="flex flex-wrap items-end justify-between gap-4 pt-2">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-1 text-bh-text">
              Overview
            </h1>
            <p className="text-bh-text-muted text-sm font-light">
              Here's what your hunts turned up.
              {stats?.activeThisWeek ? ` ${stats.activeThisWeek} builder${stats.activeThisWeek === 1 ? '' : 's'} active this week.` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/search" className="btn-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2">
              <Search className="w-4 h-4" aria-hidden="true" /> Search
            </Link>
            <Link to="/search" className="btn-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2">
              <Plus className="w-4 h-4" aria-hidden="true" /> New hunt
            </Link>
          </div>
        </div>
      </header>

      {/* Stats */}
      <section aria-labelledby="stats-heading" className="mb-8">
        <h2 id="stats-heading" className="sr-only">Your stats</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {statsData.map((s) => (
            <StatCard key={s.label} {...s} />
          ))}
        </div>
      </section>

      {/* Bento Grid layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column (2/3) */}
        <div className="lg:col-span-2 space-y-6">
          <PendingInvitationsBanner />
          <OnboardingBanner />

          {/* Quick actions (empty state if no builders tracked) */}
          {(!stats || stats.totalBuilders === 0) && !error && (
            <div className="card-glow animate-fade-in">
              <div className="p-6 text-center">
                <div className="inline-flex w-12 h-12 rounded-xl bg-bh-accent-soft border border-bh-accent/20 items-center justify-center mb-4">
                  <Sparkles className="w-6 h-6 text-bh-accent" aria-hidden="true" />
                </div>
                <h3 className="text-xl font-semibold mb-2 text-bh-text">Run your first hunt</h3>
                <p className="text-sm text-bh-text-muted max-w-md mx-auto mb-4 font-light">
                  Pick a topic you care about — a framework, a stack, a community — and we'll surface
                  the people actively shipping in it.
                </p>
                <Link to="/search" className="btn-primary btn-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2">
                  Start your first hunt <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </Link>
              </div>
            </div>
          )}

          <RecommendationsSection />

          {/* Weekly Shipping Activity Bento Card */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-bh-text flex items-center gap-2">
                <Activity className="w-4 h-4 text-bh-accent" aria-hidden="true" />
                Weekly Activity
              </h3>
              <span className="text-xs text-bh-text-dim font-light">
                {hasActivity ? 'Builders active per day' : 'Last 7 days'}
              </span>
            </div>
            {hasActivity ? (
              <div className="flex items-end justify-between h-40 pt-4 px-2">
                {dailyActivity.map((d, i) => {
                  const isPeak = i === peakIndex
                  const heightPct = Math.max(6, Math.round((d.count / activityMax) * 100))
                  return (
                    <div key={d.date} className="flex flex-col items-center flex-1 gap-2">
                      <div className="w-full max-w-[28px] sm:max-w-[36px] bg-bh-bg-alt rounded-t-md h-28 relative flex items-end">
                        {isPeak && (
                          <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-[#2b1812] text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow-sm whitespace-nowrap z-10">
                            {d.count}
                            {/* Triangle indicator */}
                            <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-[#2b1812]" />
                          </div>
                        )}
                        <div
                          className={`w-full rounded-t-md transition-all duration-500 ease-out ${
                            isPeak
                              ? 'bg-[#fbeee6] bg-striped-terracotta'
                              : 'bg-zinc-50 bg-striped-neutral'
                          }`}
                          style={{ height: `${heightPct}%` }}
                        />
                      </div>
                      <span className="text-[11px] text-bh-text-dim font-medium">{d.label}</span>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="text-center py-8">
                <p className="text-sm text-bh-text-muted font-light">
                  No tracked builders have shipped in the last 7 days yet.
                </p>
                <p className="text-xs text-bh-text-dim mt-1">
                  This fills in once builders you're tracking are active again.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Right Column (1/3) */}
        <div className="lg:col-span-1 space-y-6">
          {/* Saved searches Bento Card */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 id="queries-heading" className="text-base font-semibold text-bh-text flex items-center gap-2">
                <Bookmark className="w-4 h-4 text-bh-warning" aria-hidden="true" />
                Saved searches
              </h2>
              {queries.length > 0 && (
                <Link to="/search" className="text-xs text-bh-accent hover:underline flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 rounded px-0.5">
                  New search <ArrowRight className="w-3 h-3" aria-hidden="true" />
                </Link>
              )}
            </div>
            {queries.length === 0 ? (
              <div className="text-center py-6 bg-bh-bg-alt/50 rounded-xl border border-bh-border border-dashed p-4">
                <Bookmark className="w-8 h-8 text-bh-text-dim mx-auto mb-2 opacity-50" aria-hidden="true" />
                <p className="font-semibold text-sm text-bh-text mb-1">No saved searches yet</p>
                <p className="text-xs text-bh-text-muted mb-3 font-light">Saved searches let you re-run hunts with one click.</p>
                <Link to="/search" className="btn-secondary btn-sm text-xs py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2">
                  Set up a search
                </Link>
              </div>
            ) : (
              <ul className="divide-y divide-bh-border -mx-5 -mb-5 border-t border-bh-border">
                {queries.map((q) => (
                  <SavedSearchRow key={q.id} query={q} onDeleted={refetchQueries} />
                ))}
              </ul>
            )}
          </div>

          {/* Recent builders Bento Card */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 id="builders-heading" className="text-base font-semibold text-bh-text flex items-center gap-2">
                <Activity className="w-4 h-4 text-bh-success" aria-hidden="true" />
                Recent builders
              </h2>
              {recent.length > 0 && (
                <Link to="/search" className="text-xs text-bh-accent hover:underline flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 rounded px-0.5">
                  See all <ArrowRight className="w-3 h-3" aria-hidden="true" />
                </Link>
              )}
            </div>
            {recent.length === 0 ? (
              <div className="text-center py-6 bg-bh-bg-alt/50 rounded-xl border border-bh-border border-dashed p-4">
                <Users className="w-8 h-8 text-bh-text-dim mx-auto mb-2 opacity-50" aria-hidden="true" />
                <p className="font-semibold text-sm text-bh-text mb-1">No builders tracked yet</p>
                <p className="text-xs text-bh-text-muted mb-3 font-light">Save builders from searches to see them here.</p>
                <Link to="/search" className="btn-secondary btn-sm text-xs py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2">
                  Run a search
                </Link>
              </div>
            ) : (
              <ul className="divide-y divide-bh-border -mx-5 -mb-5 border-t border-bh-border">
                {recent.map((b) => (
                  <li key={b.identityId}>
                    <Link
                      to="/builder/$builderId"
                      params={{ builderId: b.identityId }}
                      className="flex items-start gap-3 p-4 hover:bg-bh-surface-2/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
                    >
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-bh-accent to-bh-cyan flex items-center justify-center text-white text-xs font-semibold shrink-0">
                        {(b.displayName ?? b.username)[0]?.toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <p className="font-medium text-sm text-bh-text truncate">
                            {b.displayName ?? b.username}
                          </p>
                          <span className={`badge badge-${b.source} text-[9px] px-1.5 py-0`}>{b.source}</span>
                        </div>
                        {b.bio && <p className="text-xs text-bh-text-muted line-clamp-1">{b.bio}</p>}
                        <p className="text-[10px] text-bh-text-dim mt-0.5 flex items-center gap-1">
                          {b.followersCount?.toLocaleString() ?? 0} followers
                          <span aria-hidden="true">·</span>
                          <Clock className="w-2.5 h-2.5" aria-hidden="true" />
                          active {formatDistanceToNow(new Date(b.lastSeen))}
                        </p>
                        {b.topics.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {b.topics.slice(0, 2).map((topic) => (
                              <span
                                key={topic}
                                className="text-[9px] px-1.5 py-0.5 rounded-full bg-bh-bg-alt text-bh-text-dim border border-bh-border"
                              >
                                {topic}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-6 p-4 rounded-lg border border-bh-danger/30 bg-bh-danger/10 text-sm text-bh-danger font-light">
          <strong>Heads up:</strong> {error}. Some data may be missing.
        </div>
      )}
    </div>
  )
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
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
  badge,
}: {
  label: string
  value: number
  hint: string
  icon: React.ComponentType<{ className?: string }>
  tone: 'accent' | 'success' | 'warning' | 'cyan'
  badge?: string
}) {
  return (
    <div className="card card-hover p-5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-light text-zinc-400">{label}</span>
        <div className={`w-7 h-7 rounded-md border flex items-center justify-center ${TONE_ICON[tone]}`}>
          <Icon className="w-3.5 h-3.5" aria-hidden="true" />
        </div>
      </div>
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-3xl font-bold tracking-tight text-bh-text">
          {value.toLocaleString()}
        </span>
        {badge && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-zinc-100 text-zinc-500 border border-zinc-200">
            {badge}
          </span>
        )}
      </div>
      <p className="text-xs text-bh-text-dim">{hint}</p>
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
  const feedToken = typeof (query as typeof query & { feedToken?: unknown }).feedToken === 'string'
    ? (query as typeof query & { feedToken: string }).feedToken
    : ''
  const rssUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/api/feeds/${query.id}?format=rss&token=${encodeURIComponent(feedToken)}`

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
    } catch (e) {
      setExportMsg({ ok: false, text: e instanceof Error ? e.message : 'Export failed' })
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
    } catch (e) {
      setExportMsg({ ok: false, text: e instanceof Error ? e.message : 'Delete failed' })
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
          <p className="text-[10px] text-bh-text-dim mt-1 flex items-center gap-1">
            <Clock className="w-2.5 h-2.5" aria-hidden="true" />
            saved {formatDistanceToNow(new Date(query.createdAt))}
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
          <a href={runUrl} className="btn-secondary btn-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2" title="Re-run this search">
            Run <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </a>

          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              disabled={exporting !== null || deleting}
              className="btn-secondary btn-sm p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
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
                    className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-bh-text hover:bg-bh-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
                  >
                    <Download className="w-3.5 h-3.5" aria-hidden="true" />
                    Export people (CSV)
                  </button>
                </li>
                <li role="none">
                  <button
                    role="menuitem"
                    onClick={() => handleExport('resources')}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-bh-text hover:bg-bh-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
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
                    className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-bh-text hover:bg-bh-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
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
              className="btn-ghost btn-sm p-1.5 text-bh-text-dim hover:text-bh-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-danger focus-visible:ring-offset-2"
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
                className="btn-sm p-1.5 bg-bh-danger/20 text-bh-danger border border-bh-danger/30 rounded hover:bg-bh-danger/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-danger focus-visible:ring-offset-2"
                aria-label="Confirm delete"
                title="Confirm delete"
              >
                {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={deleting}
                className="btn-ghost btn-sm p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
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
