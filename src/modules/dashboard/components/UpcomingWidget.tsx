import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { FileText, Video } from 'lucide-react'
import type { DashboardUpcomingItem } from '~/shared/lib/dashboard/contracts'

/**
 * Today and upcoming — a semantic agenda, not a chart (plans/ui-dashboard Wave 3).
 *
 * Body only; `WidgetFrame` owns the header and every non-ready state.
 *
 * ## An ordered list, because the order is chronology
 *
 * `<ol>`, so a screen reader announces position and count, and focus order follows time without the
 * component doing anything to arrange it. The spec asks for the agenda over a chart and this is why:
 * a week strip encodes "when" as horizontal position, which a keyboard user traverses in DOM order
 * and a screen-reader user cannot traverse at all.
 *
 * ## Times carry their zone
 *
 * Every row shows the time in the **event's** zone with the zone named, not in the viewer's. A
 * recruiter in Copenhagen scheduling for a candidate in São Paulo needs to see the time the
 * candidate agreed to; silently re-rendering it in the reader's locale is how someone joins an hour
 * late and never learns why. The `<time>` element carries the machine-readable instant regardless.
 *
 * ## One primary action, chosen by state
 *
 * Join when there is a meeting link, Prepare when an interview has no active brief, View otherwise.
 * Never two. The "no brief" case is the one the action queue also raises, deliberately: the queue
 * says *deal with this*, the agenda says *this is when it is* — the same fact answering two
 * different questions, which is the point of having both.
 */

function formatWhen(item: DashboardUpcomingItem): string {
  const starts = new Date(item.startsAt)
  if (Number.isNaN(starts.getTime())) return 'Unknown time'
  if (item.allDay) {
    return starts.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: item.timezone })
  }
  try {
    return starts.toLocaleString(undefined, {
      weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: item.timezone,
    })
  } catch {
    // A zone the runtime does not know. Better an honest UTC rendering than a thrown component.
    return starts.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
  }
}

export function UpcomingWidget({ items }: { items: readonly DashboardUpcomingItem[] }) {
  return (
    <ol className="-mx-6 -mb-6 divide-y divide-bh-border border-t border-bh-border">
      {items.map((item) => {
        const needsBrief = item.type === 'interview' && !item.hasActiveBrief
        return (
          <li key={item.eventId} className="flex items-start gap-3 px-6 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <time dateTime={item.startsAt} className="shrink-0 text-xs font-medium tabular-nums text-bh-text">
                  {formatWhen(item)}
                </time>
                {/* The zone, always. Its absence is what makes a wrong-hour join look like the
                    reader's mistake rather than a missing piece of information. */}
                <span className="shrink-0 text-[11px] text-bh-text-dim">{item.timezone}</span>
              </div>
              <p className="mt-0.5 truncate text-sm text-bh-text">{item.title}</p>
              {needsBrief && (
                <p className="mt-0.5 flex items-center gap-1 text-xs text-bh-warning">
                  <FileText className="h-3 w-3" aria-hidden="true" />
                  No brief yet
                </p>
              )}
              {item.location && !item.meetingUrl && (
                <p className="mt-0.5 truncate text-xs font-light text-bh-text-muted">{item.location}</p>
              )}
            </div>

            {item.meetingUrl ? (
              /*
               * A real anchor, not a router `Link`: this leaves the app. `rel="noreferrer"` because
               * the referrer would carry the dashboard URL to a third-party conferencing host, and
               * `noopener` because `window.opener` on a user-supplied URL is a tab-nabbing handle.
               * The URL itself was already validated as absolute http(s) at the contract boundary.
               */
              <a
                href={item.meetingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-bh-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
              >
                <Video className="h-3 w-3" aria-hidden="true" />
                <span className="sr-only">Join {item.title} (opens in a new tab)</span>
                <span aria-hidden="true">Join</span>
              </a>
            ) : (
              <Link
                to="/calendar"
                className="shrink-0 rounded px-2 py-1 text-xs text-bh-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
              >
                {/* Every row's link would otherwise announce the same word. */}
                <span className="sr-only">{needsBrief ? 'Prepare' : 'View'} {item.title}</span>
                <span aria-hidden="true">{needsBrief ? 'Prepare' : 'View'}</span>
              </Link>
            )}
          </li>
        )
      })}
    </ol>
  )
}
