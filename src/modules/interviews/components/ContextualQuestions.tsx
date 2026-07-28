import { useCallback, useState } from 'react'
import { Check, Loader2, Sparkles, X } from 'lucide-react'
import { Button } from '~/components/ui'
import { TranscriptEvidence, type EvidenceSegment } from './TranscriptEvidence'

/**
 * Contextual follow-up questions during a live interview (plan:
 * calendar-scheduling-interview-intelligence, Phase 10).
 *
 * ## At most three, and the panel never says an error happened
 *
 * When the model cannot answer — throttled, provider down, credits gone, switch off — the server returns
 * the prepared questions with a `reason`. This panel shows them and labels the source honestly ("from your
 * brief" versus "from what was just said") without a failure banner. The organizer is mid-conversation on
 * a screen the candidate may be able to see, and "AI provider unavailable" helps nobody.
 *
 * ## A question shows its rationale and its evidence, or it is just a prompt
 *
 * The whole value over a static list is that a suggestion responds to something that was said. So each one
 * carries why it was suggested and a timestamp into the transcript — and a suggestion from the brief
 * carries neither, which is exactly how a reader tells them apart.
 *
 * ## Nothing is kept unless the organizer says so
 *
 * Use, save and dismiss are all explicit. There is no implicit "seen" state and no analytics on what was
 * ignored: the proposals are ephemeral by design, and a record of every question an interviewer rejected
 * about a named candidate is not something to accumulate quietly.
 */

export interface ContextualSuggestion {
  id: string
  topicId: string
  question: string
  rationale: string
  segmentIds: string[]
}

export interface ContextualQuestionsProps {
  suggestions: ContextualSuggestion[]
  /** `suggested` came from the transcript; `prepared` came from the brief. */
  source: 'suggested' | 'prepared' | null
  reason: string | null
  segments: readonly EvidenceSegment[]
  busy?: boolean
  /** Absent while the session is not live — the panel then reads rather than offers. */
  onAsk?: () => void
  onAction?: (suggestion: ContextualSuggestion, action: 'used' | 'saved' | 'dismissed') => void
  onOpenSegment?: (segment: EvidenceSegment) => void
}

export function ContextualQuestions(props: ContextualQuestionsProps) {
  const [handled, setHandled] = useState<Record<string, 'used' | 'saved' | 'dismissed'>>({})

  const act = useCallback((suggestion: ContextualSuggestion, action: 'used' | 'saved' | 'dismissed') => {
    // Optimistic. The organizer is asking a question *now*; a round trip before the chip changes reads as
    // the button not working.
    setHandled((current) => ({ ...current, [suggestion.id]: action }))
    props.onAction?.(suggestion, action)
  }, [props])

  const visible = props.suggestions.filter((suggestion) => handled[suggestion.id] !== 'dismissed').slice(0, 3)

  return (
    <section aria-labelledby="questions-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="questions-heading" className="text-sm font-semibold uppercase tracking-wide">
          Questions to ask
        </h2>
        {props.onAsk && (
          <Button type="button" variant="secondary" className="h-7 px-2 text-xs" disabled={props.busy} onClick={props.onAsk}>
            {props.busy
              ? <Loader2 className="mr-1.5 size-3 animate-spin motion-reduce:animate-none" aria-hidden />
              : <Sparkles className="mr-1.5 size-3" aria-hidden />}
            Suggest from what was said
          </Button>
        )}
      </div>

      {props.source !== null && (
        <p className="text-xs text-muted-foreground">
          {/* Labelled, never disguised. A prepared question presented as a live suggestion would make the
              organizer think the transcript is being read when it is not. */}
          {props.source === 'suggested'
            ? 'Based on what was just said.'
            : 'From your prepared brief — nothing new to follow up on yet.'}
        </p>
      )}

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No questions to show.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {visible.map((suggestion) => (
            <li key={suggestion.id} className="flex flex-col gap-1.5 rounded-md border border-border p-3">
              <p className="text-sm font-medium">{suggestion.question}</p>
              <p className="text-xs text-muted-foreground">{suggestion.rationale}</p>
              <TranscriptEvidence
                segmentIds={suggestion.segmentIds}
                segments={props.segments}
                onOpen={(segment) => props.onOpenSegment?.(segment)}
              />
              {props.onAction && (
                <div className="flex flex-wrap gap-1.5">
                  {handled[suggestion.id] ? (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Check className="size-3" aria-hidden />
                      {handled[suggestion.id] === 'used' ? 'Asked' : 'Saved'}
                    </span>
                  ) : (
                    <>
                      <Button type="button" className="h-7 px-2 text-xs" onClick={() => act(suggestion, 'used')}>
                        I asked this
                      </Button>
                      <Button type="button" variant="secondary" className="h-7 px-2 text-xs" onClick={() => act(suggestion, 'saved')}>
                        Save for later
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        aria-label={`Dismiss: ${suggestion.question}`}
                        onClick={() => act(suggestion, 'dismissed')}
                      >
                        <X className="size-3" aria-hidden />
                      </Button>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {/* Deliberately absent: any rendering of `reason`. It is passed in so a *test* can assert the panel
          stays quiet about it, and so a future settings page could surface it — never the live workspace. */}
      {props.reason === 'not_entitled' && (
        <p className="text-xs text-muted-foreground">
          Live suggestions are not part of your plan. These come from your brief.
        </p>
      )}
    </section>
  )
}
