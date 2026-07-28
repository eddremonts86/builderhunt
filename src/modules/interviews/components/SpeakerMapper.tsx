import { useMemo } from 'react'
import { Button } from '~/components/ui'
import type { TranscriptSegmentView } from './LiveTranscript'

/**
 * Bulk speaker correction for in-person interviews (plan:
 * calendar-scheduling-interview-intelligence, Phase 9).
 *
 * ## Why this exists only for in-person
 *
 * Remote capture puts the organizer on channel 0 and the meeting on channel 1, so attribution is a fact the
 * mixer constructed. In-person has one microphone carrying two voices, so attribution is diarization — a
 * guess — and a guess in an interview transcript needs a human able to fix it.
 *
 * ## It maps a *diarized voice*, not one line
 *
 * Diarization is usually consistently wrong rather than randomly wrong: it reliably separates two speakers
 * and has no idea which is which. So the useful correction is "Speaker A is me" applied to every line at
 * once. Per-line correction still exists in `LiveTranscript` for the cases diarization actually confused.
 */

export interface SpeakerMapperProps {
  captureMode: 'in_person' | 'remote_call'
  segments: TranscriptSegmentView[]
  /** Applies a mapping to every segment currently carrying that estimate. */
  onMapAll: (estimate: 'speaker_a' | 'speaker_b', mapping: 'organizer' | 'candidate_or_remote') => void
  disabled?: boolean
}

export function SpeakerMapper(props: SpeakerMapperProps) {
  const counts = useMemo(() => {
    const tally = { speaker_a: 0, speaker_b: 0, unknown: 0 }
    for (const segment of props.segments) tally[segment.speakerEstimate] += 1
    return tally
  }, [props.segments])

  const mapped = useMemo(() => {
    const result: Partial<Record<'speaker_a' | 'speaker_b', 'organizer' | 'candidate_or_remote'>> = {}
    for (const segment of props.segments) {
      if (segment.speakerEstimate === 'unknown' || segment.speakerMapping === null) continue
      result[segment.speakerEstimate] = segment.speakerMapping
    }
    return result
  }, [props.segments])

  // Both early returns come after the hooks, which is not a style preference: a conditional hook changes
  // the call order between renders and React reads the wrong state.
  //
  // Nothing for remote, rather than a disabled control: offering a correction for an attribution that is
  // already deterministic would teach the organizer to distrust it.
  if (props.captureMode !== 'in_person') return null
  if (counts.speaker_a === 0 && counts.speaker_b === 0) return null

  return (
    <section aria-labelledby="speaker-heading" className="flex flex-col gap-2 rounded-md border border-border p-3">
      <h2 id="speaker-heading" className="text-sm font-semibold">Who is who?</h2>
      <p className="text-xs text-muted-foreground">
        {/* Honest about the limitation rather than hiding it: one microphone cannot tell two voices apart
            by itself, and pretending otherwise puts words in the wrong person's mouth. */}
        One microphone picked up both voices, so these are the transcriber's best guess. Set them once and
        every line updates.
      </p>

      {(['speaker_a', 'speaker_b'] as const).map((estimate) => (
        counts[estimate] > 0 && (
          <div key={estimate} className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              {estimate === 'speaker_a' ? 'Speaker A' : 'Speaker B'}
            </span>
            <span className="text-xs text-muted-foreground">{counts[estimate]} lines</span>
            {(['organizer', 'candidate_or_remote'] as const).map((mapping) => (
              <Button
                key={mapping}
                type="button"
                variant={mapped[estimate] === mapping ? 'primary' : 'secondary'}
                className="h-7 px-2 text-xs"
                aria-pressed={mapped[estimate] === mapping}
                disabled={props.disabled}
                onClick={() => props.onMapAll(estimate, mapping)}
              >
                {mapping === 'organizer' ? 'This is me' : 'This is the candidate'}
              </Button>
            ))}
          </div>
        )
      ))}

      {counts.unknown > 0 && (
        <p className="text-xs text-muted-foreground">
          {/* Surfaced rather than silently folded into one of the two speakers. */}
          {counts.unknown} line{counts.unknown === 1 ? '' : 's'} could not be attributed to either voice.
        </p>
      )}
    </section>
  )
}
