import { useCallback, useEffect, useRef, useState } from 'react'
import { Bookmark } from 'lucide-react'
import { Button, Textarea } from '~/components/ui'

/**
 * The organizer's private notes and their markers (plan:
 * calendar-scheduling-interview-intelligence, Phase 9).
 *
 * ## Private means not in the transcript
 *
 * These notes are the organizer's own working text. They are not part of the transcript, not sent to the
 * transcription provider, and not shown to a granted participant reading the interview afterwards — a note
 * saying "seemed nervous, probably not a fit" is an impression, not evidence, and mixing the two would make
 * the transcript's provenance meaningless.
 *
 * ## Markers store an offset, not a copy of what was said
 *
 * "Come back to this" at 12:04 is a pointer into the transcript. Copying the text into the marker would
 * duplicate a candidate's words into a second store with its own retention, for no benefit — the transcript
 * is right there.
 *
 * ## Autosave is debounced and reports its own state
 *
 * An organizer typing during an interview will not press save. A silent autosave that failed would lose
 * the notes without anyone noticing, so the state is on screen.
 */

export const NOTES_AUTOSAVE_DELAY_MS = 1_500

export interface InterviewMarker {
  id: string
  atMs: number
  label: string
}

export interface InterviewNotesProps {
  notes: string
  markers: InterviewMarker[]
  /** Milliseconds since the interview started, for a marker's offset. */
  elapsedMs: number
  onSaveNotes: (notes: string) => Promise<void>
  onAddMarker: (atMs: number) => void
  disabled?: boolean
}

type SaveState = 'idle' | 'saving' | 'saved' | 'failed'

export function InterviewNotes(props: InterviewNotesProps) {
  const [draft, setDraft] = useState(props.notes)
  const [state, setState] = useState<SaveState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(props.notes)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const scheduleSave = useCallback((value: string) => {
    latest.current = value
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setState('saving')
      props.onSaveNotes(latest.current)
        .then(() => setState('saved'))
        // Reported, not swallowed. An organizer whose notes silently failed to save discovers it after the
        // interview, when the notes are the only record of what they thought.
        .catch(() => setState('failed'))
    }, NOTES_AUTOSAVE_DELAY_MS)
  }, [props])

  return (
    <section aria-labelledby="notes-heading" className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="notes-heading" className="text-sm font-semibold uppercase tracking-wide">Your notes</h2>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'failed' ? 'Not saved' : ''}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        {/* Said plainly, because an organizer needs to know where the boundary is before they type. */}
        Only you can see these. They are not part of the transcript.
      </p>

      <Textarea
        aria-labelledby="notes-heading"
        value={draft}
        disabled={props.disabled}
        rows={8}
        onChange={(event) => {
          setDraft(event.target.value)
          setState('idle')
          scheduleSave(event.target.value)
        }}
        placeholder="What you want to remember about this conversation."
      />

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={props.disabled}
          onClick={() => props.onAddMarker(props.elapsedMs)}
        >
          <Bookmark className="mr-2 size-4" aria-hidden />
          Mark this moment
        </Button>
        <span className="text-xs text-muted-foreground">{formatOffset(props.elapsedMs)}</span>
      </div>

      {props.markers.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {[...props.markers].sort((a, b) => a.atMs - b.atMs).map((marker) => (
            <li key={marker.id} className="flex items-baseline gap-2">
              <span className="font-mono text-xs text-muted-foreground">{formatOffset(marker.atMs)}</span>
              {/* An offset and a label. Never a copy of the transcript text — that would put a
                  candidate's words in a second store with its own retention for no benefit. */}
              <span>{marker.label}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
