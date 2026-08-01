/**
 * Verified-owner profile-view analytics (plans/UI/tasks.md Wave 4 "Record profile views and show
 * owner aggregates"). Reads `GET /api/builders/:builderId/views`, which is already the
 * verified-owner-only, counts-only projection — viewer identity, organization, query, and referrer
 * never leave the server and never reach this component.
 */
import * as React from 'react'
import { Eye } from 'lucide-react'

interface ProfileViewAnalyticsProps {
  builderId: string
}

interface DailyCount {
  day: string
  count: number
}

type PanelState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; total: number; daily: DailyCount[]; windowDays: number }

// Below this many total views, a daily bar chart is noise dressed up as a trend — same rationale
// as StyleMatchPanel's DENSITY_THRESHOLD for style-match fingerprints.
const MIN_COHORT_FOR_CHART = 5

export function ProfileViewAnalytics({ builderId }: ProfileViewAnalyticsProps) {
  const [state, setState] = React.useState<PanelState>({ kind: 'loading' })

  React.useEffect(() => {
    let cancelled = false
    fetch(`/api/builders/${builderId}/views`, { credentials: 'include' })
      .then(async (res) => {
        if (cancelled) return
        if (!res.ok) {
          setState({ kind: 'error', message: 'Could not load view analytics.' })
          return
        }
        const body = await res.json() as { total: number; daily: DailyCount[]; windowDays: number }
        setState({ kind: 'ready', total: body.total, daily: body.daily, windowDays: body.windowDays })
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error', message: 'Network error loading view analytics.' })
      })
    return () => { cancelled = true }
  }, [builderId])

  if (state.kind === 'loading') {
    return <div className="card p-5 animate-pulse h-20" data-testid="profile-view-analytics-loading" />
  }

  if (state.kind === 'error') {
    return (
      <div className="card p-5" data-testid="profile-view-analytics" data-state="error">
        <p className="text-sm text-bh-text-dim" role="alert">{state.message}</p>
      </div>
    )
  }

  const { total, daily, windowDays } = state

  if (total === 0) {
    return (
      <div className="card p-5" data-testid="profile-view-analytics" data-state="empty">
        <h3 className="text-base font-semibold text-bh-text flex items-center gap-2 mb-1">
          <Eye className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Profile views
        </h3>
        <p className="text-sm text-bh-text-dim">
          No views yet in the last {windowDays} days. Views only count once your profile is shared
          or discovered.
        </p>
      </div>
    )
  }

  const showChart = total >= MIN_COHORT_FOR_CHART
  const maxCount = Math.max(1, ...daily.map((d) => d.count))

  return (
    <div className="card p-5" data-testid="profile-view-analytics" data-state="ready">
      <h3 className="text-base font-semibold text-bh-text flex items-center gap-2 mb-1">
        <Eye className="w-4 h-4 text-bh-accent" aria-hidden="true" />
        Profile views
      </h3>
      <p className="text-2xl font-bold text-bh-text" data-testid="profile-view-total">
        {total}
      </p>
      <p className="text-xs text-bh-text-dim mb-3">in the last {windowDays} days</p>

      {showChart ? (
        <div className="flex items-end gap-0.5 h-16" data-testid="profile-view-chart">
          {daily.slice().reverse().map((d) => (
            <div
              key={d.day}
              className="flex-1 bg-bh-accent/60 rounded-t"
              style={{ height: `${Math.max(8, (d.count / maxCount) * 100)}%` }}
              title={`${new Date(d.day).toLocaleDateString()}: ${d.count} view${d.count === 1 ? '' : 's'}`}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-bh-text-dim" data-testid="profile-view-minimum-cohort">
          Not enough views yet to show a daily trend — check back once you have at least{' '}
          {MIN_COHORT_FOR_CHART} views.
        </p>
      )}
    </div>
  )
}
