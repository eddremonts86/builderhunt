import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Loader2, Lock, Sparkles } from 'lucide-react'
import { Button, Textarea } from '~/components/ui'
import { TranscriptEvidence, TranscriptExcerpt, type EvidenceSegment } from './TranscriptEvidence'

/**
 * The interview report: read, edit, finalize (plan:
 * calendar-scheduling-interview-intelligence, Phase 10).
 *
 * ## There is no score, no rating and no recommendation control anywhere in this component
 *
 * Not hidden, not disabled — absent. The schema has no field for one and the server rejects the vocabulary,
 * so a UI offering the control would be a promise the API refuses. A test asserts the absence, because a
 * well-meaning "overall impression" slider is exactly the kind of thing that gets added later.
 *
 * ## A template says so on its face
 *
 * `provider: null` is the marker. A blank report presented as generated output is the most misleading thing
 * this page could show: the organizer would trust sections nobody wrote.
 *
 * ## Finalizing is a separate, confirmed, irreversible action
 *
 * A two-step confirmation, not a modal over the whole page — the organizer is often finalizing from notes
 * they are still reading. After it, every editable control disappears rather than failing on submit.
 */

export interface ReportStatement {
  statement: string
  segmentIds: string[]
}

export interface ReportTopicAnswer {
  topicId: string
  answer: string
  segmentIds: string[]
  status: 'answered' | 'partial' | 'unanswered'
}

export interface ReportContent {
  summary: ReportStatement[]
  answersByTopic: ReportTopicAnswer[]
  openQuestions: string[]
  followUps: Array<{ action: string; owner?: string; segmentIds: string[] }>
}

export interface ReportView {
  version: number
  status: 'draft' | 'final'
  content: ReportContent
  evidenceSegmentIds: string[]
  provider: string | null
  model: string | null
  editedByUserId: string | null
  finalizedAt: string | null
}

export interface InterviewReportEditorProps {
  report: ReportView | null
  latestVersion: number | null
  segments: readonly EvidenceSegment[]
  canEdit: boolean
  /** Topic id → the question it was, so a report reads as answers rather than as `topic:2`. */
  topicQuestions: Readonly<Record<string, string>>
  onGenerate: (organizerNotes: string | null) => Promise<void>
  onSave: (content: ReportContent, expectedVersion: number) => Promise<void>
  onFinalize: (expectedVersion: number) => Promise<void>
}

/** spec.md "Usage credits and pricing": a final report is five credits. */
const REPORT_CREDITS = 5

export function InterviewReportEditor(props: InterviewReportEditorProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<ReportContent | null>(null)
  const [excerpt, setExcerpt] = useState<EvidenceSegment | null>(null)
  const [confirmingFinal, setConfirmingFinal] = useState(false)

  const content = draft ?? props.report?.content ?? null
  const dirty = draft !== null
  const isFinal = props.report?.status === 'final'
  const editable = props.canEdit && !isFinal

  const staleVersion = useMemo(
    () => props.report !== null && props.latestVersion !== null && props.latestVersion > props.report.version,
    [props.latestVersion, props.report],
  )

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (thrown) {
      setError(messageFor(thrown))
    } finally {
      setBusy(false)
    }
  }, [])

  if (!props.report || !content) {
    return (
      <section aria-labelledby="report-heading" className="flex flex-col gap-3">
        <h2 id="report-heading" className="text-lg font-semibold">Interview record</h2>
        <p className="text-sm text-muted-foreground">
          No record yet. Generating one reads the transcript and writes up what was said and what is still
          open. It does not score or recommend anything.
        </p>
        {error && <Callout tone="danger">{error}</Callout>}
        {props.canEdit && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => void run(() => props.onGenerate(null))}
          >
            {busy
              ? <Loader2 className="mr-2 size-4 animate-spin motion-reduce:animate-none" aria-hidden />
              : <Sparkles className="mr-2 size-4" aria-hidden />}
            {/* The price on the button. Five credits should not be a surprise. */}
            Generate record ({REPORT_CREDITS} credits)
          </Button>
        )}
      </section>
    )
  }

  return (
    <section aria-labelledby="report-heading" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="report-heading" className="text-lg font-semibold">Interview record</h2>
        <p className="text-xs text-muted-foreground">
          Version {props.report.version}
          {isFinal ? ' · final' : ' · draft'}
          {props.report.provider
            ? ` · ${props.report.provider}`
            // The template's only marker. Presenting it as generated output would have the organizer trust
            // sections nobody wrote.
            : ' · written without AI — fill this in yourself'}
          {props.report.editedByUserId ? ' · edited by hand' : ''}
        </p>
      </div>

      {isFinal && (
        <Callout tone="neutral">
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>This record is final and cannot be changed.</span>
        </Callout>
      )}

      {staleVersion && (
        <Callout tone="warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            A newer version ({props.latestVersion}) exists. You are looking at version{' '}
            {props.report.version}{dirty ? ', and your changes here are still unsaved' : ''}.
          </span>
        </Callout>
      )}

      {error && <Callout tone="danger">{error}</Callout>}

      <Section title="What was discussed">
        {content.summary.map((entry, index) => (
          <div key={index} className="flex flex-col gap-1">
            <EditableText
              value={entry.statement}
              editable={editable}
              label={`Summary statement ${index + 1}`}
              onChange={(value) => setDraft(replaceSummary(content, index, value))}
            />
            <TranscriptEvidence
              segmentIds={entry.segmentIds}
              segments={props.segments}
              onOpen={setExcerpt}
            />
          </div>
        ))}
      </Section>

      <Section title="By topic">
        {content.answersByTopic.map((entry, index) => (
          <div key={entry.topicId} className="flex flex-col gap-1">
            <p className="text-sm font-medium">
              {/* The question, not `topic:2`. A record that reads as answers is a record someone can use. */}
              {props.topicQuestions[entry.topicId] ?? entry.topicId}
            </p>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{entry.status}</p>
            <EditableText
              value={entry.answer}
              editable={editable}
              label={`Answer for ${props.topicQuestions[entry.topicId] ?? entry.topicId}`}
              onChange={(value) => setDraft(replaceAnswer(content, index, value))}
            />
            <TranscriptEvidence
              segmentIds={entry.segmentIds}
              segments={props.segments}
              onOpen={setExcerpt}
              // A topic nobody reached legitimately cites nothing. Saying so beats an empty row.
              emptyLabel={entry.status === 'unanswered' ? 'Not discussed — no transcript to cite.' : undefined}
            />
          </div>
        ))}
      </Section>

      {content.openQuestions.length > 0 && (
        <Section title="Still open">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {content.openQuestions.map((question, index) => <li key={index}>{question}</li>)}
          </ul>
        </Section>
      )}

      {content.followUps.length > 0 && (
        <Section title="Follow-ups">
          {content.followUps.map((entry, index) => (
            <div key={index} className="flex flex-col gap-1">
              <p className="text-sm">{entry.action}{entry.owner ? ` — ${entry.owner}` : ''}</p>
              <TranscriptEvidence segmentIds={entry.segmentIds} segments={props.segments} onOpen={setExcerpt} />
            </div>
          ))}
        </Section>
      )}

      <TranscriptExcerpt segment={excerpt} onClose={() => setExcerpt(null)} />

      {editable && (
        <div className="flex flex-wrap gap-2">
          {dirty && (
            <Button
              type="button"
              disabled={busy}
              onClick={() => void run(async () => {
                await props.onSave(content, props.report!.version)
                setDraft(null)
              })}
            >
              {busy ? <Loader2 className="mr-2 size-4 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              Save changes
            </Button>
          )}
          {confirmingFinal ? (
            <>
              <Button
                type="button"
                variant="danger"
                disabled={busy || dirty}
                onClick={() => void run(() => props.onFinalize(props.report!.version))}
              >
                {/* Named as irreversible on the button itself, not only in a sentence above it. */}
                Yes, finalize permanently
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirmingFinal(false)}>Cancel</Button>
            </>
          ) : (
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirmingFinal(true)}>
              <Check className="mr-2 size-4" aria-hidden />
              Finalize record
            </Button>
          )}
          {confirmingFinal && dirty && (
            // Refusing rather than silently discarding: finalizing a version that does not include what the
            // organizer just typed would freeze the wrong record.
            <p className="w-full text-xs text-amber-700 dark:text-amber-300">
              Save your changes first — finalizing would lock the previous version.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{props.title}</h3>
      {props.children}
    </div>
  )
}

function EditableText(props: {
  value: string
  editable: boolean
  label: string
  onChange: (value: string) => void
}) {
  if (!props.editable) return <p className="text-sm leading-relaxed">{props.value}</p>
  return (
    <Textarea
      aria-label={props.label}
      value={props.value}
      rows={Math.min(6, Math.max(2, Math.ceil(props.value.length / 90)))}
      onChange={(event) => props.onChange(event.target.value)}
    />
  )
}

function replaceSummary(content: ReportContent, index: number, statement: string): ReportContent {
  return {
    ...content,
    summary: content.summary.map((entry, at) => (at === index ? { ...entry, statement } : entry)),
  }
}

function replaceAnswer(content: ReportContent, index: number, answer: string): ReportContent {
  return {
    ...content,
    answersByTopic: content.answersByTopic.map((entry, at) => (at === index ? { ...entry, answer } : entry)),
  }
}

function Callout(props: { tone: 'neutral' | 'warning' | 'danger'; children: ReactNode }) {
  const tone = {
    neutral: 'border-border bg-muted/40 text-foreground',
    warning: 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200',
    danger: 'border-destructive/40 bg-destructive/10 text-destructive',
  }[props.tone]
  return <div className={`flex items-start gap-2 rounded-md border p-3 text-sm ${tone}`}>{props.children}</div>
}

/**
 * The sentence for a failure.
 *
 * The code only. `dangling_reference` gets its own line because it is the one an organizer can fix, and
 * "invalid input" would leave them hunting through a report for something the server already knows.
 */
export function messageFor(thrown: unknown): string {
  switch ((thrown as { code?: unknown } | null)?.code) {
    case 'insufficient_credits':
      return `Not enough credits. A record costs ${REPORT_CREDITS}.`
    case 'not_entitled':
      return 'Interview records are not part of your plan.'
    case 'no_transcript':
      return 'There is no transcript to write this up from.'
    case 'version_conflict':
      return 'Someone else changed this record. Reload to see their version.'
    case 'dangling_reference':
      return 'One of the citations points at a transcript line that is not part of this record. Remove it and save again.'
    case 'already_final':
      return 'This record is already final.'
    case 'invalid_content':
      return 'That change was refused. A record cannot score, rank, or recommend a decision.'
    default:
      return 'Something went wrong. Nothing was saved.'
  }
}
