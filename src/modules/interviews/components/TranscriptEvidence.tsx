import { useMemo } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '~/components/ui'

/**
 * A citation rendered as something you can open (plan:
 * calendar-scheduling-interview-intelligence, Phase 10).
 *
 * ## An unresolvable citation says so, loudly
 *
 * The server refuses to store a report citing a segment outside its evidence list, so this should never
 * happen. It renders anyway — as a visible warning rather than a silently missing chip — because the one
 * scenario that reaches it is a transcript segment deleted by retention while the report survives. A
 * citation that quietly vanished would leave a statement looking unsupported when it was not, and a reader
 * has no way to tell those apart.
 *
 * ## The timestamp is the label, not the id
 *
 * `01:24` tells a reader where in the conversation to look. `seg-9f2c…` tells them nothing, and putting a
 * uuid on screen invites someone to quote it in a decision document.
 */

export interface EvidenceSegment {
  id: string
  startsMs: number
  speakerLabel: string
  text: string
}

export interface TranscriptEvidenceProps {
  segmentIds: readonly string[]
  segments: readonly EvidenceSegment[]
  onOpen: (segment: EvidenceSegment) => void
  /** Rendered when a statement cites nothing at all — legitimate for an unanswered topic. */
  emptyLabel?: string
}

export function TranscriptEvidence(props: TranscriptEvidenceProps) {
  const byId = useMemo(() => new Map(props.segments.map((segment) => [segment.id, segment])), [props.segments])

  if (props.segmentIds.length === 0) {
    return props.emptyLabel
      ? <span className="text-xs text-muted-foreground">{props.emptyLabel}</span>
      : null
  }

  return (
    <span className="flex flex-wrap items-center gap-1">
      {props.segmentIds.map((id) => {
        const segment = byId.get(id)
        if (!segment) {
          return (
            <span
              key={id}
              // Named, not hidden. The only path here is a segment deleted by retention while the report
              // survived, and a citation that quietly vanished makes a supported statement look unsupported.
              className="flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-900 dark:text-amber-200"
              title="The transcript line behind this citation is no longer available."
            >
              <AlertTriangle className="size-3" aria-hidden />
              Source unavailable
            </span>
          )
        }
        return (
          <Button
            key={id}
            type="button"
            variant="ghost"
            className="h-6 px-1.5 font-mono text-xs"
            // The timestamp, and a label that says what opening it does. A uuid on screen invites someone to
            // quote it in a decision document.
            aria-label={`Open the transcript at ${formatOffset(segment.startsMs)}, ${segment.speakerLabel}`}
            onClick={() => props.onOpen(segment)}
          >
            {formatOffset(segment.startsMs)}
          </Button>
        )
      })}
    </span>
  )
}

/** The panel that opens when a citation is clicked. Text only — there is no audio to play. */
export function TranscriptExcerpt(props: { segment: EvidenceSegment | null; onClose: () => void }) {
  if (!props.segment) return null
  return (
    <aside
      role="dialog"
      aria-label="Transcript excerpt"
      className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {props.segment.speakerLabel} · {formatOffset(props.segment.startsMs)}
        </p>
        <Button type="button" variant="ghost" className="h-6 px-2 text-xs" onClick={props.onClose}>
          Close
        </Button>
      </div>
      <p className="text-sm leading-relaxed">{props.segment.text}</p>
      {/* Said explicitly. A reader looking for a play button should learn there is nothing to play, not
          conclude the feature is broken. */}
      <p className="text-xs text-muted-foreground">No audio was kept — only this text.</p>
    </aside>
  )
}

export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
