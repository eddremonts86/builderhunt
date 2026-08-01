import * as React from 'react'
import { InvitationStatus, type InvitationSummary } from './InvitationStatus'

/**
 * Filtered, paginated wrapper around `InvitationStatus` for the central invitation hub (plans/UI
 * Wave 3 "Build a central invitation management hub").
 *
 * `GET /api/scheduling/invitations` returns everything the owner has ever issued in one response —
 * there is no server-side filter or cursor. That is fine at the scale one organizer's invitations
 * reach, so filtering and paging are done here over the array already in memory rather than adding
 * a query contract for a list that never needs one. The status filter lives in the URL (see the
 * route) so a draft the organizer was just looking at is still filtered-to after a refresh.
 */

const STATUS_FILTERS = ['all', 'draft', 'sent', 'opened', 'booked', 'declined', 'expired', 'revoked'] as const
export type InvitationStatusFilter = typeof STATUS_FILTERS[number]

const FILTER_LABELS: Record<InvitationStatusFilter, string> = {
  all: 'All',
  draft: 'Draft',
  sent: 'Sent',
  opened: 'Opened',
  booked: 'Booked',
  declined: 'Declined',
  expired: 'Expired',
  revoked: 'Revoked',
}

const PAGE_SIZE = 10

export interface InvitationListProps {
  invitations: InvitationSummary[]
  onChanged: () => void
  /** Controlled filter, so the route can persist it in the URL; uncontrolled (local state) when omitted. */
  statusFilter?: InvitationStatusFilter
  onStatusFilterChange?: (filter: InvitationStatusFilter) => void
}

export function InvitationList({ invitations, onChanged, statusFilter, onStatusFilterChange }: InvitationListProps) {
  const [localFilter, setLocalFilter] = React.useState<InvitationStatusFilter>('all')
  const [page, setPage] = React.useState(0)
  const filter = statusFilter ?? localFilter

  function setFilter(next: InvitationStatusFilter) {
    setPage(0)
    if (onStatusFilterChange) onStatusFilterChange(next)
    else setLocalFilter(next)
  }

  const filtered = React.useMemo(
    () => (filter === 'all' ? invitations : invitations.filter((invitation) => invitation.status === filter)),
    [invitations, filter],
  )

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const clampedPage = Math.min(page, pageCount - 1)
  const pageItems = filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE)

  const countByStatus = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const invitation of invitations) counts.set(invitation.status, (counts.get(invitation.status) ?? 0) + 1)
    return counts
  }, [invitations])

  return (
    <div className="space-y-4" data-testid="invitation-list">
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter invitations by status">
        {STATUS_FILTERS.map((option) => {
          const count = option === 'all' ? invitations.length : countByStatus.get(option) ?? 0
          return (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={filter === option}
              onClick={() => setFilter(option)}
              data-testid={`invitation-filter-${option}`}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                filter === option
                  ? 'border-bh-accent bg-bh-accent-soft text-bh-text'
                  : 'border-bh-border text-bh-text-muted hover:text-bh-text'
              }`}
            >
              {FILTER_LABELS[option]} ({count})
            </button>
          )
        })}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-bh-text-muted" data-testid="invitation-list-empty">
          {filter === 'all' ? 'No interview invitations yet.' : `No ${FILTER_LABELS[filter].toLowerCase()} invitations.`}
        </p>
      ) : (
        <InvitationStatus invitations={pageItems} onChanged={onChanged} />
      )}

      {pageCount > 1 && (
        <div className="flex items-center justify-between text-xs text-bh-text-muted">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={clampedPage === 0}
            className="disabled:opacity-40"
            data-testid="invitation-list-prev"
          >
            Previous
          </button>
          <span data-testid="invitation-list-page">Page {clampedPage + 1} of {pageCount}</span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={clampedPage >= pageCount - 1}
            className="disabled:opacity-40"
            data-testid="invitation-list-next"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
