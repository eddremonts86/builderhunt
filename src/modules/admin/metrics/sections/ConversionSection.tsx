// table-surface-semantic: six named funnel steps, each an aggregate over the requested window — one row per
// step from a fixed `METRIC_DEFINITIONS` list, so the row count is decided by code and not by how much data
// exists. The marker moved here with the table when the metrics page split into sections; it used to sit at the
// top of `AdminMetricsPage.tsx`, and `check-table-surfaces` caught the omission on the move.
import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, ExternalLink, Filter } from 'lucide-react'
import { SemanticTable, type SemanticColumn } from '~/shared/components/table'
import { MetricSectionView } from '../MetricSectionView'
import type { SectionWidgetProps } from '../MetricSectionView'

/**
 * Conversion (plan 57, Admin track — "Optimize and render Conversion metrics").
 *
 * Two sources, deliberately kept apart on screen.
 *
 * The **contract section** is `insufficient_history` and will stay so until something buckets billing events
 * by signup cohort: a conversion rate computed from "signups in the window" over "purchases in the window"
 * counts purchases by people who signed up months earlier, which is not a conversion rate of anything. That is
 * a cohort store, not a request counter, so `service_metric_buckets` does not answer it.
 *
 * The **landing funnel** below is real and already cohort-correct per step, because each step's denominator is
 * the previous step's event on the same session. It is rendered here rather than deleted or promoted: it
 * answers a narrower question honestly, and putting it under the same heading as the missing cohort metrics
 * would let a reader take one for the other.
 *
 * ## Why it is loaded lazily
 *
 * This file, `ReliabilitySection` and `OverviewSection` carry their own fetches and their own tables, and an
 * operator opens one section at a time. They are `React.lazy` imports in the shell so the chunk for the funnel
 * table is not downloaded by someone reading traffic latency.
 */

const METRIC_LABELS: Record<string, string> = {
  landing_to_signup: 'Landing → Signup',
  hero_signup_ctr: 'Hero → Signup click',
  hero_explore_ctr: 'Hero → Explore click',
  explore_search_completion: 'Explore → Search completed',
  explore_to_signup_ctr: 'Search → Signup click',
  signup_completion: 'Signup submit → complete',
}
const METRIC_ORDER = Object.keys(METRIC_LABELS)

interface ConversionRate {
  numerator: number
  denominator: number
  rate: number | null
  ci95: [number, number] | null
  insufficientSample: boolean
}

interface ConversionResponse {
  start: string
  end: string
  variant: 'baseline' | 'treatment'
  metrics: Record<string, ConversionRate & { numeratorEvent: string; denominatorEvent: string }>
}

function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`
}

function formatCi(ci: [number, number] | null): string | null {
  return ci ? `${(ci[0] * 100).toFixed(1)}–${(ci[1] * 100).toFixed(1)}%` : null
}

interface FunnelRow {
  key: string
  baseline: ConversionRate | undefined
  treatment: ConversionRate | undefined
}

/**
 * One variant's cell: the rate, then the counts it came from, then the interval — or the reason
 * there is no interval.
 *
 * All three, always. A rate on its own is unactionable: 33.3% over three sessions and 33.3% over
 * nine thousand are the same number and completely different facts, and it was showing only the
 * first version of this cell that made an operator escalate a "collapsing funnel" that was four
 * visits on a Sunday. `low n` is the honest substitute for an interval the sample cannot support —
 * never an invented one.
 */
function VariantCell({ sample }: { sample: ConversionRate | undefined }) {
  const interval = sample && !sample.insufficientSample ? formatCi(sample.ci95) : null
  return (
    <>
      <span className="font-semibold">{formatRate(sample?.rate ?? null)}</span>
      <span className="tbl-cell-meta ml-1 inline">({sample?.numerator ?? 0}/{sample?.denominator ?? 0})</span>
      {sample?.insufficientSample && (
        <span className="tbl-cell-meta ml-1 inline" title="Sample too small for a confidence interval">low n</span>
      )}
      {interval && <span className="tbl-cell-meta ml-1 inline">{interval}</span>}
    </>
  )
}

const FUNNEL_COLUMNS: SemanticColumn<FunnelRow>[] = [
  // The step name is the row's identity: without `scope="row"` a screen reader reads "12.0%" with
  // no idea which of six funnel steps it belongs to.
  { id: 'step', header: 'Step', rowHeader: true, cell: (row) => METRIC_LABELS[row.key] },
  { id: 'baseline', header: 'Baseline', cell: (row) => <VariantCell sample={row.baseline} /> },
  { id: 'treatment', header: 'Treatment', cell: (row) => <VariantCell sample={row.treatment} /> },
]

export function ConversionSection({ state }: SectionWidgetProps) {
  const [conversion, setConversion] = React.useState<{ baseline: ConversionResponse; treatment: ConversionResponse } | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const [baselineRes, treatmentRes] = await Promise.all([
          fetch('/api/admin/metrics/conversion?variant=baseline', { credentials: 'include', signal: controller.signal }),
          fetch('/api/admin/metrics/conversion?variant=treatment', { credentials: 'include', signal: controller.signal }),
        ])
        if (!baselineRes.ok || !treatmentRes.ok) {
          setError(`Failed to load: ${baselineRes.ok ? treatmentRes.status : baselineRes.status}`)
          return
        }
        const [baseline, treatment] = await Promise.all([baselineRes.json(), treatmentRes.json()])
        setConversion({ baseline, treatment })
        setError(null)
      } catch (caught) {
        if (controller.signal.aborted) return
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    })()
    return () => controller.abort()
  }, [])

  return (
    <>
      <MetricSectionView state={state} title="Conversion cohorts" />
      <ConversionFunnelSection conversion={conversion} error={error} />
    </>
  )
}

/**
 * Landing-funnel conversion rates for both experiment arms.
 *
 * Every rate the API returns is rendered as-is — a metric with too few sessions still shows its real rate,
 * flagged `insufficientSample` rather than dressed in a fabricated confidence interval. An entirely-empty
 * window gets its own message instead of a table of dashes.
 */
export function ConversionFunnelSection({
  conversion,
  error,
}: {
  conversion: { baseline: ConversionResponse; treatment: ConversionResponse } | null
  error: string | null
}) {
  if (error) {
    return (
      <section className="card p-5 mb-6 border-bh-danger/30" data-testid="metrics-conversion-error">
        <h2 className="font-semibold mb-2 flex items-center gap-2 text-bh-danger">
          <AlertTriangle className="w-4 h-4" aria-hidden="true" />
          Conversion funnel unavailable
        </h2>
        <p className="text-sm text-bh-text-muted mb-2">{error}</p>
        <p className="text-sm">
          <Link to="/admin/operations" className="inline-flex items-center gap-1 text-bh-accent hover:underline" data-testid="metrics-conversion-operations-link">
            Check Operations <ExternalLink className="size-3.5" aria-hidden />
          </Link>
        </p>
      </section>
    )
  }

  if (!conversion) {
    return (
      <section className="card p-5 mb-6" data-testid="metrics-conversion">
        <p className="text-sm text-bh-text-muted">Loading conversion funnel…</p>
      </section>
    )
  }

  const { baseline, treatment } = conversion
  const totalDenominator = METRIC_ORDER.reduce(
    (sum, key) => sum + (baseline.metrics[key]?.denominator ?? 0) + (treatment.metrics[key]?.denominator ?? 0),
    0,
  )

  if (totalDenominator === 0) {
    return (
      <section className="card p-5 mb-6" data-testid="metrics-conversion-empty">
        <h2 className="font-semibold mb-2 flex items-center gap-2">
          <Filter className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Conversion funnel
        </h2>
        <p className="text-sm text-bh-text-muted">No conversion events recorded in {baseline.start} – {baseline.end} yet.</p>
      </section>
    )
  }

  // A real anomaly (not just a small sample): a step with a healthy sample size but a zero rate, in either
  // arm — worth a nudge toward the content that step actually lives on.
  const hasAnomaly = METRIC_ORDER.some((key) => {
    const b = baseline.metrics[key]
    const t = treatment.metrics[key]
    return (b && !b.insufficientSample && b.rate === 0) || (t && !t.insufficientSample && t.rate === 0)
  })

  return (
    <section className="card p-5 mb-6" data-testid="metrics-conversion">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold flex items-center gap-2">
          <Filter className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Conversion funnel
        </h2>
        <p className="text-xs text-bh-text-dim">{baseline.start} – {baseline.end}</p>
      </div>
      {hasAnomaly && (
        <p className="text-xs text-bh-warning mb-3 flex items-center gap-1" data-testid="metrics-conversion-anomaly">
          <AlertTriangle className="size-3" aria-hidden />
          A step shows 0% on a real sample —{' '}
          <Link to="/admin/content" search={{ tab: 'blog' }} className="inline-flex items-center gap-0.5 text-bh-accent hover:underline" data-testid="metrics-conversion-content-link">
            review Content <ExternalLink className="size-3" aria-hidden />
          </Link>
        </p>
      )}
      <SemanticTable
        caption="Landing funnel conversion rate per step, baseline against treatment"
        columns={FUNNEL_COLUMNS}
        rows={METRIC_ORDER.map((key) => ({ key, baseline: baseline.metrics[key], treatment: treatment.metrics[key] }))}
        rowKey={(row) => row.key}
        rowTestId={(row) => `metrics-conversion-row-${row.key}`}
      />
    </section>
  )
}

export default ConversionSection
