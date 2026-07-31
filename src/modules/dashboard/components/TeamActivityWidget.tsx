// Plan 29 (activity-feed) task 5 — team activity widget.
//
// Compact display of the most recent N events for the dashboard.
// Renders day groups (the spec asks for them) and a
// "Show all" link out to the full team activity page. The widget
// is read-only and never issues a mutation; it does not own a
// cache key (the route is the owner of the cache).

import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { useBentoDensity } from '~/modules/dashboard/ui/bento/useBentoDensity'

export interface ActivityRowDTO {
  id: string
  type: string
  version: number
  actorUserId: string | null
  /** Resolved server-side, scoped to current org members. `null` means "no longer a member" when `actorUserId` is set, or "system" when it is not. */
  actorDisplayName: string | null
  targetKey: string
  metadata: Record<string, unknown>
  occurredAt: string
  display: string
  /** Server-authorized navigation target, or `null` if the row's target was deleted or the viewer cannot read it. Never derived from `targetKey` on the client. */
  targetHref: string | null
}

export interface TeamActivityWidgetProps {
  rows: ActivityRowDTO[]
  loading: boolean
  error: string | null
}

function dayKey(iso: string): string {
  return iso.slice(0, 10)
}

function formatDay(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
  if (dayKey(iso) === dayKey(today.toISOString())) return 'Today'
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return 'Yesterday'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * The API route resolves `actorDisplayName` from current organization
 * membership (see `resolveActorDisplayNames`) — this widget never looks up
 * a name itself. A null actor is a system action; a non-null actor with no
 * resolved name is someone who has since left the organization.
 */
function actorLabel(actorUserId: string | null, actorDisplayName: string | null): string {
  if (!actorUserId) return 'System'
  return actorDisplayName ?? 'Former member'
}

export function TeamActivityWidget({ rows, loading, error }: TeamActivityWidgetProps) {
  const [density] = useBentoDensity()
  // `density` is `'bento' | 'sections'` — both are full-size variants, the
  // difference is layout, not row count. Always show the same number of rows.
  const displayRows = rows.slice(0, density === 'bento' ? 6 : 6)

  const groups = React.useMemo(() => {
    const byDay = new Map<string, ActivityRowDTO[]>()
    for (const row of displayRows) {
      const key = dayKey(row.occurredAt)
      if (!byDay.has(key)) byDay.set(key, [])
      byDay.get(key)!.push(row)
    }
    return Array.from(byDay.entries())
  }, [displayRows])

  return (
    <div data-testid="team-activity-widget" className="space-y-3">
      {loading ? (
        <div className="animate-pulse space-y-2" aria-hidden="true">
          <div className="h-3 w-24 bg-bh-surface rounded" />
          <div className="h-12 bg-bh-surface/50 rounded" />
          <div className="h-12 bg-bh-surface/50 rounded" />
        </div>
      ) : error ? (
        <p className="text-sm text-bh-danger" role="alert">{error}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-bh-text-muted" data-testid="team-activity-empty">
          No activity yet. Saved searches, shared shortlists, and shared
          alerts will show up here as your team uses them.
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map(([day, items]) => (
            <div key={day} className="space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-bh-text-dim">
                {formatDay(items[0].occurredAt)}
              </p>
              <ul className="space-y-1.5">
                {items.map((row) => (
                  <li
                    key={row.id}
                    className="text-sm flex items-baseline gap-2"
                    data-testid="team-activity-row"
                  >
                    <span className="text-[10px] tabular-nums text-bh-text-dim shrink-0 w-12">
                      {formatTime(row.occurredAt)}
                    </span>
                    <span className="text-[10px] text-bh-text-dim shrink-0 w-16 truncate">
                      {actorLabel(row.actorUserId, row.actorDisplayName)}
                    </span>
                    {row.targetHref ? (
                      <a
                        href={row.targetHref}
                        className="text-bh-text truncate flex-1 hover:text-bh-accent hover:underline"
                        data-testid="team-activity-row-link"
                      >
                        {row.display}
                      </a>
                    ) : (
                      <span className="text-bh-text truncate flex-1">{row.display}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <Link
            to="/team/activity"
            className="text-xs text-bh-accent hover:underline inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 rounded px-0.5"
            data-testid="team-activity-show-all"
          >
            Show all
          </Link>
        </div>
      )}
    </div>
  )
}
