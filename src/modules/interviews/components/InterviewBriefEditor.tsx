import { useCallback, useMemo, useState } from 'react'
import { AlertTriangle, Check, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { Button, Textarea } from '~/components/ui'
import { AiDraftNotice } from './AiDraftNotice'
import { EvidenceDrawer, type EvidenceSource } from './EvidenceDrawer'

/**
 * Reads and edits an interview brief (plan:
 * calendar-scheduling-interview-intelligence, Phase 8).
 *
 * ## Provenance is on screen, not in a tooltip
 *
 * A reader deciding how much weight to give a brief needs to know whether a model wrote it, which one, and
 * whether a human has since corrected it. A brief with no provider is the deterministic fallback and says
 * so plainly — presenting it as though a model produced it would be the single most misleading thing this
 * component could do.
 *
 * ## Citations are buttons, because a citation you cannot open is one you must take on trust
 *
 * Every `sourceId` renders as a control that opens that source in the drawer. The brief's schema forces
 * each claim to cite something; that only pays off if the reader can actually check it.
 *
 * ## A version conflict offers the new version rather than discarding work
 *
 * Two tabs, or a colleague regenerating while you edit. The editor keeps what you typed on screen and says
 * a newer version exists — silently overwriting either side would lose someone's work without telling them.
 */

export interface BriefEvidenceClaim {
  claim: string
  sourceIds: string[]
  confidence: 'low' | 'medium' | 'high'
}

export interface BriefQuestionGroup {
  category: 'general' | 'technical' | 'critical'
  question: string
  rationale: string
  sourceIds: string[]
}

export interface BriefContent {
  candidateSummary: string
  relevantEvidence: BriefEvidenceClaim[]
  informationGaps: string[]
  contradictions: { description: string; sourceIds: string[] }[]
  questionGroups: BriefQuestionGroup[]
}

export interface BriefView {
  version: number
  status: 'draft' | 'active' | 'superseded'
  content: BriefContent
  evidenceManifest: EvidenceSource[]
  provider: string | null
  model: string | null
  editedByUserId: string | null
}

export interface InterviewBriefEditorProps {
  interviewId: string
  brief: BriefView | null
  latestVersion: number | null
  /** Refetches after a generate, edit or accept. */
  onChanged: () => void
  /** Owner-only actions. A participant reads; they do not regenerate someone else's brief. */
  canEdit: boolean
}

const CONFIDENCE_LABEL: Record<BriefEvidenceClaim['confidence'], string> = {
  low: 'low confidence',
  medium: 'medium confidence',
  high: 'high confidence',
}

const ERROR_COPY: Readonly<Record<string, string>> = {
  insufficient_credits: 'You do not have enough AI interview credits. Top up in billing settings to generate this brief.',
  insufficient_entitlement: 'Generating a brief needs a Pro, Pro Max or Team plan.',
  state_changed: 'Someone else generated a newer version. Reload to see it.',
  no_candidate_submission: 'The candidate has not submitted their details yet.',
  no_evidence: 'There is nothing readable to build a brief from yet.',
  dangling_source: 'A citation points at a source that is not in this brief’s evidence.',
  invalid_content: 'That brief could not be saved — a field is missing or malformed.',
  version_conflict: 'This brief changed while you were editing. Reload to see the newer version.',
  interviews_disabled: 'Interview briefs are not enabled on this deployment.',
}

export function InterviewBriefEditor({
  interviewId,
  brief,
  latestVersion,
  onChanged,
  canEdit,
}: InterviewBriefEditorProps) {
  const [busy, setBusy] = useState<'generate' | 'save' | 'accept' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openSourceId, setOpenSourceId] = useState<string | null>(null)
  const [summaryDraft, setSummaryDraft] = useState<string | null>(null)

  const summary = summaryDraft ?? brief?.content.candidateSummary ?? ''
  const isFallback = brief !== null && brief.provider === null
  const hasNewerVersion = brief !== null && latestVersion !== null && latestVersion > brief.version

  const sourceLabels = useMemo(
    () => new Map((brief?.evidenceManifest ?? []).map((source) => [source.id, source.label])),
    [brief],
  )

  const call = useCallback(async (
    kind: 'generate' | 'save' | 'accept',
    path: string,
    init: RequestInit,
  ) => {
    setBusy(kind)
    setError(null)
    try {
      const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        const code = typeof body?.error === 'string' ? body.error : typeof body?.reason === 'string' ? body.reason : ''
        setError(ERROR_COPY[code] ?? 'That did not work. Please try again.')
        return false
      }
      onChanged()
      return true
    } catch {
      setError('Something went wrong. Please try again.')
      return false
    } finally {
      setBusy(null)
    }
  }, [onChanged])

  const generate = () => call('generate', `/api/interviews/${interviewId}/brief`, {
    method: 'POST',
    // The version the client is looking at, so a concurrent generation is refused rather than adding a
    // third version nobody asked for. `0` means "there should be none yet".
    body: JSON.stringify({ expectedVersion: latestVersion ?? 0, creditConfirmation: true }),
  })

  const save = () => {
    if (!brief) return
    void call('save', `/api/interviews/${interviewId}/brief/${brief.version}`, {
      method: 'PATCH',
      // Content only. The manifest is the record of what was actually supplied and read, and the route
      // re-supplies it from the stored row — an editable manifest would let a citation be pointed at
      // something that was never in evidence.
      body: JSON.stringify({ content: { ...brief.content, candidateSummary: summary } }),
    }).then((ok) => { if (ok) setSummaryDraft(null) })
  }

  const accept = () => {
    if (!brief) return
    void call('accept', `/api/interviews/${interviewId}/brief/${brief.version}`, { method: 'POST' })
  }

  const citation = (sourceIds: readonly string[]) => (
    <span className="ml-1 inline-flex flex-wrap gap-1">
      {sourceIds.map((id) => (
        <button
          key={id}
          type="button"
          className="text-muted-foreground rounded border px-1 text-[10px] underline"
          onClick={() => setOpenSourceId(id)}
          // The label, not the raw id: `doc:9f2c…` tells a reader nothing about what they are opening.
          aria-label={`Open evidence: ${sourceLabels.get(id) ?? id}`}
        >
          {sourceLabels.get(id) ?? id}
        </button>
      ))}
    </span>
  )

  if (brief === null) {
    return (
      <section aria-labelledby="brief-heading" className="space-y-3 rounded-md border p-4">
        <h2 id="brief-heading" className="text-base font-semibold">Interview brief</h2>
        <p className="text-muted-foreground text-sm">
          No brief yet. Generating one reads the candidate’s documents and approved links, and costs 5 AI
          interview credits.
        </p>
        {canEdit && (
          <Button type="button" disabled={busy !== null} onClick={() => void generate()}>
            {busy === 'generate'
              ? <><Loader2 aria-hidden className="mr-2 size-4 animate-spin" />Generating…</>
              : <><Sparkles aria-hidden className="mr-2 size-4" />Generate brief (5 credits)</>}
          </Button>
        )}
        {error !== null && <p role="alert" className="text-destructive text-xs">{error}</p>}
      </section>
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <section aria-labelledby="brief-heading" className="space-y-4 rounded-md border p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id="brief-heading" className="text-base font-semibold">Interview brief</h2>
            <p className="text-muted-foreground text-xs">
              Version {brief.version} · {brief.status}
              {/* Provenance on screen. A fallback presented as model output would be the most misleading
                  thing this component could do. */}
              {isFallback
                ? ' · written without AI'
                : ` · ${brief.provider}${brief.model ? ` (${brief.model})` : ''}`}
              {brief.editedByUserId !== null && ' · edited by hand'}
            </p>
            {/* The Article 50 label, from one shared component so it cannot end up partly present. */}
            <AiDraftNotice
              provider={isFallback ? null : brief.provider}
              model={brief.model}
              kind="brief"
              editedByUserId={brief.editedByUserId}
            />
          </div>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" size="sm" disabled={busy !== null} onClick={() => void generate()}>
                {busy === 'generate'
                  ? <><Loader2 aria-hidden className="mr-2 size-3 animate-spin" />Regenerating…</>
                  : <><RefreshCw aria-hidden className="mr-2 size-3" />Regenerate (5 credits)</>}
              </Button>
              {brief.status !== 'active' && (
                <Button type="button" size="sm" disabled={busy !== null} onClick={accept}>
                  {busy === 'accept'
                    ? <><Loader2 aria-hidden className="mr-2 size-3 animate-spin" />Accepting…</>
                    : <><Check aria-hidden className="mr-2 size-3" />Use this version</>}
                </Button>
              )}
            </div>
          )}
        </div>

        {isFallback && (
          <p className="flex items-start gap-1 rounded border p-2 text-xs">
            <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
            This brief was assembled without AI. Read the evidence directly before the interview.
          </p>
        )}

        {hasNewerVersion && (
          // Offered, not applied. Silently loading the newer version would discard whatever is being typed.
          <p role="status" className="rounded border p-2 text-xs">
            A newer version ({latestVersion}) exists. Your edits here are still unsaved —
            {' '}<button type="button" className="underline" onClick={onChanged}>load the newer version</button>
            {' '}when you are ready.
          </p>
        )}

        <div className="space-y-1">
          <label htmlFor="brief-summary" className="text-sm font-medium">Summary</label>
          <Textarea
            id="brief-summary"
            rows={4}
            value={summary}
            readOnly={!canEdit}
            onChange={(event) => setSummaryDraft(event.target.value)}
          />
          {canEdit && summaryDraft !== null && (
            <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={save}>
              {busy === 'save' ? 'Saving…' : 'Save summary'}
            </Button>
          )}
        </div>

        <section aria-labelledby="brief-evidence-heading" className="space-y-1">
          <h3 id="brief-evidence-heading" className="text-sm font-medium">What the sources support</h3>
          {brief.content.relevantEvidence.length === 0
            ? <p className="text-muted-foreground text-xs">No claims were drawn from the sources.</p>
            : (
              <ul className="space-y-1 text-sm">
                {brief.content.relevantEvidence.map((entry, index) => (
                  <li key={`${entry.claim}-${index}`}>
                    {entry.claim}
                    <span className="text-muted-foreground ml-1 text-[10px]">({CONFIDENCE_LABEL[entry.confidence]})</span>
                    {citation(entry.sourceIds)}
                  </li>
                ))}
              </ul>
            )}
        </section>

        {brief.content.contradictions.length > 0 && (
          <section aria-labelledby="brief-contradictions-heading" className="space-y-1">
            <h3 id="brief-contradictions-heading" className="text-sm font-medium">Contradictions to resolve</h3>
            <ul className="space-y-1 text-sm">
              {brief.content.contradictions.map((entry, index) => (
                <li key={`${entry.description}-${index}`}>{entry.description}{citation(entry.sourceIds)}</li>
              ))}
            </ul>
          </section>
        )}

        {brief.content.informationGaps.length > 0 && (
          <section aria-labelledby="brief-gaps-heading" className="space-y-1">
            <h3 id="brief-gaps-heading" className="text-sm font-medium">What the sources do not say</h3>
            {/* Gaps carry no citations by design: the absence of evidence has no source to point at. */}
            <ul className="list-inside list-disc space-y-1 text-sm">
              {brief.content.informationGaps.map((gap, index) => <li key={`${gap}-${index}`}>{gap}</li>)}
            </ul>
          </section>
        )}

        <section aria-labelledby="brief-questions-heading" className="space-y-2">
          <h3 id="brief-questions-heading" className="text-sm font-medium">Suggested questions</h3>
          {(['critical', 'technical', 'general'] as const).map((category) => {
            const group = brief.content.questionGroups.filter((entry) => entry.category === category)
            if (group.length === 0) return null
            return (
              <div key={category} className="space-y-1">
                <p className="text-muted-foreground text-xs uppercase">{category}</p>
                <ul className="space-y-1 text-sm">
                  {group.map((entry, index) => (
                    <li key={`${entry.question}-${index}`}>
                      {entry.question}
                      <span className="text-muted-foreground block text-xs">{entry.rationale}{citation(entry.sourceIds)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </section>

        {error !== null && <p role="alert" className="text-destructive text-xs">{error}</p>}
      </section>

      <EvidenceDrawer
        sources={brief.evidenceManifest}
        openSourceId={openSourceId}
        onClose={() => setOpenSourceId(null)}
      />
    </div>
  )
}
