import { useCallback, useEffect, useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { InterviewBriefEditor, type BriefView } from './InterviewBriefEditor'
import { CreditBalance, type CreditBalanceProps } from './CreditBalance'

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

  useEffect(() => {
    void loadBrief()
    void loadSummary()
  }, [loadBrief, loadSummary])

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
    </div>
  )
}
