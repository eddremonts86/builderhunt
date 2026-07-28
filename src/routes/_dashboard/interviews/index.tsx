import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { InterviewList, type InterviewListRowView } from '~/modules/interviews/components/InterviewList'

/**
 * The interviews index (plan: calendar-scheduling-interview-intelligence, Phase 10 follow-up).
 *
 * Added because there was no way to reach an interview without typing a calendar event's uuid into the URL
 * bar. Everything else in the feature assumed you had already arrived.
 */
export const Route = createFileRoute('/_dashboard/interviews/')({
  component: InterviewsPage,
})

function InterviewsPage() {
  const [interviews, setInterviews] = useState<InterviewListRowView[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/interviews', { headers: { accept: 'application/json' } })
      if (!response.ok) {
        setError(response.status === 403
          ? 'You do not have access to interviews in this organization.'
          : 'Could not load your interviews.')
        return
      }
      const body = await response.json() as { interviews: InterviewListRowView[] }
      setError(null)
      setInterviews(body.interviews)
    } catch {
      setError('Could not load your interviews.')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Interviews</h1>
        <p className="text-sm text-muted-foreground">
          Booked interviews you own. Open a brief before one, join it when it starts, and write up the record
          afterwards.
        </p>
      </header>

      {error !== null ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : interviews === null ? (
        <p className="text-sm text-muted-foreground">Loading your interviews…</p>
      ) : (
        <InterviewList interviews={interviews} />
      )}
    </div>
  )
}
