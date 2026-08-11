import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, Clock, ExternalLink } from 'lucide-react'
import type { AdminMetricSectionPayload } from '~/shared/lib/admin-metrics/contracts'
import type { MetricSectionState } from './useMetricSection'

/**
 * Renders one section's contract payload (plan 57, Admin track — the lazy widget shell).
 *
 * ## Why one renderer and not seven
 *
 * Every section returns the same body — `values`, optional `series`, optional `ranked` — and differs only in
 * which keys it fills. Seven renderers would each have to remember to print the unit, state the scope, honour
 * the threshold direction and distinguish `unavailable` from zero; the one that forgot would look like a
 * working section. Here those rules are written once and no section can opt out of them.
 *
 * That is also what makes the per-widget tasks in this plan small: a section becomes real when its *server*
 * builder gets a source, not when someone writes UI for it.
 *
 * ## The four rules this component enforces
 *
 * 1. **A unit is always printed.** `1500` is fifteen hundred requests or a second and a half.
 * 2. **A process-scoped value says so, next to itself** — not in a legend, and not in a card at the bottom of
 *    the page. Beside a `database` platform total, an unlabelled per-instance counter is a wrong number.
 * 3. **`unavailable` renders no numbers at all**, with the reason. Zeroes would read as an idle platform.
 * 4. **A threshold is read in its stated direction.** `higher_is_worse` and `lower_is_worse` are both real
 *    here — a cold cache and a hot error rate are breaches in opposite directions, and colouring one by the
 *    other's rule would raise a warning on healthy numbers and stay silent on the bad ones.
 */

const UNAVAILABLE_EXPLANATIONS: Record<string, string> = {
  insufficient_history: 'Nothing has recorded this over the requested window yet. No numbers are shown, because a zero here would read as an idle platform rather than as an absent measurement.',
  dependency_unavailable: 'The source this section reads has never produced state. This is not a count of zero.',
  not_enabled: 'The capability this section measures is switched off, so there is nothing to count.',
  timeout: 'The query for this section did not finish in time. Nothing is shown rather than a partial figure.',
  error: 'This section failed while the rest of the page loaded. Its numbers are unknown, not zero.',
}

/**
 * What every section widget receives.
 *
 * One shape for all of them so the shell can render whichever the URL selected without a per-section branch —
 * and so a widget that starts caring about the variant does not change the shell. The ones that ignore
 * `variant` simply do not destructure it.
 */
export interface SectionWidgetProps {
  state: MetricSectionState
  variant: string
}

/**
 * A plain labelled number. Flat for the same reason the value tiles are: every call site already sits inside a
 * section `card`, so a nested one paints a second border inside the first.
 */
export function MetricCard({ label, value, hint }: { label: string; value: number | string | null; hint?: string }) {
  return (
    <div className="rounded-2xl p-3 bg-bh-surface-2" data-testid={`metric-card-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      <p className="text-xs text-bh-text-dim mb-1">{label}</p>
      <p className="text-2xl font-bold text-bh-text">
        {value === null ? '—' : typeof value === 'number' ? value.toLocaleString() : value}
      </p>
      {hint && <p className="text-xs text-bh-text-dim mt-1">{hint}</p>}
    </div>
  )
}

/** Human labels for the contract's metric keys. An unmapped key falls back to its own name, never to blank. */
const VALUE_LABELS: Record<string, string> = {
  users_total: 'Total users',
  users_new_24h: 'New users (24h)',
  users_new_7d: 'New users (7d)',
  onboarding_completed: 'Onboarding completed',
  onboarding_skipped: 'Onboarding skipped',
  onboarding_completed_7d: 'Onboarding completed (7d)',
  activation_rate_7d: 'Activation rate (7d)',
  requests: 'Requests',
  errors: 'Errors',
  error_rate: 'Error rate',
  requests_per_second: 'Requests per second',
  instances_reporting: 'Instances reporting',
  latency_p50_ms: 'Latency p50',
  latency_p95_ms: 'Latency p95',
  latency_p99_ms: 'Latency p99',
  requests_over_10s: 'Requests slower than 10s',
  searches: 'Searches',
  search_cache_hits: 'Search cache hits',
  search_cache_hit_rate: 'Cache hit rate',
  discovery_cells_scanned: 'Cells scanned',
  discovery_profiles_seen: 'Profiles seen',
  discovery_profiles_stored: 'Profiles stored',
  api_requests: 'API requests',
  api_errors: 'API errors',
  signups: 'Signups',
  signins: 'Signins',
  dashboard_overview_cache_hits: 'Dashboard cache hits',
  dashboard_overview_cache_misses: 'Dashboard cache misses',
  dashboard_overview_section_failures: 'Dashboard section failures',
  process_rss_bytes: 'Process RSS',
  process_age_seconds: 'This process has been up',
  metric_lag_seconds: 'Metric lag',
  history_span_seconds: 'History available',
  reporting_instances: 'Instances reporting now',
  jobs_registered: 'Scheduled jobs',
  jobs_paused: 'Paused',
  jobs_overdue: 'Overdue',
  jobs_failed_last_run: 'Failed on last run',
  jobs_never_ran: 'Never run yet',
  job_items_failed_last_run: 'Items left unprocessed',
  sources_registered: 'Sources registered',
  sources_enabled: 'Enabled',
  sources_enabled_without_connector: 'Enabled with no connector',
  sources_enabled_terms_unreviewed: 'Enabled, terms unreviewed',
  abuse_signals: 'Abuse signals',
  abuse_signals_critical: 'Critical',
  abuse_signals_high: 'High',
  abuse_signals_medium: 'Medium',
  abuse_signals_low: 'Low',
  billing_events_pending: 'Webhook events pending',
  billing_events_processing: 'Stuck in processing',
  billing_events_failed: 'Dead-lettered',
  billing_events_processed: 'Processed',
  billing_events_ignored: 'Ignored',
  removal_requests: 'Removal requests',
  removal_pending: 'Pending',
  removal_overdue: 'Past their deadline',
  removal_expired: 'Expired',
  removal_active_suppressions: 'Active suppressions',
  incidents_open: 'Unresolved incidents',
  incidents_open_critical: 'Critical',
  incidents_open_major: 'Major',
  incidents_open_minor: 'Minor',
  incidents_oldest_critical_seconds: 'Oldest critical, unresolved for',
  incidents_oldest_major_seconds: 'Oldest major, unresolved for',
  incidents_oldest_minor_seconds: 'Oldest minor, unresolved for',
}

function labelFor(key: string): string {
  return VALUE_LABELS[key] ?? key.replace(/_/g, ' ')
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Formats a value *with* its unit, never without one.
 *
 * The `count` cases that are really durations are keyed by name because the contract has no `seconds` unit and
 * adding one would be a schema change for presentation. Rendering `5400` next to "History available" would be
 * a number in an unstated unit, which is the one thing every value here is required not to be.
 */
export function formatMetricValue(key: string, value: number, unit: string): string {
  if (unit === 'ratio') return `${(value * 100).toFixed(1)}%`
  if (unit === 'milliseconds') return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`
  if (unit === 'bytes') return formatBytes(value)
  if (unit === 'per_second') return `${value.toFixed(2)}/s`
  if (key.endsWith('_seconds')) return formatDuration(value)
  return value.toLocaleString()
}

/** Whether a value has crossed its own threshold, read in the direction the threshold states. */
function breachOf(value: number, threshold?: { direction: string; warn: number; critical: number }) {
  if (!threshold) return null
  const worse = threshold.direction === 'higher_is_worse'
  if (worse ? value >= threshold.critical : value <= threshold.critical) return 'critical' as const
  if (worse ? value >= threshold.warn : value <= threshold.warn) return 'warn' as const
  return null
}

/*
 * One column until 380 px, then two, then three.
 *
 * It was `grid-cols-2` from 320 px up, and a seven-digit number did not fit: at 320 px a two-column tile has a
 * 93 px content box and `1,234,567` in `text-2xl` needs 117 px, so the value was clipped — measured, not guessed.
 * Six digits fitted, seven did not, which means the page renders a *wrong number* the day any platform count
 * crosses a million. Request totals reach that in a week.
 *
 * Widening the tile rather than shrinking the type or truncating: a truncated number is a different number
 * ("1,234,5…" reads as a hundred-thousand figure), and scaling the font down to fit an unknown magnitude just moves
 * the same cliff further out. A single column at the narrowest width has room for any value the contract allows, and
 * costs one extra scroll on a phone.
 */
export function MetricValues({ payload }: { payload: Extract<AdminMetricSectionPayload, { data: unknown }> }) {
  return (
    <div className="grid grid-cols-1 min-[380px]:grid-cols-2 md:grid-cols-3 gap-3" data-testid="metric-values">
      {payload.data.values.map((value) => {
        const breach = breachOf(value.value, value.threshold)
        return (
          <div
            key={value.key}
            data-testid={`metric-value-${value.key}`}
            data-scope={value.scope}
            data-breach={breach ?? undefined}
            /*
              No `card` here, deliberately: the section is already one.
              
              A `card` inside a `card` paints a second border and shadow inside the first, and a grid of ten of
              them reads as boxes in a box. The tiles get a flat surface and their separation from the gap — and
              the *border* becomes signal rather than decoration: the only bordered tile is one whose value has
              crossed a threshold, which is the tile an operator should be drawn to.
            */
            className={`rounded-2xl p-3 bg-bh-surface-2 ${
              breach === 'critical'
                ? 'border border-bh-danger/50'
                : breach === 'warn'
                  ? 'border border-bh-warning/50'
                  : ''
            }`}
          >
            <p className="text-xs text-bh-text-dim mb-1">{labelFor(value.key)}</p>
            <p className={`text-2xl font-bold ${breach === 'critical' ? 'text-bh-danger' : breach === 'warn' ? 'text-bh-warning' : 'text-bh-text'}`}>
              {formatMetricValue(value.key, value.value, value.unit)}
            </p>
            {/*
              The scope, beside the number rather than in a legend.

              `process` means this instance since it booted: a deploy zeroed it, another instance would answer
              differently, and it is not the platform's figure. Next to a `database` platform total that
              distinction is the difference between a number that means something and one that means something
              else — which is why the schema refuses a process counter that omits its identity.
            */}
            {/*
              The comparison, as a signed delta beside the earlier figure.
              
              Both are printed, not just the delta: "+12%" alone leaves an operator computing the base, and
              a percentage change on a small base is the classic misleading metric — 1 error becoming 2 is
              "+100%". There is no arrow and no colour, because whether up is good depends on the metric and
              only the threshold knows that.
            */}
            {value.previous !== undefined && (
              <p className="text-xs text-bh-text-muted mt-1" data-testid={`metric-previous-${value.key}`}>
                {formatMetricValue(value.key, value.previous, value.unit)} previously
                {' · '}
                {value.value >= value.previous ? '+' : '−'}
                {formatMetricValue(value.key, Math.abs(value.value - value.previous), value.unit)}
              </p>
            )}
            <p className="text-xs text-bh-text-dim mt-1" data-testid={`metric-scope-${value.key}`}>
              {value.scope === 'process'
                ? `this process (pid ${value.processIdentity?.pid ?? '?'}) — not a platform total`
                : value.platformTotal
                  ? 'platform total, all instances'
                  : value.scope}
            </p>
          </div>
        )
      })}
    </div>
  )
}

const QUEUE_LABELS: Record<string, string> = {
  billing_events_dead_lettered: 'Billing events dead-lettered',
  billing_events_stuck: 'Billing events stuck in processing',
  removal_requests_overdue: 'Removal requests past their deadline',
  abuse_signals_urgent: 'Abuse signals at high or critical severity',
  workers_overdue: 'Scheduled jobs overdue',
  sources_enabled_without_connector: 'Sources enabled with no connector',
  sources_terms_unreviewed: 'Enabled sources with unreviewed terms',
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'border-bh-danger/50 text-bh-danger',
  high: 'border-bh-warning/50 text-bh-warning',
  medium: 'border-bh-border text-bh-text',
  low: 'border-bh-border text-bh-text-muted',
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h`
  return `${Math.floor(seconds / 86_400)} d`
}

/**
 * The Platform Action Queue — first in the section, above the numbers.
 *
 * ## Why it is above everything else, and why it disappears
 *
 * It is what an operator reads at 02:00, so it goes where their eye lands. And it is **absent** when nothing
 * needs attention rather than showing "all clear": a panel that is always present teaches the reader to skim
 * past it, and then it is furniture on the day it has a row. A queue that only exists when it has something to
 * say is a queue you look at.
 *
 * ## Severity is a word, not only a colour
 *
 * Each row prints its severity as text. Colour alone fails forced-colors mode, colour-blind readers, and a
 * printed screenshot pasted into an incident channel — which is a real path for this page.
 */
function ActionQueue({ payload }: { payload: Extract<AdminMetricSectionPayload, { data: unknown }> }) {
  const queue = payload.data.queue
  if (!queue || queue.length === 0) return null
  return (
    <ul className="mb-4 space-y-2" data-testid="admin-action-queue">
      {queue.map((row) => (
        <li key={row.key}>
          {/*
            The whole row is the link, and its destination came from the server through a regex that rejects
            anything but an in-app path. A server-supplied absolute URL here would be an open redirect on the
            page whose reader has the most authority.
          */}
          <Link
            to={row.href}
            className={`flex flex-wrap items-baseline gap-2 rounded-2xl border p-3 hover:underline ${SEVERITY_STYLES[row.severity] ?? SEVERITY_STYLES.low}`}
            data-testid={`admin-action-queue-row-${row.key}`}
            data-severity={row.severity}
          >
            <span className="text-xs uppercase tracking-wider">{row.severity}</span>
            <span className="font-semibold tabular-nums">{row.count.toLocaleString()}</span>
            <span className="text-sm">{QUEUE_LABELS[row.key] ?? row.key.replace(/_/g, ' ')}</span>
            {row.oldestAgeSeconds !== undefined && (
              <span className="text-xs text-bh-text-dim" data-testid={`admin-action-queue-age-${row.key}`}>
                oldest {formatAge(row.oldestAgeSeconds)}
              </span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  )
}

/** A bounded ranking of route families. Labels come from a closed set, so no identifier can appear. */
export function MetricRanked({ payload }: { payload: Extract<AdminMetricSectionPayload, { data: unknown }> }) {
  const ranked = payload.data.ranked
  if (!ranked || ranked.length === 0) return null
  const max = Math.max(...ranked.map((row) => row.value))
  return (
    <div className="mt-4" data-testid="metric-ranked">
      <p className="text-xs uppercase tracking-wider text-bh-text-dim mb-2">
        By route family (top {ranked.length})
      </p>
      <ul className="space-y-1 text-sm">
        {ranked.map((row) => (
          <li key={row.family} className="flex items-center gap-2" data-testid={`metric-ranked-${row.family}`}>
            <span className="w-40 shrink-0 text-bh-text-muted">{row.family}</span>
            <span className="h-2 rounded bg-bh-accent/40" style={{ width: `${Math.max(2, (row.value / max) * 60)}%` }} aria-hidden />
            <span className="font-mono tabular-nums text-xs">{formatMetricValue(row.family, row.value, row.unit)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Where to go when a threshold is breached.
 *
 * Rendered only on an actual breach, and that condition is the point. A metrics page that always offers "check
 * Operations" is offering navigation, not information — the link means something precisely because it appears
 * when a number has crossed a line somebody wrote down.
 *
 * It points at Operations and Incidents rather than at a worker endpoint. The difference matters: an operator
 * following a breach needs the screen that shows what the workers are doing and the screen where an incident is
 * recorded, not a POST that runs something.
 */
function BreachDrillDown({ payload }: { payload: Extract<AdminMetricSectionPayload, { data: unknown }> }) {
  const breached = payload.data.values.filter((value) => breachOf(value.value, value.threshold) !== null)
  if (breached.length === 0) return null
  return (
    <p className="text-xs text-bh-warning mt-4 flex flex-wrap items-center gap-2" data-testid="metric-section-breach">
      <AlertTriangle className="size-3" aria-hidden />
      {breached.length === 1
        ? `${labelFor(breached[0].key)} has crossed its threshold`
        : `${breached.length} values have crossed their thresholds`}
      {' — '}
      <Link to="/admin/operations" className="inline-flex items-center gap-1 text-bh-accent hover:underline" data-testid="metric-section-operations-link">
        check Operations <ExternalLink className="size-3" aria-hidden />
      </Link>
      <Link to="/admin/incidents" className="inline-flex items-center gap-1 text-bh-accent hover:underline" data-testid="metric-section-incidents-link">
        or record an incident <ExternalLink className="size-3" aria-hidden />
      </Link>
    </p>
  )
}

/**
 * The whole envelope: freshness line, stale/retry state, and either numbers or the reason there are none.
 *
 * Sections wrap their own extra widgets around this rather than reimplementing it, which is what keeps the
 * "no zeroes for a missing source" rule in one place.
 */
export function MetricSectionView({
  state,
  title,
  children,
}: {
  state: MetricSectionState
  title: string
  children?: React.ReactNode
}) {
  const { payload, lastSuccessAt, stale, error, loading, failures } = state

  if (!payload) {
    return (
      <section className="card p-5 mb-6" data-testid="metric-section">
        <h2 className="font-semibold mb-2">{title}</h2>
        {error ? (
          <p className="text-sm text-bh-danger" data-testid="metric-section-load-error">
            Could not load this section: {error}
            {failures > 1 && ` (${failures} consecutive failures)`}
          </p>
        ) : (
          <p className="text-sm text-bh-text-muted" data-testid="metric-section-loading">
            {loading ? 'Loading…' : 'No data'}
          </p>
        )}
      </section>
    )
  }

  if (payload.status === 'unavailable') {
    return (
      <section className="card p-5 mb-6" data-testid="metric-section" data-status="unavailable">
        <h2 className="font-semibold mb-2">{title}</h2>
        <p className="text-sm text-bh-text-muted" data-testid={`metric-section-unavailable-${payload.code}`}>
          {UNAVAILABLE_EXPLANATIONS[payload.code] ?? payload.code}
        </p>
        {children}
      </section>
    )
  }

  return (
    <section className="card p-5 mb-6" data-testid="metric-section" data-status={payload.status}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="font-semibold">{title}</h2>
        {/*
          The window and the time it was read, always. An aggregate without a period is not a measurement,
          and one without a timezone does not say which day "yesterday" was.
        */}
        <p className="text-xs text-bh-text-dim" data-testid="metric-section-window">
          {new Date(payload.window.from).toLocaleString()} – {new Date(payload.window.to).toLocaleString()}
          {' · '}
          {payload.window.timezone}
        </p>
      </div>

      {payload.status === 'partial' && (
        <p className="text-xs text-bh-warning mb-3 flex items-center gap-1" data-testid="metric-section-partial">
          <AlertTriangle className="size-3" aria-hidden />
          Some values in this section are missing rather than zero: {payload.code.replace(/_/g, ' ')}.
        </p>
      )}

      {/*
        Stale is not an error, and this is the distinction the whole state machine exists for.

        A failed refresh keeps the last good numbers on screen with the time they were true, because that is
        the information an operator is asking for. Replacing them with an error box answers "we do not know"
        when we knew, ninety seconds ago.
      */}
      {stale && (
        <p className="text-xs text-bh-warning mb-3 flex items-center gap-1" data-testid="metric-section-stale">
          <Clock className="size-3" aria-hidden />
          Showing the last successful read{lastSuccessAt ? ` from ${lastSuccessAt.toLocaleTimeString()}` : ''} —
          the most recent refresh failed{failures > 1 ? ` (${failures} in a row)` : ''}: {error}
        </p>
      )}

      <ActionQueue payload={payload} />
      <MetricValues payload={payload} />
      <MetricRanked payload={payload} />
      <BreachDrillDown payload={payload} />
      {children}

      <p className="text-xs text-bh-text-dim mt-4" data-testid="metric-section-generated-at">
        Read at {new Date(payload.generatedAt).toLocaleTimeString()}
        {lastSuccessAt && !stale && ` · fetched ${lastSuccessAt.toLocaleTimeString()}`}
      </p>
    </section>
  )
}
