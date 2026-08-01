import { Link } from '@tanstack/react-router'
import { CalendarDays, FileText, Mic, Radio, Video } from 'lucide-react'
import { safeHttpHref } from '~/shared/lib/url-safety'

/**
 * Every interview this organizer owns, and what state each one is in (plan:
 * calendar-scheduling-interview-intelligence, Phase 10 follow-up).
 *
 * ## Why this exists
 *
 * It did not, and the consequence was concrete: `/interviews/$interviewId` was the only route, so the only
 * way to open an interview was to know a calendar event's uuid and type the URL. That is what someone
 * actually did, and the URL they built failed for an unrelated reason nobody could diagnose from the page.
 *
 * ## Each row answers "what can I do with this right now"
 *
 * Not a status column with seven values — three links whose presence *is* the state. A live interview has a
 * "Start" link, one with a transcript has a "Record" link, one with neither has only its brief. A row that
 * offers nothing is an interview nobody prepared, which is itself the useful signal.
 *
 * ## Sorted by start time, descending
 *
 * Today's interviews are the ones being opened, and yesterday's is the one being written up. A list ordered
 * by creation would bury both under whatever was scheduled furthest ahead.
 */

export interface InterviewListRowView {
  eventId: string
  roleTitle: string
  candidateDisplayName: string | null
  startsAt: string
  endsAt: string
  timezone: string
  modality: string
  meetingUrl: string | null
  location: string | null
  eventStatus: string
  sessionState: string | null
  hasBrief: boolean
  reportStatus: string | null
  transcriptSegments: number
}

/**
 * How early the live workspace is offered.
 *
 * An hour, not fifteen minutes: setting up a tab share, checking the microphone and reading the brief take
 * real time, and an organizer who arrives early to prepare should not be told to come back. Nothing on the
 * server enforces a schedule — `goLive` has no timing check — so this is purely about not cluttering a list
 * with links to interviews that are days away.
 */
export const JOIN_WINDOW_BEFORE_MS = 60 * 60_000

/** And how long after. Half an hour past the scheduled end, because interviews run over. */
export const JOIN_WINDOW_AFTER_MS = 30 * 60_000

export interface InterviewListProps {
  interviews: InterviewListRowView[]
  now?: () => number
}

export function InterviewList(props: InterviewListProps) {
  const now = (props.now ?? Date.now)()

  if (props.interviews.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border p-4">
        <h2 className="text-base font-semibold">No interviews yet</h2>
        <p className="text-sm text-muted-foreground">
          {/* Names the actual prerequisite. "No interviews" alone leaves someone wondering whether the
              feature is broken or whether they have not done the thing that creates one. */}
          An interview appears here once a candidate books one of your invitations. Send an invitation from
          the scheduling page to start.
        </p>
      </div>
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      {props.interviews.map((interview) => {
        const startsAt = new Date(interview.startsAt).getTime()
        const endsAt = new Date(interview.endsAt).getTime()
        const live = interview.sessionState === 'live' || interview.sessionState === 'paused'
        // A window rather than an instant: the affordance has to be there before the interview starts and
        // stay well past its scheduled end, because interviews start late and run over.
        const soon = now >= startsAt - JOIN_WINDOW_BEFORE_MS && now <= endsAt + JOIN_WINDOW_AFTER_MS

        return (
          <li key={interview.eventId} className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3">
            <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
              <div className="flex min-w-0 flex-col">
                <p className="truncate text-sm font-semibold">
                  {interview.candidateDisplayName ?? 'Candidate'} · {interview.roleTitle}
                </p>
                <p className="text-xs text-muted-foreground">
                  <CalendarDays className="mr-1 inline size-3" aria-hidden />
                  {formatWhen(interview.startsAt, interview.timezone)}
                  {' · '}
                  {interview.modality === 'in_person' ? 'In person' : 'Remote'}
                  {interview.location ? ` · ${interview.location}` : ''}
                </p>
              </div>
              <StateBadge interview={interview} live={live} />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* The brief first: it is what an organizer opens the day before. */}
              <Link
                to="/interviews/$interviewId"
                params={{ interviewId: interview.eventId }}
                className="text-xs underline underline-offset-2"
              >
                <FileText className="mr-1 inline size-3" aria-hidden />
                {interview.hasBrief ? 'Brief' : 'Prepare a brief'}
              </Link>

              {/* An interview IS its calendar event (same id) — plans/UI Wave 3 "Connect booked
                  scheduling to Calendar and Interviews". */}
              <Link
                to="/calendar"
                search={{ event: interview.eventId }}
                className="text-xs underline underline-offset-2"
              >
                <CalendarDays className="mr-1 inline size-3" aria-hidden />
                View in Calendar
              </Link>

              {(live || soon) && (
                <Link
                  to="/interviews/$interviewId/live"
                  params={{ interviewId: interview.eventId }}
                  className="text-xs underline underline-offset-2"
                >
                  <Mic className="mr-1 inline size-3" aria-hidden />
                  {live ? 'Rejoin' : 'Start'}
                </Link>
              )}

              {/* `safeHttpHref`, not the raw value: `z.string().url()` accepted `javascript:` until
                  `httpUrlSchema` landed, so a stored row can still carry one. */}
              {safeHttpHref(interview.meetingUrl) && (
                <a
                  href={safeHttpHref(interview.meetingUrl)!}
                  target="_blank"
                  // `noreferrer` as well as `noopener`: the referrer would tell the meeting provider which
                  // interview page a click came from.
                  rel="noopener noreferrer"
                  className="text-xs underline underline-offset-2"
                >
                  <Video className="mr-1 inline size-3" aria-hidden />
                  Join the call
                </a>
              )}

              {interview.transcriptSegments > 0 && (
                <span className="text-xs text-muted-foreground">
                  {interview.transcriptSegments} transcript lines
                </span>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * One badge, chosen by what matters most about this interview right now.
 *
 * Order is deliberate: live beats a finalized report, because someone is talking. A finished record beats a
 * draft. A cancelled event beats everything, because nothing else about it is actionable.
 */
function StateBadge(props: { interview: InterviewListRowView; live: boolean }) {
  const { interview, live } = props
  const [label, tone] = ((): [string, string] => {
    if (interview.eventStatus === 'cancelled') return ['Cancelled', 'border-border bg-muted text-muted-foreground']
    if (live) return ['Live now', 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200']
    if (interview.reportStatus === 'final') return ['Record final', 'border-border bg-muted text-muted-foreground']
    if (interview.reportStatus === 'draft') return ['Record in draft', 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200']
    if (interview.sessionState === 'processing' || interview.sessionState === 'review') {
      return ['Needs writing up', 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200']
    }
    if (interview.sessionState !== null) return ['Interview finished', 'border-border bg-muted text-muted-foreground']
    return ['Scheduled', 'border-border bg-muted text-muted-foreground']
  })()

  return (
    <span className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${tone}`}>
      {live ? <Radio className="size-3" aria-hidden /> : null}
      {label}
    </span>
  )
}

/** The interview's own timezone, not the reader's — an interview happens where it was booked. */
function formatWhen(iso: string, timezone: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium', timeStyle: 'short', timeZone: timezone,
    }).format(date)
  } catch {
    // An invalid stored timezone must not blank the row. The reader's own zone is a worse answer than the
    // right one and a much better answer than nothing.
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
  }
}
