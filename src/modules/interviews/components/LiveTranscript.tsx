import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '~/components/ui'

/**
 * The transcript as it arrives (plan: calendar-scheduling-interview-intelligence, Phase 9).
 *
 * ## Announcements are throttled, because an unthrottled live region is unusable
 *
 * A screen reader reading every final segment the instant it lands would talk continuously for
 * forty-five minutes and drown out the candidate — the person the organizer is supposed to be listening to.
 * So the live region announces a *summary* at most once every `ANNOUNCE_INTERVAL_MS`, and the transcript
 * itself is `aria-live="off"`. The full text stays navigable; it is the interruption that is rationed.
 *
 * ## Interim text is rendered and never stored
 *
 * It exists on screen so the organizer can see that capture is working, and it is replaced in place. It is
 * not in the outbox, not in the database, and not in this component's history — a separate `interim` prop
 * rather than an entry in `segments`, so there is no state in which an interim line could be persisted by
 * accident.
 *
 * ## Speaker labels are deterministic for remote and admittedly a guess for in-person
 *
 * Remote labels come from the channel the mixer assigned, so they are facts and read as names. In-person
 * labels come from diarization, so they read as "Speaker A" with a correction control — presenting a guess
 * as a name would let a reader attribute a sentence to the wrong person with no way to tell.
 */

/** At most one announcement every eight seconds. Enough to know it is working, rare enough to talk over. */
export const ANNOUNCE_INTERVAL_MS = 8_000

export interface TranscriptSegmentView {
  id: string
  providerSegmentId: string
  sequence: number
  speakerEstimate: 'speaker_a' | 'speaker_b' | 'unknown'
  speakerMapping: 'organizer' | 'candidate_or_remote' | null
  text: string
  startsMs: number
  endsMs: number
  confidence: number | null
}

export interface LiveTranscriptProps {
  captureMode: 'in_person' | 'remote_call'
  segments: TranscriptSegmentView[]
  /** The current partial line. Rendered, never stored. */
  interim: string | null
  /** In-person only: the organizer relabels a diarized voice. */
  onCorrectSpeaker?: (segmentId: string, mapping: 'organizer' | 'candidate_or_remote') => void
  /** True while capture is stopped — the transcript stays readable and says why it is not growing. */
  paused?: boolean
  manualOnlyReason?: string | null
  now?: () => number
}

export function LiveTranscript(props: LiveTranscriptProps) {
  const [announcement, setAnnouncement] = useState('')
  const lastAnnouncedAt = useRef(0)
  const lastCount = useRef(0)
  const clock = props.now ?? Date.now

  useEffect(() => {
    if (props.segments.length === lastCount.current) return
    const at = clock()
    if (at - lastAnnouncedAt.current < ANNOUNCE_INTERVAL_MS) return
    lastAnnouncedAt.current = at
    const added = props.segments.length - lastCount.current
    lastCount.current = props.segments.length
    // A count, not the text. Reading the transcript aloud as it arrives would make the organizer unable to
    // hear the person they are interviewing.
    setAnnouncement(`${added} new transcript ${added === 1 ? 'line' : 'lines'}, ${props.segments.length} total.`)
  }, [props.segments.length, clock])

  const ordered = useMemo(
    () => [...props.segments].sort((a, b) => a.sequence - b.sequence),
    [props.segments],
  )

  if (props.manualOnlyReason) {
    return (
      <section aria-labelledby="transcript-heading" className="flex flex-col gap-2">
        <h2 id="transcript-heading" className="text-sm font-semibold uppercase tracking-wide">Transcript</h2>
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          {/* Named plainly. An empty transcript panel with no explanation reads as a broken feature. */}
          Not transcribing this interview. Your notes are still saved.
        </p>
      </section>
    )
  }

  return (
    <section aria-labelledby="transcript-heading" className="flex min-h-0 flex-col gap-2">
      <h2 id="transcript-heading" className="text-sm font-semibold uppercase tracking-wide">Transcript</h2>

      {/* The throttled channel. Separate from the transcript so the two cannot fight. */}
      <p aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</p>

      <ol
        // `off`, deliberately. The summary above is the announcement; this is the record.
        aria-live="off"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1"
      >
        {ordered.length === 0 && props.interim === null && (
          <li className="text-sm text-muted-foreground">Listening…</li>
        )}
        {ordered.map((segment) => (
          <li key={segment.id} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {speakerLabel(segment, props.captureMode)}
              </span>
              <span className="text-xs text-muted-foreground">{formatOffset(segment.startsMs)}</span>
              {props.captureMode === 'in_person' && props.onCorrectSpeaker && (
                <span className="flex gap-1">
                  {(['organizer', 'candidate_or_remote'] as const).map((mapping) => (
                    <Button
                      key={mapping}
                      type="button"
                      variant="ghost"
                      // Small target on a dense list, but a real one: 24px minimum with padding.
                      className="h-6 px-1.5 text-xs"
                      aria-label={`Mark this line as ${mapping === 'organizer' ? 'you' : 'the candidate'}`}
                      aria-pressed={segment.speakerMapping === mapping}
                      onClick={() => props.onCorrectSpeaker?.(segment.id, mapping)}
                    >
                      {mapping === 'organizer' ? 'You' : 'Candidate'}
                    </Button>
                  ))}
                </span>
              )}
            </div>
            <p className="text-sm leading-relaxed">{segment.text}</p>
          </li>
        ))}
        {props.interim !== null && props.interim.length > 0 && (
          <li className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Speaking…
            </span>
            {/* Italic and muted, so it reads as provisional rather than as part of the record. */}
            <p className="text-sm italic leading-relaxed text-muted-foreground">{props.interim}</p>
          </li>
        )}
      </ol>

      {props.paused && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-200">
          Capture is paused. Nothing is being transcribed.
        </p>
      )}
    </section>
  )
}

/**
 * What to call a voice.
 *
 * A confirmed mapping wins over an estimate; a remote estimate is a fact from the channel; an in-person
 * estimate is a guess and says so. The three cases are separate because collapsing them would present a
 * diarization guess as a name.
 */
export function speakerLabel(
  segment: Pick<TranscriptSegmentView, 'speakerEstimate' | 'speakerMapping'>,
  captureMode: 'in_person' | 'remote_call',
): string {
  if (segment.speakerMapping === 'organizer') return 'You'
  if (segment.speakerMapping === 'candidate_or_remote') return 'Candidate'
  if (captureMode === 'remote_call') {
    // Deterministic: channel 0 is the microphone because the mixer put it there.
    if (segment.speakerEstimate === 'speaker_a') return 'You'
    if (segment.speakerEstimate === 'speaker_b') return 'Candidate'
    return 'Unattributed'
  }
  // Diarization. Named as a guess, because it is one.
  if (segment.speakerEstimate === 'speaker_a') return 'Speaker A'
  if (segment.speakerEstimate === 'speaker_b') return 'Speaker B'
  return 'Unattributed'
}

function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
