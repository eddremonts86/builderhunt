import * as React from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { RecommendationsSection } from './RecommendationsSection'
import { OnboardingBanner } from './OnboardingBanner'
import { PendingInvitationsBanner } from './PendingInvitationsBanner'
import { Link } from '@tanstack/react-router'
import {
  Users, TrendingUp, Bookmark, StickyNote, ExternalLink, Plus,
  Search, ArrowRight, Sparkles, Activity, Download, Rss, Trash2,
  MoreVertical, Loader2, Check, X, Clock, Radio, Link2, Lock,
} from 'lucide-react'
import { formatDistanceToNow } from '~/shared/lib/format'
import { fadeInUp } from '~/shared/lib/motion/tokens'
import { Button, LinkButton } from '~/components/ui'
import { BentoRegion, BentoTileHeader, BentoTileList } from '~/modules/dashboard/ui/bento/Bento'
import { DensityToggle } from '~/modules/dashboard/ui/bento/DensityToggle'
import { useBentoDensity } from '~/modules/dashboard/ui/bento/useBentoDensity'
import type { BentoWidget } from '~/modules/dashboard/ui/bento/layout'
import { ActivityWidget } from '~/modules/dashboard/ui/home/ActivityWidget'
import { MetricWidget, type MetricWidgetProps } from '~/modules/dashboard/ui/home/MetricWidget'
import { RecentBuildersWidget } from '~/modules/dashboard/ui/home/RecentBuildersWidget'
import { SprintsWidget, type SprintListItem } from '~/modules/dashboard/ui/home/SprintsWidget'
import { AlertsWidget, type AlertTrigger } from '~/modules/dashboard/ui/home/AlertsWidget'
import { PlanUsageWidget, type PlanUsage } from '~/modules/dashboard/ui/home/PlanUsageWidget'
import { SavedQueryVisibilityBadge, type SavedQueryVisibility } from '~/modules/dashboard/components/SavedQueryVisibilityBadge'
import type { PlanTier } from '~/shared/lib/billing-shared'
import { SourceMixWidget } from '~/modules/dashboard/ui/home/SourceMixWidget'

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
  radarSlug?: string | null
  /**
   * Visibility of the saved query inside its organization.
   * `private` is the creator-only default; `organization` is the
   * team-shared state set via the visibility endpoint. The
   * `createdByUserId` is what gates who can flip the value.
   */
  visibility?: SavedQueryVisibility
  createdByUserId?: string
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

/**
 * Everything the home widgets are allowed to read. Widgets never fetch; the page
 * fetches once and hands the result down, so a widget renders identically in
 * both densities and can be tested without a network.
 */
interface HomeContext {
  stats: Stats | null
  queries: SavedQuery[]
  recent: RecentBuilder[]
  sprints: SprintListItem[]
  triggers: AlertTrigger[]
  planUsage: PlanUsage | null
  error: string | null
  statsData: MetricWidgetProps[]
  onQueriesChanged: () => void
  currentUserId: string
}

/**
 * The home dashboard, as a registry.
 *
 * Adding a widget is: write a component under `ui/home/` (see `ActivityWidget`
 * for the contract), then append one entry here with its size. Nothing else in
 * this file, and nothing in the shell, has to change.
 *
 * Spans are chosen from what each widget's content needs, not from what makes a
 * pleasing shape. The first pass did the opposite: the recommendations grid was
 * given 5 columns because 5 balanced the row, and every builder name in it
 * truncated to "free…". Each entry now also declares `minSpan`, the width below
 * which it stops being readable, and the resolver refuses to go under it.
 *
 * Column budget at `xl` (grid is 12 wide, so each row must total 12):
 *   row 1   activity 4 + four metrics 2 each        = 12
 *   row 2   recommendations 8 + recent builders 4   = 12
 *   row 3   saved searches 12                       = 12
 * `xlColumnsUsed` in layout.test.ts checks this after a change; a total that is
 * not a multiple of 12 means a trailing gap on the last row.
 */
const HOME_WIDGETS: ReadonlyArray<BentoWidget<HomeContext>> = [
  {
    id: 'first-hunt',
    span: 'full',
    chrome: 'glow',
    // The empty-state CTA outranks everything when there is nothing to show.
    isVisible: (ctx) => (!ctx.stats || ctx.stats.totalBuilders === 0) && !ctx.error,
    render: () => (
      <div className="p-6 text-center">
        <div className="inline-flex w-12 h-12 rounded-xl bg-bh-accent-soft border border-bh-accent/20 items-center justify-center mb-4">
          <Sparkles className="w-6 h-6 text-bh-accent" aria-hidden="true" />
        </div>
        <h3 className="text-xl font-semibold mb-2 text-bh-text">Run your first hunt</h3>
        <p className="text-sm text-bh-text-muted max-w-md mx-auto mb-4 font-light">
          Pick a topic you care about, a framework, a stack, a community, and we'll surface
          the people actively shipping in it.
        </p>
        <LinkButton to="/search" variant="primary" size="sm" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2">
          Start your first hunt <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
        </LinkButton>
      </div>
    ),
  },

  // Widths only. Every tile is as tall as its content and the grid backfills, so
  // the bands below describe how widths tile the field, not fixed heights.
  // Band 1 — four quarters. 4 x 3 = 12.
  ...(['builders', 'active', 'searches', 'notes'] as const).map((key, index) => ({
    id: `stat-${key}`,
    span: 'quarter' as const,
    minSpan: 'quarter' as const,
    // `MetricWidget` reveals its hint and badge only when the tile can hold
    // them, so a quarter is genuinely its floor rather than a squeeze.
    sectionGroup: 'metrics',
    render: (ctx: HomeContext) => <MetricWidget {...ctx.statsData[index]} />,
  })),

  // Band 2 — two halves. 6 + 6 = 12.
  {
    id: 'activity',
    span: 'half',
    minSpan: 'third',
    render: (ctx) => <ActivityWidget points={ctx.stats?.dailyActivity ?? []} />,
  },
  {
    id: 'sprints',
    span: 'half',
    minSpan: 'third',
    render: (ctx) => <SprintsWidget sprints={ctx.sprints} />,
  },

  // Band 3 — the picks grid plus the alert feed beside it. 8 + 4 = 12.
  {
    id: 'recommendations',
    // The widest widget on the page because it is the only one holding a card
    // grid. Below a half its cards cannot show a name and a bio at once.
    span: 'twoThirds',
    minSpan: 'half',
    render: () => <RecommendationsSection limit={4} />,
  },
  {
    id: 'alerts',
    span: 'third',
    minSpan: 'quarter',
    render: (ctx) => <AlertsWidget triggers={ctx.triggers} />,
  },

  // Band 4 — saved searches need width for their four row actions. 8 + 4 = 12.
  {
    id: 'saved-searches',
    span: 'twoThirds',
    minSpan: 'half',
    isEmpty: (ctx) => ctx.queries.length === 0,
    // The empty state is a short call to action, not a list, so it gives width
    // back. `minSpan` clamps the collapse.
    whenEmpty: 'third',
    render: (ctx) => (
      <>
        <BentoTileHeader
          id="queries-heading"
          title="Saved searches"
          icon={Bookmark}
          tone="warning"
          action={ctx.queries.length > 0 ? (
            <Link to="/search" className="text-xs text-bh-accent hover:underline flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 rounded px-0.5">
              New search <ArrowRight className="w-3 h-3" aria-hidden="true" />
            </Link>
          ) : undefined}
        />
        {ctx.queries.length === 0 ? (
          <div className="text-center py-6 bg-bh-bg-alt/50 rounded-xl border border-bh-border border-dashed p-4">
            <Bookmark className="w-8 h-8 text-bh-text-dim mx-auto mb-2 opacity-50" aria-hidden="true" />
            <p className="font-semibold text-sm text-bh-text mb-1">No saved searches yet</p>
            <p className="text-xs text-bh-text-muted mb-3 font-light">Saved searches let you re-run hunts with one click.</p>
            <LinkButton to="/search" variant="secondary" size="sm" className="text-xs py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2">
              Set up a search
            </LinkButton>
          </div>
        ) : (
          <BentoTileList>
            <ul>
              {ctx.queries.map((q) => (
                <SavedSearchRow key={q.id} query={q} onDeleted={ctx.onQueriesChanged} currentUserId={ctx.currentUserId} />
              ))}
            </ul>
          </BentoTileList>
        )}
      </>
    ),
  },
  {
    id: 'recent-builders',
    span: 'third',
    minSpan: 'third',
    isEmpty: (ctx) => ctx.recent.length === 0,
    render: (ctx) => (
      <>
        <BentoTileHeader
          id="builders-heading"
          title="Recent builders"
          icon={Activity}
          tone="success"
          action={ctx.recent.length > 0 ? (
            <Link to="/search" className="text-xs text-bh-accent hover:underline flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 rounded px-0.5">
              See all <ArrowRight className="w-3 h-3" aria-hidden="true" />
            </Link>
          ) : undefined}
        />
        {ctx.recent.length === 0 ? (
          <div className="text-center py-6 bg-bh-bg-alt/50 rounded-xl border border-bh-border border-dashed p-4">
            <Users className="w-8 h-8 text-bh-text-dim mx-auto mb-2 opacity-50" aria-hidden="true" />
            <p className="font-semibold text-sm text-bh-text mb-1">No builders tracked yet</p>
            <p className="text-xs text-bh-text-muted mb-3 font-light">Save builders from searches to see them here.</p>
            <LinkButton to="/search" variant="secondary" size="sm" className="text-xs py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2">
              Run a search
            </LinkButton>
          </div>
        ) : (
          <RecentBuildersWidget builders={ctx.recent} />
        )}
      </>
    ),
  },

  // Band 5 — thirds, so dense placement can slot them into the 4-column channel
  // left beside an 8-column tile rather than starting a band of their own.
  {
    id: 'plan-usage',
    span: 'third',
    minSpan: 'quarter',
    // Hidden rather than shrunk: without a tier from /api/plans/me there is no
    // limit to measure against, and a usage meter with no limit says nothing.
    isEmpty: (ctx) => ctx.planUsage === null,
    whenEmpty: 'hide',
    render: (ctx) => (ctx.planUsage ? <PlanUsageWidget usage={ctx.planUsage} /> : null),
  },
  {
    id: 'source-mix',
    span: 'third',
    minSpan: 'quarter',
    isEmpty: (ctx) => ctx.recent.length === 0,
    whenEmpty: 'hide',
    render: (ctx) => <SourceMixWidget builders={ctx.recent} />,
  },
]

export function DashboardPage() {
  const reduceMotion = useReducedMotion()
  const [density, setDensity] = useBentoDensity()
  const [stats, setStats] = React.useState<Stats | null>(null)
  const [queries, setQueries] = React.useState<SavedQuery[]>([])
  const [recent, setRecent] = React.useState<RecentBuilder[]>([])
  const [sprints, setSprints] = React.useState<SprintListItem[]>([])
  const [triggers, setTriggers] = React.useState<AlertTrigger[]>([])
  const [planTier, setPlanTier] = React.useState<PlanTier | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  // The principal's id is what gates the visibility-flip action on a
  // saved query: only the creator can flip private <-> organization.
  // The dashboard fetches it once alongside the other top-level
  // endpoints; the SavedSearchRow reads it from the bento context.
  const [currentUserId, setCurrentUserId] = React.useState<string | null>(null)

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
    // Aborted on unmount. A client-side navigation away from the dashboard —
    // back/forward, or a link — cancels these three in flight, and the browser
    // surfaces that as `TypeError: Failed to fetch`. Logging it as a dashboard
    // failure was wrong twice over: it put an error in every user's console for
    // the ordinary act of leaving a page, and it made three e2e specs flaky for
    // a reason that was never a defect.
    const controller = new AbortController()
    const { signal } = controller

    Promise.all([
      fetch('/api/dashboard/stats', { credentials: 'include', signal }).then(async (r) => {
        if (!r.ok) throw new Error(`stats: ${r.status}`)
        return r.json()
      }),
      fetch('/api/queries', { credentials: 'include', signal }).then(async (r) => {
        if (!r.ok) return []
        return r.json()
      }).catch(() => []),
      fetch('/api/builders/recent', { credentials: 'include', signal }).then(async (r) => {
        if (!r.ok) return []
        return r.json()
      }).catch(() => []),
      fetch('/api/auth/get-session', { credentials: 'include', signal }).then(async (r) => {
        if (!r.ok) return null
        return r.json()
      }).catch(() => null),
    ])
      .then(([s, q, r, sess]) => {
        if (signal.aborted) return
        setStats(s)
        setQueries(Array.isArray(q) ? q : [])
        setRecent(Array.isArray(r) ? r : [])
        setCurrentUserId(sess?.user?.id ?? null)
        setLoading(false)
      })
      .catch((err) => {
        // The component is gone; there is nobody to show an error to and
        // nothing failed.
        if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) return
        console.error('Dashboard load error:', err)
        setError(err.message ?? 'Failed to load dashboard')
        setLoading(false)
      })

    return () => controller.abort()
  }, [])

  // Memoised because it feeds `widgetContext`, which feeds the bento's layout
  // memo — a fresh array every render would defeat both.
  const statsData = React.useMemo<MetricWidgetProps[]>(() => {
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

    return [
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
      // Derived from the live `queries` list (already refetched after
      // create/delete) rather than the separate `stats.savedQueries` count,
      // which only loads once on mount and otherwise goes stale — e.g. right
      // after deleting a saved search, the list below updates immediately
      // but this count wouldn't until a full page reload.
      value: queries.length,
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
  }, [stats, queries])

  // One object for the whole registry. Memoised on the data it closes over, so
  // `BentoRegion`'s layout memo doesn't recompute on every parent render.
  const widgetContext = React.useMemo<HomeContext>(
    () => ({
      stats,
      queries,
      recent,
      sprints,
      triggers,
      error,
      statsData,
      planUsage: planTier
        ? { tier: planTier, savedSearches: queries.length, savedBuilders: stats?.totalBuilders ?? 0 }
        : null,
      onQueriesChanged: refetchQueries,
      currentUserId: currentUserId ?? '',
    }),
    [stats, queries, recent, sprints, triggers, planTier, error, statsData, refetchQueries, currentUserId],
  )

  React.useEffect(() => {
    // Secondary panels load independently of the primary three. Each failure is
    // contained to its own widget, which then renders its empty state — the
    // alternative is one unavailable endpoint blanking the whole overview.
    const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])
    fetch('/api/sprints', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setSprints(asArray<SprintListItem>(rows)))
      .catch(() => setSprints([]))
    fetch('/api/alerts/triggers', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setTriggers(asArray<AlertTrigger>(rows)))
      .catch(() => setTriggers([]))
    fetch('/api/plans/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { plan?: { plan?: PlanTier } } | null) => setPlanTier(body?.plan?.plan ?? null))
      .catch(() => setPlanTier(null))
  }, [])

  if (loading) {
    return (
      <div data-dashboard-state="loading">
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

  return (
    // `data-dashboard-state` is the settle signal the e2e suite waits on before
    // navigating away: the three post-mount fetches are done, so nothing is left
    // to abort. It used to key off `#stats-heading`, an accessibility heading
    // that the bento rewrite legitimately removed — every dashboard test then
    // timed out, unnoticed, because CI ran only one spec. An explicit attribute
    // cannot be refactored away by accident the way incidental markup can.
    <motion.div
      data-dashboard-state="ready"
      initial={reduceMotion ? false : fadeInUp.initial}
      animate={fadeInUp.animate}
      transition={fadeInUp.transition}
    >
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
            <DensityToggle density={density} onChange={setDensity} />
            <LinkButton to="/search" variant="secondary" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2">
              <Search className="w-4 h-4" aria-hidden="true" /> Search
            </LinkButton>
            <LinkButton to="/search" variant="primary" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2">
              <Plus className="w-4 h-4" aria-hidden="true" /> New hunt
            </LinkButton>
          </div>
        </div>
      </header>

      {/* Both banners self-hide by returning null, so they stay outside the
          bento: a tile wrapping a null-rendering banner would still occupy its
          grid cell and leave a hole. */}
      <div className="mb-4 space-y-4">
        <PendingInvitationsBanner />
        <OnboardingBanner />
      </div>

      <BentoRegion
        label="Resumen"
        widgets={HOME_WIDGETS}
        ctx={widgetContext}
        density={density}
      />

      {error && (
        <div className="mt-6 p-4 rounded-lg border border-bh-danger/30 bg-bh-danger/10 text-sm text-bh-danger font-light">
          <strong>Heads up:</strong> {error}. Some data may be missing.
        </div>
      )}
    </motion.div>
  )
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Subcomponents                                                              */
/* ─────────────────────────────────────────────────────────────────────────── */

/* -------------------------------------------------------------------------- */
/*  SavedSearchRow — Run / Export / RSS / Delete actions per query              */
/* -------------------------------------------------------------------------- */
function SavedSearchRow({
  query,
  onDeleted,
  currentUserId,
}: {
  query: SavedQuery
  onDeleted: () => Promise<void> | void
  currentUserId: string
}) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [exporting, setExporting] = React.useState<'people' | 'resources' | null>(null)
  const [exportMsg, setExportMsg] = React.useState<{ ok: boolean; text: string } | null>(null)
  const [confirming, setConfirming] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [radarSlug, setRadarSlug] = React.useState<string | null>(query.radarSlug ?? null)
  const [sharing, setSharing] = React.useState(false)
  const [visibility, setVisibility] = React.useState<SavedQueryVisibility>(query.visibility ?? 'private')
  const [changingVisibility, setChangingVisibility] = React.useState(false)
  const menuRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const runUrl = `/search?q=${encodeURIComponent(query.keywords.join(' '))}`
  const [feedUrl, setFeedUrl] = React.useState<string | null>(null)

  // Feed links need a real `feed_capabilities` token, which only exists once minted — there is no
  // stable URL to build ahead of time. Mint once on first use and cache it for the rest of this
  // component's lifetime.
  const ensureFeedUrl = async () => {
    if (feedUrl) return feedUrl
    const res = await fetch(`/api/queries/${query.id}/feed-capability`, {
      method: 'POST',
      credentials: 'include',
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error ?? `HTTP ${res.status}`)
    }
    const data = await res.json()
    const absolute = `${typeof window !== 'undefined' ? window.location.origin : ''}${data.url}`
    setFeedUrl(absolute)
    return absolute
  }

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
      const url = await ensureFeedUrl()
      await navigator.clipboard.writeText(url)
      setExportMsg({ ok: true, text: 'RSS feed URL copied to clipboard' })
      setTimeout(() => setExportMsg(null), 4000)
    } catch (e) {
      setExportMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed to create feed link' })
      setTimeout(() => setExportMsg(null), 6000)
    }
  }

  const openInFeedly = async () => {
    setMenuOpen(false)
    try {
      const url = await ensureFeedUrl()
      window.open(`https://feedly.com/i/subscription/feed/${encodeURIComponent(url)}`, '_blank', 'noopener,noreferrer')
    } catch (e) {
      setExportMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed to create feed link' })
      setTimeout(() => setExportMsg(null), 6000)
    }
  }

  const openInInoreader = async () => {
    setMenuOpen(false)
    try {
      const url = await ensureFeedUrl()
      window.open(`https://www.inoreader.com/?add_feed=${encodeURIComponent(url)}`, '_blank', 'noopener,noreferrer')
    } catch (e) {
      setExportMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed to create feed link' })
      setTimeout(() => setExportMsg(null), 6000)
    }
  }

  const toggleShare = async () => {
    setMenuOpen(false)
    setSharing(true)
    try {
      if (radarSlug) {
        const res = await fetch(`/api/queries/${query.id}/share`, { method: 'DELETE', credentials: 'include' })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error ?? `HTTP ${res.status}`)
        }
        setRadarSlug(null)
        setExportMsg({ ok: true, text: 'Radar unshared — the public link no longer works' })
      } else {
        const res = await fetch(`/api/queries/${query.id}/share`, { method: 'POST', credentials: 'include' })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error ?? `HTTP ${res.status}`)
        }
        const data = await res.json() as { slug: string; url: string }
        setRadarSlug(data.slug)
        const fullUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}${data.url}`
        await navigator.clipboard.writeText(fullUrl).catch(() => {})
        setExportMsg({ ok: true, text: 'Shared! Public link copied to clipboard' })
      }
      setTimeout(() => setExportMsg(null), 5000)
    } catch (e) {
      setExportMsg({ ok: false, text: e instanceof Error ? e.message : 'Share failed' })
      setTimeout(() => setExportMsg(null), 5000)
    } finally {
      setSharing(false)
    }
  }

  const copyRadarLink = async () => {
    setMenuOpen(false)
    if (!radarSlug) return
    const fullUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/r/${radarSlug}`
    try {
      await navigator.clipboard.writeText(fullUrl)
      setExportMsg({ ok: true, text: 'Public radar link copied to clipboard' })
      setTimeout(() => setExportMsg(null), 4000)
    } catch {
      setExportMsg({ ok: false, text: 'Copy failed — link: ' + fullUrl })
      setTimeout(() => setExportMsg(null), 6000)
    }
  }

  // Visibility flip is gated to the creator. The repository's
  // `changeSavedQueryVisibilityForPrincipal` enforces the same rule
  // server-side (resource:share on a creator-only-or-shared
  // admin row); this gate just keeps the menu from offering an
  // action that would 403.
  const canChangeVisibility = query.createdByUserId === currentUserId

  const toggleVisibility = async () => {
    setMenuOpen(false)
    setChangingVisibility(true)
    const next: SavedQueryVisibility = visibility === 'organization' ? 'private' : 'organization'
    try {
      const res = await fetch(`/api/queries/${query.id}/visibility`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: next }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      setVisibility(next)
      setExportMsg({
        ok: true,
        text: next === 'organization' ? 'Now shared with your team.' : 'Now private to you.',
      })
      setTimeout(() => setExportMsg(null), 4000)
    } catch (e) {
      setExportMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not change visibility.' })
      setTimeout(() => setExportMsg(null), 5000)
    } finally {
      setChangingVisibility(false)
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
      <div className="flex flex-col gap-2 @sm:flex-row @sm:items-start @sm:justify-between @sm:gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-medium text-bh-text truncate" title={query.name}>{query.name}</p>
            <SavedQueryVisibilityBadge visibility={visibility} />
          </div>
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

        <div className="flex items-center gap-1 self-start @sm:shrink-0">
          <a href={runUrl} className="btn-secondary btn-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2" title="Re-run this search">
            Run <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </a>

          <div ref={menuRef} className="relative">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setMenuOpen((o) => !o)}
              disabled={exporting !== null || deleting}
              className="p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
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
            </Button>
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
                {canChangeVisibility && (
                  <li role="none">
                    <button
                      role="menuitem"
                      onClick={toggleVisibility}
                      disabled={changingVisibility}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-bh-text hover:bg-bh-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                      data-testid={`query-visibility-toggle-${query.id}`}
                    >
                      {visibility === 'organization' ? (
                        <>
                          <Lock className="w-3.5 h-3.5" aria-hidden="true" />
                          Make private
                        </>
                      ) : (
                        <>
                          <Users className="w-3.5 h-3.5" aria-hidden="true" />
                          Share with team
                        </>
                      )}
                    </button>
                  </li>
                )}
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
                <li role="none">
                  <button
                    role="menuitem"
                    onClick={openInFeedly}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-bh-text hover:bg-bh-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
                  >
                    <ExternalLink className="w-3.5 h-3.5 text-bh-text-dim" aria-hidden="true" />
                    Open in Feedly
                  </button>
                </li>
                <li role="none">
                  <button
                    role="menuitem"
                    onClick={openInInoreader}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-bh-text hover:bg-bh-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
                  >
                    <ExternalLink className="w-3.5 h-3.5 text-bh-text-dim" aria-hidden="true" />
                    Open in Inoreader
                  </button>
                </li>
                <li role="none">
                  <div className="my-1 border-t border-bh-border" />
                </li>
                <li role="none">
                  <button
                    role="menuitem"
                    onClick={toggleShare}
                    disabled={sharing}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-bh-text hover:bg-bh-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 disabled:opacity-60"
                  >
                    <Radio className={`w-3.5 h-3.5 ${radarSlug ? 'text-bh-success' : 'text-bh-text-dim'}`} aria-hidden="true" />
                    {radarSlug ? 'Unshare public radar' : 'Share publicly'}
                  </button>
                </li>
                {radarSlug && (
                  <li role="none">
                    <button
                      role="menuitem"
                      onClick={copyRadarLink}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-bh-text hover:bg-bh-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
                    >
                      <Link2 className="w-3.5 h-3.5 text-bh-text-dim" aria-hidden="true" />
                      Copy public link
                    </button>
                  </li>
                )}
              </ul>
            )}
          </div>

          {!confirming ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(true)}
              disabled={deleting || exporting !== null}
              className="p-1.5 text-bh-text-dim hover:text-bh-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-danger focus-visible:ring-offset-2"
              aria-label="Delete saved search"
              title="Delete"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            </Button>
          ) : (
            <div className="flex items-center gap-1">
              {/* Not converted to <Button>: this uses only the `btn-sm` size
                  modifier with fully custom danger colors (bg/border/hover),
                  not one of Button's variant classes (btn-primary/secondary/
                  ghost/danger/danger-outline). Button always injects a
                  variant class (defaulting to btn-primary) alongside size,
                  which would layer a second background/border on top of
                  these custom classes and visibly change this control. */}
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(false)}
                disabled={deleting}
                className="p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
                aria-label="Cancel delete"
                title="Cancel"
              >
                <X className="w-3.5 h-3.5" />
              </Button>
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
