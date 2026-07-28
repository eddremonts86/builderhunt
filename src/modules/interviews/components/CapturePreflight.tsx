import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Info, Loader2, Mic, MonitorSpeaker } from 'lucide-react'
import { Button } from '~/components/ui'
import {
  CaptureError,
  detectCaptureSupport,
  requestCapture,
  type CaptureHandles,
  type CaptureSupport,
} from '~/modules/interviews/lib/audio-capture'

/**
 * The gate between "an interview is scheduled" and "audio is being captured" (plan:
 * calendar-scheduling-interview-intelligence, Phase 9).
 *
 * Three things have to be true before a single sample is taken, and they are deliberately three separate
 * statements rather than one "Start" button:
 *
 *   1. The candidate consented, recorded before today, shown here as a receipt.
 *   2. The organizer confirms out loud, now, that transcription is about to begin.
 *   3. The browser can actually do it.
 *
 * The verbal reminder is not ceremony. A consent given three days ago in a web form is a lawful basis; it
 * is not the same as a person being told, in the moment, that their words are about to be transcribed. The
 * checkbox is what records that the second thing happened, and it is unchecked by default because a
 * pre-ticked box records nothing.
 *
 * ## An unsupported browser is told before any prompt appears
 *
 * `detectCaptureSupport` asks no permission. So a Safari user reads "use Chrome" instead of granting a
 * microphone prompt and then discovering it was pointless — and a remote interview that cannot get the
 * meeting tab is offered **manual-only**, never microphone-only transcription.
 */

export interface ConsentReceipt {
  purpose: string
  noticeVersion: string
  decidedAt: string
  withdrawnAt: string | null
}

export interface CapturePreflightProps {
  captureMode: 'in_person' | 'remote_call'
  consent: ConsentReceipt | null
  /** Null while support has not been probed — the server-rendered pass. */
  support: CaptureSupport | null
  onReady: (handles: CaptureHandles) => void
  /** Chosen when capture is impossible or declined. The interview still happens; nothing is transcribed. */
  onManualOnly: (reason: string) => void
  navigatorLike?: Parameters<typeof detectCaptureSupport>[0]
}

export function CapturePreflight(props: CapturePreflightProps) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [error, setError] = useState<CaptureError | null>(null)

  const support = useMemo(
    () => props.support ?? (props.navigatorLike ? detectCaptureSupport(props.navigatorLike) : null),
    [props.support, props.navigatorLike],
  )

  const consentUsable = props.consent !== null && props.consent.withdrawnAt === null
  const capable = support === null
    ? false
    : props.captureMode === 'remote_call' ? support.remote : support.inPerson

  const start = useCallback(async () => {
    if (!support || !props.navigatorLike) return
    setRequesting(true)
    setError(null)
    try {
      const handles = await requestCapture({
        captureMode: props.captureMode,
        // True by construction: this runs from the button's click handler. Passing a literal would be a
        // lie the moment someone called `start()` from an effect.
        fromUserGesture: true,
        mediaDevices: props.navigatorLike.mediaDevices as never,
        navigatorLike: props.navigatorLike,
      })
      props.onReady(handles)
    } catch (thrown) {
      const failure = thrown instanceof CaptureError
        ? thrown
        : new CaptureError('capture failed', 'permission_denied')
      setError(failure)
    } finally {
      setRequesting(false)
    }
  }, [props, support])

  return (
    <section className="flex flex-col gap-4" aria-labelledby="preflight-heading">
      <h2 id="preflight-heading" className="text-lg font-semibold">Before you start</h2>

      {props.consent === null ? (
        <Callout tone="danger" icon={<AlertTriangle className="size-4" aria-hidden />}>
          <strong>No consent on file.</strong> This candidate has not agreed to live transcription, so it
          cannot be enabled. You can still take notes.
        </Callout>
      ) : props.consent.withdrawnAt !== null ? (
        <Callout tone="danger" icon={<AlertTriangle className="size-4" aria-hidden />}>
          <strong>Consent was withdrawn</strong> on {formatDate(props.consent.withdrawnAt)}. Transcription
          is not available for this interview.
        </Callout>
      ) : (
        <Callout tone="neutral" icon={<Check className="size-4" aria-hidden />}>
          {/* The receipt, not a reassurance. Naming the notice version and the date is what makes this
              checkable rather than a claim the product makes about itself. */}
          <strong>Consent recorded</strong> on {formatDate(props.consent.decidedAt)} against notice{' '}
          <code>{props.consent.noticeVersion}</code>.
        </Callout>
      )}

      {support !== null && !capable && (
        <Callout tone="warning" icon={<AlertTriangle className="size-4" aria-hidden />}>
          <strong>This browser cannot capture a remote call.</strong>{' '}
          {support.reason === 'unsupported_platform'
            ? 'Tab audio sharing needs desktop Chrome on macOS or Windows.'
            : `Use current or previous stable Chrome. This is ${support.identity.browserName} ${support.identity.browserMajor || 'of unknown version'}.`}
          {' '}
          {/* Never "we will transcribe your microphone only". Half a conversation presented as a whole
              transcript is worse than no transcript at all. */}
          You can continue with notes only — nothing will be transcribed.
        </Callout>
      )}

      {props.captureMode === 'remote_call' && capable && (
        <div className="rounded-md border border-border p-3 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <MonitorSpeaker className="size-4" aria-hidden />
            Share the meeting tab, with its audio
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>Open the Meet, Zoom or Teams call in a <strong>separate tab</strong>.</li>
            <li>Choose <strong>Chrome Tab</strong> in the picker — not a window and not your screen.</li>
            {/* The single most common way this setup fails. It is a checkbox people do not see. */}
            <li>Tick <strong>Also share tab audio</strong>. Without it there is nothing to transcribe.</li>
          </ol>
        </div>
      )}

      {props.captureMode === 'in_person' && capable && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Mic className="size-4" aria-hidden />
          One microphone will pick up both voices. You can correct who said what during the interview.
        </p>
      )}

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          disabled={!consentUsable || !capable}
          className="mt-0.5"
        />
        <span>
          I have told the candidate, out loud, that this interview is about to be transcribed.
        </span>
      </label>

      {error && (
        <Callout tone="danger" icon={<AlertTriangle className="size-4" aria-hidden />}>
          {messageFor(error)}
        </Callout>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={start}
          disabled={!acknowledged || !consentUsable || !capable || requesting}
        >
          {requesting ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
          {props.captureMode === 'remote_call' ? 'Share tab and start' : 'Start transcription'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => props.onManualOnly(capable ? 'organizer_declined' : (support?.reason ?? 'unsupported'))}
        >
          Continue without transcription
        </Button>
      </div>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        No audio is stored. Only the text is kept, and only until the retention period ends.
      </p>
    </section>
  )
}

/** The sentence an organizer can act on, per failure. A generic "capture failed" leaves them stuck. */
export function messageFor(error: CaptureError): string {
  switch (error.code) {
    case 'permission_denied':
      return 'Chrome refused the request. Check the microphone and screen-sharing permissions for this site, then try again.'
    case 'no_microphone':
      return 'No microphone was found. Connect one, or continue with notes only.'
    case 'not_a_browser_tab':
      return 'That was a window or screen share. Pick the meeting tab itself — a screen share would capture every other sound on your machine.'
    case 'self_tab':
      return 'That is this tab. Pick the tab with the meeting in it.'
    case 'no_tab_audio':
      return 'The tab was shared without its audio. Share it again and tick "Also share tab audio".'
    case 'requires_user_gesture':
      return 'Chrome only allows screen sharing from a click. Press the button again.'
    case 'mixer_unavailable':
      return 'This browser cannot process the captured audio. Continue with notes only.'
    case 'unsupported_browser':
      return 'Use current or previous stable Chrome on macOS or Windows.'
    case 'unsupported_platform':
      return 'Tab audio sharing needs a desktop browser.'
  }
}

function Callout(props: { tone: 'neutral' | 'warning' | 'danger'; icon: ReactNode; children: ReactNode }) {
  const tone = {
    neutral: 'border-border bg-muted/40 text-foreground',
    warning: 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200',
    danger: 'border-destructive/40 bg-destructive/10 text-destructive',
  }[props.tone]
  return (
    <div className={`flex items-start gap-2 rounded-md border p-3 text-sm ${tone}`}>
      <span className="mt-0.5 shrink-0">{props.icon}</span>
      <div>{props.children}</div>
    </div>
  )
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString()
}
