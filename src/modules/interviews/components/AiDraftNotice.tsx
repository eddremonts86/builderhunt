import { Info } from 'lucide-react'

/**
 * The label every AI output in this feature carries (plan:
 * calendar-scheduling-interview-intelligence, Phase 11 — EU AI Act operational controls).
 *
 * ## Why a shared component and not a sentence per page
 *
 * Article 50 transparency and the Article 6(3) preparatory-task position both depend on the reader knowing
 * they are looking at a draft a model wrote. A sentence copied into three components drifts: one gets
 * reworded, one gets moved below the fold, one gets dropped in a refactor. One component means the label
 * cannot be *partly* present, and `tests/unit/modules/interviews/components/ai-draft-notice.test.tsx`
 * asserts every surface renders it.
 *
 * ## It names the limitations, not just the provenance
 *
 * "AI draft" alone tells a reader who wrote it, not what to distrust. The failure modes here are specific and
 * knowable — misattributed speakers, mis-transcribed names and technical terms, claims that read as certain
 * — and naming them is what makes a human review something other than a rubber stamp.
 */

export interface AiDraftNoticeProps {
  /** Null when a deterministic template produced this, which is a different claim entirely. */
  provider: string | null
  model: string | null
  /** `brief` reads documents; `report` and `suggestion` read a transcript, so the caveats differ. */
  kind: 'brief' | 'report' | 'suggestion'
  editedByUserId?: string | null
}

const LIMITATIONS: Record<AiDraftNoticeProps['kind'], string> = {
  brief: 'It can misread a document, state a date or a title the source does not support, and miss things. Every claim cites its source — open them.',
  report: 'It can attribute a sentence to the wrong speaker, mis-transcribe a name or a technical term, and read as more certain than the transcript supports. Every statement cites a timestamp — follow them.',
  suggestion: 'It responds to the last few minutes only, and can misread who said what.',
}

export function AiDraftNotice(props: AiDraftNoticeProps) {
  // A template is not an AI draft, and calling it one would be the more misleading error: the reader would
  // trust sections nobody wrote.
  if (props.provider === null) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          <strong>Written without AI.</strong> This is an empty template — no model produced it. Read the
          evidence directly and fill it in yourself.
        </span>
      </p>
    )
  }

  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        {/* The exact phrase, because Article 50 is about the reader knowing. Not "AI-assisted", not
            "generated" — a draft is a thing a person is expected to correct. */}
        <strong>AI draft</strong> — written by {props.model ?? props.provider} for you to check and edit.
        {' '}It does not score, rank, or recommend a decision, and nothing here changes a candidate&apos;s
        status. {LIMITATIONS[props.kind]}
        {props.editedByUserId ? ' A person has since edited it.' : ''}
      </span>
    </p>
  )
}
