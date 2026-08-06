import * as React from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { RecommendationsSection } from './RecommendationsSection'
import { OnboardingBanner } from './OnboardingBanner'
import { Link } from '@tanstack/react-router'
import {
  Users, TrendingUp, Bookmark, ExternalLink,
  Search, ArrowRight, Sparkles, Activity, Download, Rss, Trash2,
  MoreVertical, Loader2, Check, X, Clock, Radio, Link2, Lock, TriangleAlert, CalendarClock, Gauge, UserSearch, UserPlus, Bell, ListChecks, Send, History, SlidersHorizontal, BadgeCheck,
} from 'lucide-react'
import { formatDistanceToNow } from '~/shared/lib/format'
import { fadeInUp } from '~/shared/lib/motion/tokens'
import { Button, LinkButton } from '~/components/ui'
import { BentoRegion, BentoTileHeader, BentoTileList } from '~/modules/dashboard/ui/bento/Bento'
import { rendersForData } from '~/modules/dashboard/ui/bento/layout'
import { WidgetFrame } from '~/modules/dashboard/ui/WidgetFrame'
import { ActionQueueWidget } from './ActionQueueWidget'
import { UpcomingWidget } from './UpcomingWidget'
import { WorkspaceUsageWidget } from './WorkspaceUsageWidget'
import { CandidatesToReviewWidget } from './CandidatesToReviewWidget'
import { InvitationStatusWidget } from './InvitationStatusWidget'
import { ProfileOwnerWidget } from './ProfileOwnerWidget'
import { DashboardCustomizeDialog } from './DashboardCustomizeDialog'
import { BarSeries, utcWeekdayLabel } from '~/modules/dashboard/ui/BarSeries'
import { useDashboardOverview, type DashboardOverviewResult } from '~/modules/dashboard/lib/use-dashboard-overview'
import { DensityToggle } from '~/modules/dashboard/ui/bento/DensityToggle'
import { useDashboardPreferences } from '~/modules/dashboard/ui/bento/useBentoDensity'
import { useViewerRole } from '~/modules/dashboard/lib/use-viewer-role'
import { defineWidgetRegistry, moveWidgetInOrder, orderedWidgets } from '~/modules/dashboard/lib/widget-registry'
import type { WidgetDependency } from '~/modules/dashboard/lib/contracts'
import { ActivityWidget } from '~/modules/dashboard/ui/home/ActivityWidget'
import { MetricWidget, type MetricWidgetProps } from '~/modules/dashboard/ui/home/MetricWidget'
import { RecentBuildersWidget } from '~/modules/dashboard/ui/home/RecentBuildersWidget'
import { SprintsWidget, type SprintListItem } from '~/modules/dashboard/ui/home/SprintsWidget'
import { AlertsWidget, type AlertTrigger } from '~/modules/dashboard/ui/home/AlertsWidget'
import { SavedQueryVisibilityBadge, type SavedQueryVisibility } from '~/modules/dashboard/components/SavedQueryVisibilityBadge'
import { SourceMixWidget } from '~/modules/dashboard/ui/home/SourceMixWidget'

interface Stats {
  totalBuilders: number
  /**
   * Tracked builders whose identity was last observed by a connector inside the window — a recency
   * fact, not a count of things they did. The dashboard copy says "Seen active" for exactly that
   * reason; it used to say "Shipped something in the last 7 days", which this column cannot support.
   */
  activeThisWeek: number
  savedQueries: number
  totalNotes: number
  /** Renamed from `dailyActivity`: it is one bucket per tracked builder by last-seen day. */
  lastSeenByDay?: Array<{ date: string; label: string; count: number }>
  generatedAt?: string
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
  error: string | null
  statsData: MetricWidgetProps[]
  onQueriesChanged: () => void
  currentUserId: string
  /**
   * The versioned core projection. Widgets read a *section* from it and get a `WidgetState`, so a
   * failed section renders as a failure rather than as an empty list — which is the difference the
   * seven-fetch version could not express.
   */
  overview: DashboardOverviewResult
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
 * Column budget at `xl` (grid is 12 wide, so each band must total 12):
 *   band 1  three metrics 4 each                    = 12
 *   band 2  recency 6 + sprints 6                   = 12
 *   band 3  recommendations 8 + alerts 4            = 12
 *   band 4  saved searches 8 + recent builders 4    = 12
 *   band 5  plan usage 6 + source coverage 6        = 12
 * `xlColumnsUsed` in layout.test.ts checks this after a change. Since placement
 * became sparse a short band leaves a real gap rather than pulling a later tile
 * up into it — which is the trade that bought a stable reading order.
 */
/**
 * Capabilities that have actually shipped.
 *
 * A widget declaring a dependency absent from this set is omitted entirely rather than rendered
 * empty. `pipeline` and `saved-search-health` are named in the spec's widget catalog and do not
 * exist; listing them here before they do would put two permanently blank tiles on every dashboard.
 */
const SHIPPED_CAPABILITIES: ReadonlySet<WidgetDependency> = new Set<WidgetDependency>([
  'shortlists',
  'invitations',
  'calendar',
  'team-activity',
  'source-coverage',
])

/**
 * Headline-metric labels, so the registry's accessible name matches the tile's own.
 *
 * "Saved searches count" rather than "Saved searches", which is what the tile shows: the
 * `saved-searches` widget below already owns that title, and `defineWidgetRegistry` refuses a
 * duplicate. The two were distinguishable on the page — a number in a metric tile, a list of searches
 * — and identical in the Customize dialog, which lists titles in a flat column and labels every
 * control with them ("Move Saved searches up", twice).
 */
const STAT_TITLES = ['Builders tracked', 'Seen active', 'Saved searches count'] as const
const ctxTitle = (index: number) => STAT_TITLES[index] ?? 'Metric'

const HOME_WIDGETS = defineWidgetRegistry<HomeContext>([
  {
    id: 'first-hunt',
    title: 'Run your first hunt',
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

  /*
   * The action queue is first, and that is the product's whole thesis: the dashboard answers "what
   * needs my attention now?" before it answers anything else. It renders nothing when the queue is
   * empty (`whenEmpty: 'hide'`) rather than occupying the top of the page with a reassurance —
   * "nothing needs attention" is worth exactly one glance and then becomes furniture.
   */
  {
    id: 'action-queue',
    title: 'Needs your attention',
    // A payment failure or a blocked interview is not a preference. `orderedWidgets` ignores a hide
    // on a critical widget.
    criticality: 'critical',
    span: 'full',
    isEmpty: (ctx) => {
      const state = ctx.overview.section('actionQueue')
      return state.kind === 'empty'
    },
    whenEmpty: 'hide',
    render: (ctx) => (
      <WidgetFrame
        title="Needs your attention"
        icon={TriangleAlert}
        tone="warning"
        state={ctx.overview.section('actionQueue')}
        onRetry={ctx.overview.refetch}
      >
        {(queue) => <ActionQueueWidget items={queue.items} />}
      </WidgetFrame>
    ),
  },

  // Widths only. Every tile is as tall as its content, so the bands below describe how widths tile
  // the field, not fixed heights. Placement is sparse (see `BentoGrid`), so a band that does not
  // total 12 now leaves a real trailing gap instead of pulling a later tile up into it.
  //
  // Band 1 — three thirds. 3 x 4 = 12. It was four quarters until Private notes was retired for
  // answering no question; the survivors widen rather than leaving a quarter-width hole.
  ...(['builders', 'active', 'searches'] as const).map((key, index) => ({
    id: `stat-${key}`,
    // The registry's `title` is the accessible name a future Customize dialog lists a widget under.
    // Nothing renders it today — each widget passes its own heading to `WidgetFrame` — but the
    // fallback is the id, and a dialog offering "stat-builders" is worse than one offering the label
    // the tile actually shows.
    title: ctxTitle(index),
    span: 'third' as const,
    minSpan: 'quarter' as const,
    // `MetricWidget` reveals its hint and badge only when the tile can hold
    // them, so a quarter is genuinely its floor rather than a squeeze.
    sectionGroup: 'metrics',
    render: (ctx: HomeContext) => <MetricWidget {...ctx.statsData[index]} />,
  })),

  /*
   * Second, right after the queue: "what is happening next" is the dashboard's second question, and
   * an agenda that sits below three analytics tiles is not answering it. Hidden when the week is
   * empty rather than showing a reassurance nobody re-reads.
   */
  {
    id: 'upcoming',
    title: 'Today and upcoming',
    dependsOn: ['calendar'],
    span: 'full',
    isEmpty: (ctx) => ctx.overview.section('upcoming').kind === 'empty',
    whenEmpty: 'hide',
    render: (ctx) => (
      <WidgetFrame
        title="Today and upcoming"
        icon={CalendarClock}
        state={ctx.overview.section('upcoming')}
        onRetry={ctx.overview.refetch}
        emptyMessage="Nothing scheduled in the next 7 days."
      >
        {(agenda) => <UpcomingWidget items={agenda.items} />}
      </WidgetFrame>
    ),
  },

  /*
   * Third: "who should I review next?" — the spec's P0 widget between the queue and the analytics.
   * Placed above the metrics because a person waiting on a decision outranks a count.
   */
  {
    id: 'review',
    title: 'Candidates to review',
    span: 'full',
    isEmpty: (ctx) => ctx.overview.section('review').kind === 'empty',
    whenEmpty: 'hide',
    render: (ctx) => (
      <WidgetFrame
        title="Candidates to review"
        icon={UserSearch}
        state={ctx.overview.section('review')}
        onRetry={ctx.overview.refetch}
        emptyMessage="Nothing waiting on a decision."
      >
        {(review) => <CandidatesToReviewWidget items={review.items} />}
      </WidgetFrame>
    ),
  },

  // Band 2 — two halves. 6 + 6 = 12.
  {
    id: 'activity',
    title: 'Builder recency',
    span: 'half',
    minSpan: 'third',
    render: (ctx) => (
      <WidgetFrame
        title="Builder recency"
        icon={Activity}
        state={ctx.overview.section('recency')}
        onRetry={ctx.overview.refetch}
        emptyMessage="No tracked builder has been seen active by a source in the last 7 days."
      >
        {(recency) => (
          <ActivityWidget
            points={recency.buckets.map((bucket) => ({
              date: bucket.date,
              // Weekday label built here, in UTC, to match the bucket boundary the server used. A
              // label formatted in the viewer's zone would name a different day than the key.
              label: new Date(`${bucket.date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
              count: bucket.count,
            }))}
            generatedAt={ctx.overview.overview?.generatedAt}
          />
        )}
      </WidgetFrame>
    ),
  },
  {
    id: 'sprints',
    title: 'Sourcing sprints',
    span: 'half',
    minSpan: 'third',
    render: (ctx) => <SprintsWidget sprints={ctx.sprints} />,
  },

  /*
   * Band 2b — the two rate charts, beside each other because they are read together: "we added five
   * people this week and the alerts fired forty times" is one thought. Both hide when flat, so a
   * workspace with no activity is not handed two empty axes.
   *
   * They share `BarSeries` with the recency chart above, which is what keeps the accessible table
   * from being three hand-written copies — or two, and one forgotten.
   */
  {
    id: 'discovery-trend',
    title: 'Newly tracked',
    span: 'half',
    minSpan: 'third',
    isEmpty: (ctx) => ctx.overview.section('discoveryTrend').kind === 'empty',
    whenEmpty: 'hide',
    render: (ctx) => (
      <WidgetFrame
        title="Newly tracked"
        icon={UserPlus}
        state={ctx.overview.section('discoveryTrend')}
        onRetry={ctx.overview.refetch}
      >
        {(trend) => (
          <>
            <p className="-mt-2 mb-3 text-xs font-light text-bh-text-muted">
              Builders this workspace started tracking, by day. Adding someone is not a hire.
            </p>
            <BarSeries
              points={trend.buckets.map((bucket) => ({ key: bucket.date, label: utcWeekdayLabel(bucket.date), value: bucket.count }))}
              caption="Builders newly tracked per day."
              valueLabel="Builders tracked"
              generatedAt={ctx.overview.overview?.generatedAt}
            />
          </>
        )}
      </WidgetFrame>
    ),
  },
  {
    id: 'alert-volume',
    title: 'Alert volume',
    span: 'half',
    minSpan: 'third',
    isEmpty: (ctx) => ctx.overview.section('alertVolume').kind === 'empty',
    whenEmpty: 'hide',
    render: (ctx) => (
      <WidgetFrame
        title="Alert volume"
        icon={Bell}
        state={ctx.overview.section('alertVolume')}
        onRetry={ctx.overview.refetch}
        action={(
          <Link to="/alerts" className="text-xs text-bh-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2">
            Open alerts
          </Link>
        )}
      >
        {(volume) => (
          <>
            <p className="-mt-2 mb-3 text-xs font-light text-bh-text-muted">
              Triggers per day. Reading one does not remove it from the count.
            </p>
            <BarSeries
              points={volume.buckets.map((bucket) => ({ key: bucket.date, label: utcWeekdayLabel(bucket.date), value: bucket.count }))}
              caption="Alert triggers per day."
              valueLabel="Triggers"
              generatedAt={ctx.overview.overview?.generatedAt}
            />
          </>
        )}
      </WidgetFrame>
    ),
  },

  // Band 3 — the picks grid plus the alert feed beside it. 8 + 4 = 12.
  {
    id: 'recommendations',
    title: 'For you',
    // The widest widget on the page because it is the only one holding a card
    // grid. Below a half its cards cannot show a name and a bio at once.
    span: 'twoThirds',
    minSpan: 'half',
    render: () => <RecommendationsSection limit={4} />,
  },
  {
    id: 'alerts',
    title: 'Alerts',
    span: 'third',
    minSpan: 'quarter',
    render: (ctx) => <AlertsWidget triggers={ctx.triggers} />,
  },

  // Band 4 — saved searches need width for their four row actions. 8 + 4 = 12.
  {
    id: 'saved-searches',
    title: 'Saved searches',
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
    title: 'Recent builders',
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
    title: 'Workspace usage',
    span: 'half',
    minSpan: 'quarter',
    /*
     * Owner/admin only. The projection already omits the `usage` section for anyone else, so this is
     * belt and braces — but declaring it here is what stops the tile being *offered back* to a member
     * as a hideable widget they could "restore", which would confirm the workspace has billing.
     */
    roles: ['owner', 'admin'],
    /*
     * Reads the projection's `usage` section, which the server computes from the canonical billing
     * summary. It read `/api/plans/me` — the legacy endpoint `/api/billing/summary` replaced — and
     * then looked the limits up client-side from `PLAN_LIMITS`, inlining its own copy of
     * `resolveLegacyPlanTier` because the real helper is server-only. Two implementations of "what
     * is this plan allowed", one of them in the browser.
     *
     * The section is **absent** for a role that may not read billing, so `WidgetFrame` renders
     * `forbidden` — nothing at all. The `isEmpty` check below is only for the tenant whose billing
     * is genuinely unconfigured.
     */
    isEmpty: (ctx) => {
      const state = ctx.overview.section('usage')
      return state.kind === 'empty' || state.kind === 'forbidden'
    },
    whenEmpty: 'hide',
    render: (ctx) => (
      <WidgetFrame
        title="Workspace usage"
        icon={Gauge}
        tone="warning"
        state={ctx.overview.section('usage')}
        onRetry={ctx.overview.refetch}
      >
        {(usage) => <WorkspaceUsageWidget usage={usage} />}
      </WidgetFrame>
    ),
  },
  {
    id: 'team-activity',
    title: 'Team activity',
    dependsOn: ['team-activity'],
    span: 'half',
    minSpan: 'third',
    isEmpty: (ctx) => ctx.overview.section('activity').kind === 'empty',
    whenEmpty: 'hide',
    render: (ctx) => (
      <WidgetFrame
        title="Team activity"
        icon={History}
        state={ctx.overview.section('activity')}
        onRetry={ctx.overview.refetch}
        action={(
          <Link to="/team/activity" className="text-xs text-bh-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2">
            All activity
          </Link>
        )}
      >
        {(activity) => (
          <ul className="-mx-6 -mb-6 divide-y divide-bh-border border-t border-bh-border">
            {activity.items.map((item) => (
              <li key={item.id} className="px-6 py-2.5">
                <p className="truncate text-sm text-bh-text">
                  {item.targetHref ? (
                    // Server-resolved against the real row, so a deleted target arrives as `null`
                    // and renders as plain text instead of a link to a 404.
                    <Link to={item.targetHref} className="hover:text-bh-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 rounded">
                      {item.display}
                    </Link>
                  ) : item.display}
                </p>
                <p className="mt-0.5 text-xs font-light text-bh-text-dim">
                  {/* "Former member" rather than a blank or a raw id: `null` here means the actor is
                      unknown or has left, which is a fact worth stating. */}
                  {item.actorDisplayName ?? 'Former member'}
                  {' · '}
                  <time dateTime={item.occurredAt} title={new Date(item.occurredAt).toLocaleString()}>
                    {formatDistanceToNow(new Date(item.occurredAt))}
                  </time>
                </p>
              </li>
            ))}
          </ul>
        )}
      </WidgetFrame>
    ),
  },
  {
    id: 'invitations',
    title: 'Invitation status',
    dependsOn: ['invitations'],
    span: 'half',
    minSpan: 'third',
    isEmpty: (ctx) => ctx.overview.section('invitations').kind === 'empty',
    whenEmpty: 'hide',
    render: (ctx) => (
      <WidgetFrame
        title="Invitation status"
        icon={Send}
        state={ctx.overview.section('invitations')}
        onRetry={ctx.overview.refetch}
      >
        {(distribution) => <InvitationStatusWidget distribution={distribution} />}
      </WidgetFrame>
    ),
  },
  /*
   * Only for someone who has verified a claim on their own builder profile (plans/ui-dashboard
   * Wave 5). Everyone else never learns the tile exists.
   *
   * There is no `roles` entry because ownership is not a role — it is a fact about the person, and the
   * same person owns the same profile in every workspace. What keeps the tile out of the Customize
   * dialog for a non-owner is `isEmpty` + `whenEmpty: 'hide'` plus `rendersForData`, which the dialog
   * now filters through: a widget the layout dropped for having nothing to say occupies no position
   * there either. The section key is simply absent for a non-owner, so `WidgetFrame` sees `forbidden`
   * and renders nothing at all.
   */
  {
    id: 'profile-owner',
    title: 'Your builder profile',
    /*
     * No `dependsOn`. That field gates on a *product capability* having shipped — "the pipeline Kanban
     * exists" — and profile ownership is neither shipped nor unshipped, it is a fact about this
     * person. Declaring it there would put the widget in the "waiting on a feature" bucket for every
     * user who simply does not own a builder profile, which is a different sentence.
     */
    span: 'third',
    minSpan: 'third',
    isEmpty: (ctx) => {
      const state = ctx.overview.section('profileOwner')
      return state.kind === 'empty' || state.kind === 'forbidden'
    },
    whenEmpty: 'hide',
    render: (ctx) => (
      <WidgetFrame
        title="Your builder profile"
        icon={BadgeCheck}
        state={ctx.overview.section('profileOwner')}
        onRetry={ctx.overview.refetch}
      >
        {(profile) => <ProfileOwnerWidget profile={profile} />}
      </WidgetFrame>
    ),
  },
  {
    id: 'shortlists',
    title: 'Shortlists',
    dependsOn: ['shortlists'],
    span: 'half',
    minSpan: 'third',
    isEmpty: (ctx) => ctx.overview.section('shortlists').kind === 'empty',
    whenEmpty: 'hide',
    render: (ctx) => (
      <WidgetFrame
        title="Shortlists"
        icon={ListChecks}
        state={ctx.overview.section('shortlists')}
        onRetry={ctx.overview.refetch}
        action={(
          <Link to="/lists" className="text-xs text-bh-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2">
            All lists
          </Link>
        )}
      >
        {(shortlists) => (
          <ul className="-mx-6 -mb-6 divide-y divide-bh-border border-t border-bh-border">
            {shortlists.items.map((list) => (
              <li key={list.id} className="flex items-center gap-3 px-6 py-2.5">
                <Link
                  to="/lists/$listId"
                  params={{ listId: list.id }}
                  className="min-w-0 flex-1 truncate text-sm text-bh-text hover:text-bh-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 rounded"
                >
                  {list.name}
                </Link>
                {/* Whether a colleague can see it is the first thing a shortlist's owner needs at a
                    glance — it is a list of people they are considering. */}
                {list.visibility === 'organization' && (
                  <span className="shrink-0 rounded border border-bh-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-bh-text-dim">
                    Shared
                  </span>
                )}
                <span className="shrink-0 font-mono text-xs tabular-nums text-bh-text-dim">
                  {list.itemCount}
                </span>
              </li>
            ))}
          </ul>
        )}
      </WidgetFrame>
    ),
  },
  {
    id: 'source-mix',
    title: 'Source coverage',
    dependsOn: ['source-coverage'],
    span: 'half',
    minSpan: 'quarter',
    render: (ctx) => (
      <WidgetFrame
        title="Source coverage"
        icon={Radio}
        tone="cyan"
        state={ctx.overview.section('sourceCoverage')}
        onRetry={ctx.overview.refetch}
        emptyMessage="Track a builder and this shows which platforms your pipeline comes from."
      >
        {(coverage) => <SourceMixWidget sources={coverage.sources} totalTracked={coverage.totalTracked} />}
      </WidgetFrame>
    ),
  },
])

export function DashboardPage() {
  const reduceMotion = useReducedMotion()
  const { preferences, setDensity, toggleHidden, togglePinned, setOrder, resetPreferences } = useDashboardPreferences()
  const density = preferences.density
  const viewerRole = useViewerRole()
  const [customizeOpen, setCustomizeOpen] = React.useState(false)
  /*
   * Radix restores focus to whatever held it when the dialog opened — but this dialog is opened by a
   * state change rather than by `DialogPrimitive.Trigger`, so it has no recorded trigger to restore
   * to and a keyboard user lands on `<body>` with no visible focus. `PublicNavDrawer` documents the
   * same case and solves it the same way.
   */
  const customizeTriggerRef = React.useRef<HTMLButtonElement>(null)
  const closeCustomize = React.useCallback(() => setCustomizeOpen(false), [])
  // The versioned core projection. Sections it owns (recency, source coverage) read their state
  // from here; the remaining endpoints migrate in Wave 4.
  const overview = useDashboardOverview()
  const [stats, setStats] = React.useState<Stats | null>(null)
  const [queries, setQueries] = React.useState<SavedQuery[]>([])
  const [recent, setRecent] = React.useState<RecentBuilder[]>([])
  const [sprints, setSprints] = React.useState<SprintListItem[]>([])
  const [triggers, setTriggers] = React.useState<AlertTrigger[]>([])
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
      /*
       * `/api/dashboard/stats` still supplies the three headline counts and the saved-search badge.
       * The recency chart and source coverage have moved to `useDashboardOverview` below, which is
       * where the section states, the freshness stamps and the whole-workspace coverage figure come
       * from (plans/ui-dashboard Wave 1). The remaining counts move with Wave 4; the two endpoints
       * read the same columns with the same predicates, and the overview's `summary` section is
       * asserted against these numbers in `dashboard-and-navigation.spec.ts`.
       */
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

    /*
     * Three metrics, not four, and each one carries its own denominator or window
     * (plans/ui-dashboard Wave 0, "Correct source-mix and top-metric semantics").
     *
     * **Private notes is gone.** A count of notes answers no question and continues nowhere: knowing
     * the workspace holds 47 notes changes nothing a recruiter would do next. Its id is in
     * `RETIRED_WIDGET_IDS` so a saved preference for it cannot later attach to a different widget.
     *
     * **"Active this week" is now "Seen active", and its hint no longer says "shipped".** The
     * underlying column is `builder_identities.lastSeenAt` — the last time any connector observed
     * that person publicly. It is not a count of things they did, and the old copy claimed it was.
     */
    return [
    {
      label: 'Builders tracked',
      value: stats?.totalBuilders ?? 0,
      icon: Users,
      tone: 'accent' as const,
      hint: 'People saved to your lists',
      badge: activeSharePct !== null ? `${activeSharePct}% seen active` : undefined,
    },
    {
      label: 'Seen active',
      value: stats?.activeThisWeek ?? 0,
      icon: TrendingUp,
      tone: 'success' as const,
      hint: 'Last seen by a source in the past 7 days',
      badge: stats && stats.totalBuilders > 0 ? `of ${stats.totalBuilders} tracked` : undefined,
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
    ]
  }, [stats, queries])

  /*
   * Role eligibility, dependency gates and the user's hidden list, resolved in one pass before the
   * layout sees anything (`orderedWidgets`).
   *
   * This is what makes `widget-registry.ts` load-bearing rather than a validated module nothing
   * imported — which is what it was until now, and which this repository has a name for: a helper
   * that cannot execute reads as proof the path exists.
   *
   * Three reasons are kept distinct on purpose. "Your role may not see this" is permanent for that
   * role and must never be offered back as a restorable widget; "the capability has not shipped" is
   * about the deployment; "you hid it" is the only one a user can undo.
   *
   * `SHIPPED_CAPABILITIES` is the honest inventory: `pipeline` and `saved-search-health` are named in
   * the spec and do not exist yet, so any widget declaring them is omitted rather than rendered
   * empty — an empty "Pipeline snapshot" implies a pipeline with nothing in it.
   */
  const resolved = React.useMemo(
    () => orderedWidgets(HOME_WIDGETS, {
      role: viewerRole,
      available: SHIPPED_CAPABILITIES,
      hidden: new Set(preferences.hiddenWidgetIds),
      order: preferences.orderedWidgetIds,
      pinned: preferences.pinnedWidgetIds,
    }),
    [viewerRole, preferences.hiddenWidgetIds, preferences.orderedWidgetIds, preferences.pinnedWidgetIds],
  )
  const visibleWidgets = resolved.visible

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
      onQueriesChanged: refetchQueries,
      currentUserId: currentUserId ?? '',
      overview,
    }),
    [stats, queries, recent, sprints, triggers, error, statsData, refetchQueries, currentUserId, overview],
  )

  /*
   * What the Customize dialog may list: everything rendered, plus everything the *user* hid.
   *
   * Not the widgets omitted for `role` or `dependency`. Offering a member the chance to "restore"
   * Billing would confirm the workspace has billing and that they are outside it — the same
   * disclosure the projection avoids by omitting the section entirely — and offering to restore a
   * widget whose capability has not shipped promises a feature that does not exist.
   *
   * Sorted back into registry order so the dialog reads in the same sequence as the page, which is
   * how someone finds the widget they are looking for.
   */
  const customizableWidgets = React.useMemo(() => {
    const hiddenByUser = new Set(
      resolved.omitted.filter((entry) => entry.reason === 'hidden').map((entry) => entry.id),
    )
    /*
     * Rendered widgets first, in the page's own order, then the ones the user hid.
     *
     * The dialog's list is the thing "Move up" moves through, so it has to agree with the page or the
     * announcement lies. A hidden widget has no position on the page to agree with, so it goes after
     * everything visible — in registry order, which is where it will reappear if the user restores it
     * without also moving it.
     */
    const hiddenWidgets = HOME_WIDGETS.filter((widget) => hiddenByUser.has(widget.id))
    /*
     * `rendersForData` is the layout's own predicate, asked again here.
     *
     * Eligibility says a widget *may* be shown; the layout decides whether it has anything to say.
     * Without this filter the dialog listed "Run your first hunt" — the empty-workspace CTA, which
     * `isVisible` had already dropped from a workspace with builders in it — and every announced
     * position after it was one place out. Found by reading the rendered dialog, not by a test.
     */
    return [...visibleWidgets.filter((widget) => rendersForData(widget, widgetContext)), ...hiddenWidgets]
      .map((widget) => ({ id: widget.id, title: widget.title, criticality: widget.criticality }))
  }, [resolved.omitted, visibleWidgets, widgetContext])

  /*
   * A move rewrites the whole saved sequence, not just the pair that swapped.
   *
   * The sequence sent is the dialog's list — visible widgets plus the user's hidden ones — so a hidden
   * widget keeps its place in the order and reappears where the user left it rather than wherever the
   * registry happens to put it. Widgets omitted for role or dependency are deliberately absent: this
   * viewer cannot see them, and writing a position for one would let a saved order carry a fact about
   * a capability the workspace has not been told it has.
   */
  const moveWidget = React.useCallback((widgetId: string, direction: 'up' | 'down') => {
    const criticality = new Map(HOME_WIDGETS.map((widget) => [widget.id, widget.criticality]))
    const next = moveWidgetInOrder(
      customizableWidgets.map((widget) => widget.id),
      widgetId,
      direction,
      (id) => criticality.get(id) !== 'critical',
    )
    setOrder(next)
  }, [customizableWidgets, setOrder])

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
              {stats?.activeThisWeek
                ? ` ${stats.activeThisWeek} tracked builder${stats.activeThisWeek === 1 ? ' was' : 's were'} seen active in the last 7 days.`
                : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <DensityToggle density={density} onChange={setDensity} />
            <Button
              ref={customizeTriggerRef}
              variant="secondary"
              size="sm"
              onClick={() => setCustomizeOpen(true)}
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
            >
              <SlidersHorizontal className="h-4 w-4" aria-hidden="true" /> Customize
            </Button>
            {/*
              One primary action, not two. "Search" and "New hunt" were separate buttons pointing at
              the same `/search` route — a choice with no consequence, which costs a reader a decision
              and teaches them the labels mean nothing (plans/ui-dashboard, structural problem 7).
              The empty-workspace CTA above uses the same destination and the same verb.
            */}
            <LinkButton to="/search" variant="primary" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2">
              <Search className="w-4 h-4" aria-hidden="true" /> New hunt
            </LinkButton>
          </div>
        </div>
      </header>

      {/* Both banners self-hide by returning null, so they stay outside the
          bento: a tile wrapping a null-rendering banner would still occupy its
          grid cell and leave a hole. */}
      <div className="mb-4 space-y-4">
        <OnboardingBanner />
      </div>

      <DashboardCustomizeDialog
        open={customizeOpen}
        onClose={closeCustomize}
        returnFocusRef={customizeTriggerRef}
        widgets={customizableWidgets}
        hiddenWidgetIds={preferences.hiddenWidgetIds}
        pinnedWidgetIds={preferences.pinnedWidgetIds}
        density={density}
        onToggleHidden={toggleHidden}
        onTogglePinned={togglePinned}
        onMove={moveWidget}
        onDensityChange={setDensity}
        onReset={resetPreferences}
      />

      <BentoRegion
        label="Resumen"
        widgets={visibleWidgets}
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
  kind?: 'person' | 'repo' | 'organization'
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
