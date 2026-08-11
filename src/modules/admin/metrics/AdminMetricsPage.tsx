import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { Activity, RefreshCw } from 'lucide-react'
import { Button } from '~/components/ui/button'
import {
  ADMIN_METRIC_RANGES,
  ADMIN_METRIC_SECTIONS,
  variantsFor,
  type AdminMetricRange,
  type AdminMetricSection,
} from '~/shared/lib/admin-metrics/contracts'
import { DEFAULT_RANGE, DEFAULT_SECTION, type AdminMetricsUrlState } from '~/shared/lib/admin-metrics/url-state'
import { MetricSectionView } from './MetricSectionView'
import { useMetricSection } from './useMetricSection'

/**
 * The Admin Metrics page (plan 57, Admin track — "Rebuild `/admin/metrics` as a route-driven lazy widget
 * shell").
 *
 * ## What the rebuild changed
 *
 * It used to fetch four endpoints on mount and re-read the monolithic `/api/admin/metrics` every fifteen
 * seconds, rendering every section at once. So an operator looking at the conversion funnel was paying for a
 * platform-wide billing sweep, an interview capability read and a removal aggregate — on a timer — and the
 * expensive query nobody was looking at was indistinguishable from the one they were.
 *
 * Now exactly one section is fetched, chosen by the URL, and the others are not requested at all. The section
 * widget is a `React.lazy` import, so the funnel table is not in the chunk of somebody reading latency.
 *
 * ## Why it lives here and not in the route file
 *
 * TanStack Router cannot code-split a route file that exports anything besides its `Route`. This component was
 * once defined in `src/routes/_dashboard/admin/metrics.tsx` and exported so a unit test could import it, which
 * compiled ~780 lines of admin-only UI into the bundle **every visitor downloads**. Adding an export to that
 * route file, however small and however convenient for a test, undoes it.
 */

const SECTION_TITLES: Record<AdminMetricSection, string> = {
  overview: 'Overview',
  traffic: 'Request health',
  search: 'Search',
  discovery: 'Discovery',
  activation: 'Activation',
  conversion: 'Conversion',
  reliability: 'Reliability',
  operations: 'Workers & sources',
  trust: 'Trust & billing ops',
  content: 'Incident comms',
  runtime: 'Runtime',
}

/**
 * The sections whose widget is code-split.
 *
 * These five carry their own extra fetches and their own tables — a funnel, an interview counter grid, a
 * removal pipeline, two diagnostics disclosures. The other three are the shared contract renderer and nothing
 * else, so lazily loading them would add a round trip to save nothing.
 */
/**
 * The sections whose builder reads a second window when asked.
 *
 * Kept beside the shell rather than derived, because it is a UI claim about which controls do something — and
 * the wrong answer in either direction is a real defect: a missing toggle hides a working comparison, and an
 * extra one renders a control that silently changes nothing.
 */
const COMPARABLE_SECTIONS: ReadonlySet<AdminMetricSection> = new Set(['traffic', 'search'])

const LAZY_SECTIONS = {
  overview: React.lazy(() => import('./sections/OverviewSection')),
  conversion: React.lazy(() => import('./sections/ConversionSection')),
  reliability: React.lazy(() => import('./sections/ReliabilitySection')),
  discovery: React.lazy(() => import('./sections/DiscoverySection')),
  runtime: React.lazy(() => import('./sections/RuntimeSection')),
} as const

export function AdminMetricsPage(props: Partial<AdminMetricsUrlState> = {}) {
  const section = props.section ?? DEFAULT_SECTION
  const range = props.range ?? DEFAULT_RANGE
  const variant = props.variant ?? variantsFor(section)[0]
  const compare = props.compare ?? false

  return (
    <div data-testid="admin-metrics-page">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Activity className="w-6 h-6 text-bh-accent" aria-hidden="true" />
          Metrics
        </h1>
        <p className="text-sm text-bh-text-muted mt-1">
          One section at a time. Only the section you are looking at is fetched, and it refreshes every 30
          seconds while this tab is in view.
        </p>
      </header>

      {/*
        Selection is carried on `data-active`, not on an `aria-current` of our own.

        `Link` computes `aria-current` itself from the router's idea of the active route, and it wins — a value
        passed in props here was silently replaced, so a test asserting it was asserting on markup that never
        shipped. The router's answer is the correct one for assistive technology; `data-active` is what this
        component knows and what the tests read.
      */}
      <nav className="mb-4 flex flex-wrap gap-1" aria-label="Metric sections" data-testid="admin-metrics-sections">
        {ADMIN_METRIC_SECTIONS.map((candidate) => (
          <Link
            key={candidate}
            to="/admin/metrics"
            search={{ section: candidate, range, variant: variantsFor(candidate)[0], compare }}
            className={`text-sm px-3 py-1.5 rounded border ${
              candidate === section
                ? 'border-bh-accent text-bh-accent'
                : 'border-bh-border text-bh-text-muted hover:text-bh-text'
            }`}
            data-active={candidate === section ? 'true' : undefined}
            data-testid={`admin-metrics-section-${candidate}`}
          >
            {SECTION_TITLES[candidate]}
          </Link>
        ))}
      </nav>

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <div className="flex flex-wrap gap-1" data-testid="admin-metrics-ranges">
          <span className="text-xs text-bh-text-dim self-center mr-1">Window</span>
          {ADMIN_METRIC_RANGES.map((candidate) => (
            <Link
              key={candidate}
              to="/admin/metrics"
              search={{ section, range: candidate, variant, compare }}
              className={`text-xs px-2 py-1 rounded border ${
                candidate === range ? 'border-bh-accent text-bh-accent' : 'border-bh-border text-bh-text-muted'
              }`}
              data-active={candidate === range ? 'true' : undefined}
              data-testid={`admin-metrics-range-${candidate}`}
            >
              {candidate}
            </Link>
          ))}
        </div>

        {/*
          The variant picker is only rendered when the section has more than one, rather than always showing a
          single disabled control. A section with one shape has no view to choose between.
        */}
        {variantsFor(section).length > 1 && (
          <div className="flex flex-wrap gap-1" data-testid="admin-metrics-variants">
            <span className="text-xs text-bh-text-dim self-center mr-1">View</span>
            {variantsFor(section).map((candidate) => (
              <Link
                key={candidate}
                to="/admin/metrics"
                search={{ section, range, variant: candidate, compare }}
                className={`text-xs px-2 py-1 rounded border ${
                  candidate === variant ? 'border-bh-accent text-bh-accent' : 'border-bh-border text-bh-text-muted'
                }`}
                data-active={candidate === variant ? 'true' : undefined}
                data-testid={`admin-metrics-variant-${candidate}`}
              >
                {candidate}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/*
        The comparison toggle, offered only by the sections that can honour it.

        Traffic and search read a real time series, so "the window before this one" is a thing that exists. A
        process counter has no previous window and the two sections with no history have nothing to compare, so
        offering the toggle there would be a control that changes nothing — which is worse than its absence,
        because an operator would read the unchanged numbers as "no change".
      */}
      {COMPARABLE_SECTIONS.has(section) && (
        <div className="mb-4" data-testid="admin-metrics-compare">
          <Link
            to="/admin/metrics"
            search={{ section, range, variant, compare: !compare }}
            className={`text-xs px-2 py-1 rounded border ${
              compare ? 'border-bh-accent text-bh-accent' : 'border-bh-border text-bh-text-muted'
            }`}
            data-active={compare ? 'true' : undefined}
            data-testid="admin-metrics-compare-toggle"
          >
            Compare with previous {range}
          </Link>
        </div>
      )}

      {/*
        Keyed on the triple, which is how one section's numbers are prevented from appearing under another's
        heading.

        The alternative — clearing the fetch state in an effect when the triple changes — leaves a window where
        the previous payload is still mounted while the new request is in flight, and since the contract gives
        every section the same body shape, traffic's numbers would render perfectly under "Activation" for as
        long as the fetch took. A key makes React discard the state instead of asking the code to remember to.
      */}
      <MetricSectionHost
        key={`${section}:${range}:${variant}:${compare}`}
        section={section}
        range={range}
        variant={variant}
        compare={compare}
      />
    </div>
  )
}

/**
 * Owns one section's fetch, its refresh control and its announcement.
 *
 * Separate from the shell because it is the thing that gets remounted. The refresh button lives here rather
 * than in the page header for the same reason: it refreshes *this* section, and a control that outlived the
 * state it acts on would need a registration handshake to do the same job.
 */
function MetricSectionHost({
  section,
  range,
  variant,
  compare,
}: {
  section: AdminMetricSection
  range: AdminMetricRange
  variant: string
  compare: boolean
}) {
  const state = useMetricSection(section, range, variant, compare)

  /**
   * The refresh announcement, in a live region.
   *
   * A manual refresh on a page of numbers is invisible without one: nothing moves when the numbers are the
   * same, and a screen-reader user has no way to tell a successful refresh from a button that did nothing. The
   * message names the outcome rather than the action, and it is only produced for a refresh somebody asked for
   * — announcing every background poll would talk over whatever they were reading.
   */
  const [announcement, setAnnouncement] = React.useState('')
  const awaitingRefresh = React.useRef(false)

  React.useEffect(() => {
    if (!awaitingRefresh.current || state.loading) return
    awaitingRefresh.current = false
    setAnnouncement(
      state.error
        ? `${SECTION_TITLES[section]} could not be refreshed: ${state.error}`
        : `${SECTION_TITLES[section]} updated${state.lastSuccessAt ? ` at ${state.lastSuccessAt.toLocaleTimeString()}` : ''}`,
    )
  }, [state.loading, state.error, state.lastSuccessAt, section])

  const Widget = section in LAZY_SECTIONS ? LAZY_SECTIONS[section as keyof typeof LAZY_SECTIONS] : null

  return (
    <>
      <div className="mb-3 flex items-center justify-end">
        <Button
          type="button"
          onClick={() => {
            awaitingRefresh.current = true
            state.refresh()
          }}
          variant="ghost"
          size="sm"
          aria-label="Refresh"
          data-testid="admin-metrics-refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      <p aria-live="polite" role="status" className="sr-only" data-testid="admin-metrics-announcement">
        {announcement}
      </p>

      {/*
        `Suspense` around the section, not the page: a fallback that replaced the whole page would take the
        section navigation with it, so an operator who clicked the wrong tab would have nothing to click back
        with while the chunk loaded.
      */}
      <React.Suspense
        fallback={
          <section className="card p-5 mb-6" data-testid="admin-metrics-widget-loading">
            <p className="text-sm text-bh-text-muted">Loading {SECTION_TITLES[section]}…</p>
          </section>
        }
      >
        {Widget ? (
          <Widget state={state} variant={variant} />
        ) : (
          <MetricSectionView state={state} title={SECTION_TITLES[section]} />
        )}
      </React.Suspense>
    </>
  )
}
