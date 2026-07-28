import { AlertTriangle, Loader2, Pause, Play, Square, Wifi, WifiOff } from 'lucide-react'
import { Button } from '~/components/ui'
import type { DeepgramConnectionState } from '~/modules/interviews/lib/deepgram-client'

/**
 * The interview's controls, timer and honest status line (plan:
 * calendar-scheduling-interview-intelligence, Phase 9).
 *
 * ## The connection indicator tells the truth, including when it is bad
 *
 * A "recording" dot that stays green through a five-minute reconnect storm is worse than no indicator: the
 * organizer finishes the interview believing they have a transcript. Reconnecting, failed and manual-only
 * are each their own visible state.
 *
 * ## Running out of credits does not end the interview
 *
 * spec.md stops only *paid provider capture* at zero. The organizer is mid-conversation with a real person,
 * and cutting that off because a balance ran out would be a worse product than one that keeps taking notes.
 * So a spent balance shows a warning and a manual-only transition — never a modal that blocks the page.
 *
 * ## A withdrawal is not a warning
 *
 * It is a stop, and it says so, and the finish button becomes the only forward action. The ten-second
 * deadline is the server's; this component's job is to make ignoring it impossible to do by accident.
 */

export interface InterviewControlsProps {
  state: 'not_started' | 'consent_pending' | 'ready' | 'live' | 'paused' | 'processing' | 'review' | 'finalized' | 'failed' | 'abandoned'
  connection: DeepgramConnectionState | 'manual_only'
  elapsedMs: number
  /** Credits left on the reservation, and null when nothing was reserved (manual-only). */
  remainingCredits: number | null
  /** Set when the candidate has withdrawn. The hard stop is already in force. */
  withdrawn: boolean
  busy?: boolean
  onPause: () => void
  onResume: () => void
  onFinish: () => void
  onReconnect: () => void
}

export function InterviewControls(props: InterviewControlsProps) {
  const live = props.state === 'live'
  const terminal = ['processing', 'review', 'finalized', 'failed', 'abandoned'].includes(props.state)
  const lowCredits = props.remainingCredits !== null && props.remainingCredits <= 10

  return (
    <section aria-labelledby="controls-heading" className="flex flex-col gap-3">
      <h2 id="controls-heading" className="sr-only">Interview controls</h2>

      {props.withdrawn && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <strong>The candidate has withdrawn consent.</strong> Transcription has stopped. Finish the
            interview to save what was already captured.
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <p className="font-mono text-2xl tabular-nums" aria-label={`Elapsed time ${spokenDuration(props.elapsedMs)}`}>
          {formatClock(props.elapsedMs)}
        </p>
        <ConnectionBadge connection={props.connection} />
        {props.remainingCredits !== null && (
          <span className={`text-sm ${lowCredits ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`}>
            {props.remainingCredits} credit{props.remainingCredits === 1 ? '' : 's'} left
          </span>
        )}
      </div>

      {lowCredits && !props.withdrawn && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-900 dark:text-amber-200">
          {/* Not a modal. The organizer is talking to someone. */}
          About {props.remainingCredits} minutes of transcription left. When it runs out the interview
          continues and your notes keep saving — only transcription stops.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {live && !props.withdrawn && (
          <Button type="button" variant="secondary" onClick={props.onPause} disabled={props.busy}>
            <Pause className="mr-2 size-4" aria-hidden />
            Pause
          </Button>
        )}
        {props.state === 'paused' && (
          <Button type="button" variant="secondary" onClick={props.onResume} disabled={props.busy}>
            <Play className="mr-2 size-4" aria-hidden />
            Resume
          </Button>
        )}
        {props.connection === 'failed' && !props.withdrawn && (
          <Button type="button" variant="secondary" onClick={props.onReconnect} disabled={props.busy}>
            <Wifi className="mr-2 size-4" aria-hidden />
            Reconnect
          </Button>
        )}
        {!terminal && (
          <Button type="button" variant="danger" onClick={props.onFinish} disabled={props.busy}>
            {props.busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
              : <Square className="mr-2 size-4" aria-hidden />}
            Finish interview
          </Button>
        )}
      </div>
    </section>
  )
}

function ConnectionBadge(props: { connection: InterviewControlsProps['connection'] }) {
  const { label, tone, spinning } = describe(props.connection)
  return (
    <span
      // `polite`, so a reconnect is announced without interrupting whoever is speaking.
      aria-live="polite"
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${tone}`}
    >
      {spinning
        // `motion-reduce:animate-none`: a spinner that keeps moving for a user who asked for less motion is
        // the exact thing the preference exists to stop.
        ? <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
        : props.connection === 'open'
          ? <Wifi className="size-3" aria-hidden />
          : <WifiOff className="size-3" aria-hidden />}
      {label}
    </span>
  )
}

/** The words for each connection state. Exported so a test reads these rather than a copy of them. */
export function describe(connection: InterviewControlsProps['connection']): {
  label: string
  tone: string
  spinning: boolean
} {
  switch (connection) {
    case 'open':
      return { label: 'Transcribing', tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200', spinning: false }
    case 'connecting':
      return { label: 'Connecting', tone: 'border-border bg-muted text-muted-foreground', spinning: true }
    case 'reconnecting':
      // Named, not hidden behind a green dot. An organizer who thinks they have a transcript and does not
      // is the failure this indicator exists to prevent.
      return { label: 'Reconnecting', tone: 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200', spinning: true }
    case 'failed':
      return { label: 'Not transcribing', tone: 'border-destructive/40 bg-destructive/10 text-destructive', spinning: false }
    case 'manual_only':
      return { label: 'Notes only', tone: 'border-border bg-muted text-muted-foreground', spinning: false }
    case 'closed':
    case 'idle':
      return { label: 'Stopped', tone: 'border-border bg-muted text-muted-foreground', spinning: false }
  }
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000))
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

/** "12 minutes, 4 seconds" — a screen reader reading "12:04" says "twelve oh four", which is a time of day. */
function spokenDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes} minute${minutes === 1 ? '' : 's'}, ${seconds} second${seconds === 1 ? '' : 's'}`
}
