import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { InterviewList, type InterviewListRowView } from '~/modules/interviews/components/InterviewList'

/**
 * The interviews index (plan: calendar-scheduling-interview-intelligence, Phase 10 follow-up;
 * plans/UI Wave 3 "Add a tenant-safe Shared with me interview list").
 *
 * Added because there was no way to reach an interview without typing a calendar event's uuid into the URL
 * bar. Everything else in the feature assumed you had already arrived.
 *
 * "Shared with me" is a second, independent fetch against `/api/interviews/shared` — not a filter
 * over the owner list — because it is a genuinely different query (joined through
 * `event_participants.material_access_granted`, not `owner_user_id`) with its own failure mode: a
 * user with no grants ever just sees an empty section, never an error.
 */
export const Route = createFileRoute('/_dashboard/interviews/')({
  component: InterviewsPage,
})

function InterviewsPage() {
  const [interviews, setInterviews] = useState<InterviewListRowView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shared, setShared] = useState<InterviewListRowView[] | null>(null)
  const [sharedError, setSharedError] = useState<string | null>(null)

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

  const loadShared = useCallback(async () => {
    try {
      const response = await fetch('/api/interviews/shared', { headers: { accept: 'application/json' } })
      if (!response.ok) {
        setSharedError('Could not load interviews shared with you.')
        return
      }
      const body = await response.json() as { interviews: InterviewListRowView[] }
      setSharedError(null)
      setShared(body.interviews)
    } catch {
      setSharedError('Could not load interviews shared with you.')
    }
  }, [])

  useEffect(() => {
    void load()
    void loadShared()
  }, [load, loadShared])

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 p-4">
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

      {/* Only rendered once loaded and non-empty: a section titled "Shared with me" above an empty
          state would read as a promise nothing fulfilled, for the common case of no grants at all. */}
      {shared !== null && shared.length > 0 && (
        <section className="space-y-3" data-testid="shared-interviews-section">
          <div>
            <h2 className="text-lg font-semibold">Shared with me</h2>
            <p className="text-sm text-muted-foreground">
              Interviews a colleague gave you access to the brief, report, or transcript for.
            </p>
          </div>
          <InterviewList interviews={shared} />
        </section>
      )}
      {sharedError !== null && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {sharedError}
        </p>
      )}
    </div>
  )
}
