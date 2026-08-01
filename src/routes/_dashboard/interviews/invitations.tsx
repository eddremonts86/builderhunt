import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import { InvitationList, type InvitationStatusFilter } from '~/modules/scheduling/components/InvitationList'
import type { InvitationSummary } from '~/modules/scheduling/components/InvitationStatus'

/**
 * The central invitation management hub (plans/UI Wave 3 "Build a central invitation management
 * hub").
 *
 * Before this route, an invitation was only reachable from the one builder's profile page it was
 * created on — nothing let an organizer see every invitation they had ever issued, across
 * candidates, in one place. `GET /api/scheduling/invitations` already returned everything owned by
 * the caller; this route is the first UI that reads it as a list rather than one builder at a time.
 */
const InvitationsSearchSchema = z.object({
  status: z.enum(['all', 'draft', 'sent', 'opened', 'booked', 'declined', 'expired', 'revoked']).optional().default('all'),
})

export const Route = createFileRoute('/_dashboard/interviews/invitations')({
  validateSearch: InvitationsSearchSchema,
  component: InvitationsHubPage,
})

function InvitationsHubPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const [invitations, setInvitations] = useState<InvitationSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/scheduling/invitations', { credentials: 'include', headers: { accept: 'application/json' } })
      if (!response.ok) {
        setError(response.status === 401 ? 'Sign in again to see your invitations.' : 'Could not load your invitations.')
        return
      }
      const body = await response.json() as { invitations: InvitationSummary[] }
      setError(null)
      setInvitations(Array.isArray(body.invitations) ? body.invitations : [])
    } catch {
      setError('Could not reach the server.')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Invitations</h1>
        <p className="text-sm text-bh-text-muted">
          Every interview invitation you have issued, across every candidate — drafts you have not
          sent yet, invitations waiting on a reply, and everything already booked or closed out.
        </p>
      </header>

      {error !== null ? (
        <p role="alert" className="rounded-md border border-bh-danger/40 bg-bh-danger/10 p-3 text-sm text-bh-danger" data-testid="invitations-hub-error">
          {error}
        </p>
      ) : invitations === null ? (
        <p className="text-sm text-bh-text-muted">Loading your invitations…</p>
      ) : (
        <InvitationList
          invitations={invitations}
          onChanged={load}
          statusFilter={search.status as InvitationStatusFilter}
          onStatusFilterChange={(status) => navigate({ search: { status }, replace: true })}
        />
      )}
    </div>
  )
}
