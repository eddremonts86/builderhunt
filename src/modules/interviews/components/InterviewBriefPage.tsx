import { useCallback, useEffect, useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { InterviewBriefEditor, type BriefView } from './InterviewBriefEditor'
import { InterviewReportEditor, type ReportContent, type ReportView } from './InterviewReportEditor'
import { CreditBalance, type CreditBalanceProps } from './CreditBalance'
import { InterviewParticipantsPanel } from './InterviewParticipantsPanel'
import type { EvidenceSegment } from './TranscriptEvidence'

/**
 * Loads and renders one interview's brief alongside the credit state.
 *
 * ## Two independent loads, and a failure of one does not blank the other
 *
 * The brief and the billing summary come from different routes with different permissions: a plain member
 * can read availability but not a balance. Loading them together and failing together would mean a
 * billing hiccup hides a brief that loaded perfectly well.
 *
 * ## `canEdit` comes from the server's answer, not from a role guess
 *
 * A participant can read a brief and must not be offered a regenerate button that the API will refuse.
 * The read response says whether this reader owns it; the client does not infer it from a role string.
 */
interface ReportResponse {
  report: ReportView | null
  latestVersion: number | null
  canEdit?: boolean
}

interface SegmentResponse {
  segments: Array<{
    id: string
    startsMs: number
    speakerEstimate: string
    speakerMapping: string | null
    text: string
  }>
}

interface BriefResponse {
  brief: (BriefView & { id: string; eventId: string }) | null
  latestVersion: number | null
  hasUnreviewedDraft?: boolean
  canEdit?: boolean
}

export function InterviewBriefPage() {
  const { interviewId } = useParams({ strict: false }) as { interviewId: string }

  const [brief, setBrief] = useState<BriefResponse | null>(null)
  const [summary, setSummary] = useState<CreditBalanceProps['summary']>(null)
  const [summaryStale, setSummaryStale] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [report, setReport] = useState<ReportResponse | null>(null)
  const [segments, setSegments] = useState<EvidenceSegment[]>([])

  const loadBrief = useCallback(async () => {
    try {
      const response = await fetch(`/api/interviews/${interviewId}/brief`, { headers: { accept: 'application/json' } })
      if (!response.ok) {
        setLoadError(response.status === 403 ? 'You do not have access to this interview.' : 'Could not load this brief.')
        return
      }
      setLoadError(null)
      setBrief(await response.json() as BriefResponse)
    } catch {
      setLoadError('Could not load this brief.')
    }
  }, [interviewId])

  const loadSummary = useCallback(async () => {
    try {
      const response = await fetch('/api/billing/summary', { headers: { accept: 'application/json' } })
      if (!response.ok) {
        // Kept whatever was on screen and flagged, rather than blanked: a stale balance is better
        // information than none, and blanking reads as "you have no credits".
        setSummaryStale(true)
        return
      }
      setSummaryStale(false)
      setSummary(await response.json() as CreditBalanceProps['summary'])
    } catch {
      setSummaryStale(true)
    }
  }, [])

  const loadReport = useCallback(async () => {
    try {
      const [reportResponse, segmentResponse] = await Promise.all([
        fetch(`/api/interviews/${interviewId}/report`, { headers: { accept: 'application/json' } }),
        fetch(`/api/interviews/${interviewId}/segments`, { headers: { accept: 'application/json' } }),
      ])
      // A failure here leaves the brief alone. An interview with no report is the normal case, and treating
      // it as an error would put a red banner on every interview that was never transcribed.
      if (reportResponse.ok) setReport(await reportResponse.json() as ReportResponse)
      if (segmentResponse.ok) {
        const body = await segmentResponse.json() as SegmentResponse
        setSegments(body.segments.map((segment) => ({
          id: segment.id,
          startsMs: segment.startsMs,
          speakerLabel: segment.speakerMapping === 'organizer' ? 'You'
            : segment.speakerMapping === 'candidate_or_remote' ? 'Candidate'
            : segment.speakerEstimate === 'speaker_a' ? 'Speaker A' : 'Speaker B',
          text: segment.text,
        })))
      }
    } catch {
      // Same reasoning: the brief is the primary content of this page.
      setReport((current) => current)
    }
  }, [interviewId])

  useEffect(() => {
    void loadBrief()
    void loadSummary()
    void loadReport()
  }, [loadBrief, loadReport, loadSummary])

  const onChanged = useCallback(() => {
    // Both, because generating a brief spends credits: refreshing only the brief would leave a balance
    // on screen that is five credits out of date.
    void loadBrief()
    void loadSummary()
  }, [loadBrief, loadSummary])

  return (
    <div className="space-y-4 p-4">
      <CreditBalance summary={summary} stale={summaryStale} />

      {loadError !== null ? (
        <p role="alert" className="text-destructive text-sm">{loadError}</p>
      ) : brief === null ? (
        <p className="text-muted-foreground text-sm">Loading brief…</p>
      ) : (
        <InterviewBriefEditor
          interviewId={interviewId}
          brief={brief.brief}
          latestVersion={brief.latestVersion}
          onChanged={onChanged}
          // Defaults to false: a client that cannot tell must not be offered an action the API will refuse.
          canEdit={brief.canEdit ?? false}
        />
      )}

      {report !== null && (
        <InterviewReportEditor
          report={report.report}
          latestVersion={report.latestVersion}
          segments={segments}
          canEdit={report.canEdit ?? false}
          topicQuestions={topicQuestionsFrom(brief?.brief)}
          onGenerate={async (organizerNotes) => {
            await postJson(`/api/interviews/${interviewId}/report`, { creditConfirmation: true, organizerNotes })
            // Both, because a report spends five credits.
            void loadReport()
            void loadSummary()
          }}
          onSave={async (content, expectedVersion) => {
            await patchJson(`/api/interviews/${interviewId}/report`, { expectedVersion, content })
            void loadReport()
          }}
          onFinalize={async (expectedVersion) => {
            await postJson(`/api/interviews/${interviewId}/finalize`, { expectedVersion, confirmFinal: true })
            void loadReport()
          }}
        />
      )}

      {/* Owner-only (plans/UI Wave 3 "Add interview participant material-access controls") — gated
          on the same `canEdit` the brief editor already uses, since that is the server's own answer
          to "does this reader own this interview", not a role guessed on the client. */}
      {brief?.canEdit === true && (
        <InterviewParticipantsPanel interviewId={interviewId} />
      )}
    </div>
  )
}

/**
 * Topic id → the question it came from.
 *
 * Derived exactly as the services do — critical, then technical, then general — so `topic:2` in a report
 * resolves to the same question the suggestion service attributed it to. Two independent orderings would put
 * the wrong question above the right answer, which is worse than showing the raw id.
 */
function topicQuestionsFrom(brief: BriefView | null | undefined): Record<string, string> {
  const groups = brief?.content.questionGroups
  if (!Array.isArray(groups)) return {}
  const rank: Record<string, number> = { critical: 0, technical: 1, general: 2 }
  const questions: Record<string, string> = {}
  ;[...groups]
    .sort((a, b) => (rank[a.category] ?? 3) - (rank[b.category] ?? 3))
    .forEach((group, index) => { questions[`topic:${index + 1}`] = group.question })
  return questions
}

/** Throws an error carrying the server's code, which is the only part the editor shows a user. */
async function postJson(url: string, body: unknown): Promise<void> {
  await sendJson(url, 'POST', body)
}

async function patchJson(url: string, body: unknown): Promise<void> {
  await sendJson(url, 'PATCH', body)
}

async function sendJson(url: string, method: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    // The code, never a message: a server message can echo request details, and these requests carry a
    // candidate's transcript.
    throw Object.assign(new Error(payload.error ?? 'failed'), { code: payload.error ?? 'failed' })
  }
}
