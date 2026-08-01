/**
 * A whole run: three lanes, source freshness, and what the interpretation could not determine
 * (plan 43 Phase 8, "Render complete evidence-backed routes").
 *
 * ## Reorder is a view, not an edit
 *
 * Sorting by cost or time changes the order the cards appear in and nothing else. The stored run keeps its own
 * order (human, AI, hybrid) because a saved recommendation is a record; a user's current sort preference is not
 * part of it. That is why the sort lives in component state and never reaches the server.
 */
import * as React from 'react'
import { Clock, Layers } from 'lucide-react'
import type { SolutionRoute } from '~/shared/lib/solutions/contracts'
import { RouteCard, type ExplanationProvenance } from './RouteCard'

export interface RunResultProps {
  routes: SolutionRoute[]
  routeProvenance?: Array<{ routeType: string; provenance: ExplanationProvenance; fallbackReason: string | null }>
  evidenceLevels?: Record<string, string>
  sourceStatuses?: Array<{ sourceKey: string; status: 'ok' | 'degraded' | 'unavailable'; checkedAt: string; detail?: string }>
  warnings?: string[]
  /** What the interpretation was asked about and could not determine. Absent is different from unknown. */
  unknownFields?: string[]
  /**
   * Notices this surface is required to display, from the sources behind the cited components.
   *
   * Not decoration and not optional: `remoteok_jobs` and `jobicy_jobs` grant access on the condition that their
   * attribution appears wherever their data does. Rendered from the run's own payload, so a run that used those
   * feeds cannot be shown without them.
   */
  attributions?: Array<{ sourceKey: string; text: string; url: string }>
  chosenRouteType?: string | null
  onChoose?: (routeType: SolutionRoute['routeType']) => void
}

type SortMode = 'lane' | 'cost' | 'time'

const SORT_LABELS: Record<SortMode, string> = {
  lane: 'By lane',
  cost: 'Lowest cost first',
  time: 'Fastest first',
}

export function RunResult({
  routes,
  routeProvenance,
  evidenceLevels,
  sourceStatuses,
  warnings,
  unknownFields,
  attributions,
  chosenRouteType,
  onChoose,
}: RunResultProps) {
  const [sort, setSort] = React.useState<SortMode>('lane')
  const ordered = React.useMemo(() => sortRoutes(routes, sort), [routes, sort])
  const degraded = (sourceStatuses ?? []).filter((status) => status.status !== 'ok')

  return (
    <div className="space-y-4" data-testid="run-result">
      {/* Partial-source status first, before the routes it affects. A reader who scrolls past the cards and
          finds the caveat underneath has already formed a view. */}
      {degraded.length > 0 && (
        <div className="card p-4 border border-bh-warning/40 bg-bh-warning-soft rounded-xl text-sm" data-testid="source-status">
          <p className="font-medium mb-1">Some sources were not fully available</p>
          <ul className="list-disc pl-4 space-y-0.5">
            {degraded.map((status) => (
              <li key={status.sourceKey} data-testid={`source-status-${status.sourceKey}`}>
                <span className="font-medium">{status.sourceKey}</span>: {status.status}
                {status.detail ? ` — ${status.detail}` : ''}
                <span className="text-bh-text-dim"> (checked {new Date(status.checkedAt).toLocaleString()})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnings && warnings.length > 0 && (
        <div className="card p-4 border border-bh-border/60 bg-bh-bg-alt rounded-xl text-sm" data-testid="run-warnings">
          <ul className="list-disc pl-4 space-y-0.5">
            {warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </div>
      )}

      {unknownFields && unknownFields.length > 0 && (
        <p className="text-sm text-bh-text-muted" data-testid="unknown-fields">
          These were left unknown, so no route was checked against them:{' '}
          {unknownFields.map((field) => field.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ')}.
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Layers className="w-5 h-5 text-bh-accent" aria-hidden="true" />
          Three ways to do this
        </h2>
        <div className="flex items-center gap-2">
          <label htmlFor="route-sort" className="text-xs text-bh-text-dim">Order</label>
          <select
            id="route-sort"
            className="text-xs bg-bh-surface border border-bh-border/60 rounded-md px-2 py-1"
            value={sort}
            onChange={(event) => setSort(event.target.value as SortMode)}
            data-testid="route-sort"
          >
            {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
              <option key={mode} value={mode}>{SORT_LABELS[mode]}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3" data-testid="route-lanes">
        {ordered.map((route) => {
          const provenance = routeProvenance?.find((entry) => entry.routeType === route.routeType)
          return (
            <RouteCard
              key={route.routeType}
              route={route}
              {...(provenance ? { provenance: provenance.provenance, fallbackReason: provenance.fallbackReason } : {})}
              {...(evidenceLevels ? { evidenceLevels } : {})}
              chosen={chosenRouteType === route.routeType}
              {...(onChoose ? { onChoose } : {})}
            />
          )
        })}
      </div>

      <p className="text-xs text-bh-text-dim flex items-center gap-1">
        <Clock className="w-3 h-3" aria-hidden="true" />
        Estimates are ranges, not quotes. Every route needs a person to sign off before delivery.
      </p>

      {attributions && attributions.length > 0 && (
        <footer className="text-xs text-bh-text-dim border-t border-bh-border/40 pt-3" data-testid="source-attributions">
          {attributions.map((attribution) => (
            <p key={attribution.sourceKey} data-testid={`attribution-${attribution.sourceKey}`}>
              <a href={attribution.url} target="_blank" rel="noreferrer noopener nofollow" className="underline">
                {attribution.text}
              </a>
            </p>
          ))}
        </footer>
      )}
    </div>
  )
}

/**
 * Sorting that never hides an option.
 *
 * Unavailable routes always sort last regardless of mode — they have no estimate to compare, and putting an
 * unavailable lane first because its absent cost sorted as zero would be actively misleading.
 */
export function sortRoutes(routes: readonly SolutionRoute[], mode: SortMode): SolutionRoute[] {
  const laneOrder = ['human', 'ai', 'hybrid']
  const byLane = [...routes].sort((a, b) => laneOrder.indexOf(a.routeType) - laneOrder.indexOf(b.routeType))
  if (mode === 'lane') return byLane

  return byLane.sort((a, b) => {
    const aOffered = a.status !== 'unavailable' && Boolean(a.estimate)
    const bOffered = b.status !== 'unavailable' && Boolean(b.estimate)
    if (aOffered !== bOffered) return aOffered ? -1 : 1
    if (!aOffered) return laneOrder.indexOf(a.routeType) - laneOrder.indexOf(b.routeType)

    // Compared on the lower bound, which is the number a reader anchors on. Ties fall back to lane order so the
    // sort stays deterministic — two routes with the same floor must not swap places between renders.
    const aValue = mode === 'cost' ? a.estimate!.costMinCents : a.estimate!.timeMinHours
    const bValue = mode === 'cost' ? b.estimate!.costMinCents : b.estimate!.timeMinHours
    if (aValue !== bValue) return aValue - bValue
    return laneOrder.indexOf(a.routeType) - laneOrder.indexOf(b.routeType)
  })
}
