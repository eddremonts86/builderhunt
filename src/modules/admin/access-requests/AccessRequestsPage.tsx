/**
 * The approve/revoke queue for invite-only sign-up.
 *
 * Deliberately plain: a list, two buttons per row, and a box to add someone directly. There is no
 * bulk-approve, because approving access is the one action here that cannot be undone quietly — a
 * revoked person keeps whatever they created — and a checkbox column invites approving a page of
 * strangers with one click.
 *
 * This component talks to `/api/admin/access-requests` and nothing else. It must not import
 * `~/shared/lib/access-requests`: that module reaches the database layer, and importing it from a
 * client component ships `postgres` into the browser bundle, which type-checks, lints, tests and
 * builds cleanly while breaking every page at runtime.
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, Loader2, Mail, ShieldOff, UserPlus, X } from 'lucide-react'

import { Button, Input } from '~/components/ui'
import { StatusFilterTabs } from '~/modules/admin/StatusFilterTabs'

type Status = 'pending' | 'approved' | 'rejected' | 'revoked'

interface AccessRequest {
  email: string
  status: Status
  requestedAt: string
  decidedAt: string | null
  decidedByUserId: string | null
  note: string | null
  hasLiveInvite: boolean
  inviteExpiresAt: string | null
  inviteConsumedAt: string | null
}

const STATUS_STYLE: Record<Status, string> = {
  pending: 'bg-bh-warning/15 text-bh-warning',
  approved: 'bg-bh-success/15 text-bh-success',
  rejected: 'bg-bh-text-dim/15 text-bh-text-dim',
  revoked: 'bg-bh-danger/15 text-bh-danger',
}

/**
 * The filter vocabulary, exported so the route builds its validator from the same list — one source, so a status
 * added here reaches both the strip and the URL allowlist with no second place to forget.
 */
export const ACCESS_STATUS_FILTERS: ReadonlyArray<{ value: Status | 'all'; label: string }> = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'revoked', label: 'Revoked' },
  { value: 'all', label: 'All' },
]

export function AccessRequestsPage({ status: filter }: { status: Status | 'all' }) {
  const [requests, setRequests] = useState<AccessRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyEmail, setBusyEmail] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const query = filter === 'all' ? '' : `?status=${filter}`
      const res = await fetch(`/api/admin/access-requests${query}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Could not load the queue (HTTP ${res.status})`)
      const data = await res.json()
      setRequests(data.requests ?? [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the queue')
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { void load() }, [load])

  const decide = async (email: string, action: 'approve' | 'reject' | 'revoke') => {
    setBusyEmail(email)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch('/api/admin/access-requests', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, action }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setNotice(
        action === 'approve'
          // Said plainly rather than implying an email went out, because none does yet.
          ? `${email} can now create an account. No invite email is sent yet — tell them directly.`
          : action === 'reject'
            // Says what it does and does not do: nothing is sent to them either way.
            ? `${email} was turned down. They are not told, and they cannot re-open the request themselves.`
            : `${email} can no longer create an account.`,
      )
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The decision did not go through')
    } finally {
      setBusyEmail(null)
    }
  }

  /** Approving an address that never asked. The endpoint 404s if there is no row, which is why this
   *  is worth its own affordance rather than reusing the row buttons. */
  const inviteDirectly = async () => {
    const email = inviteEmail.trim().toLowerCase()
    if (!email) return
    setBusyEmail(email)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch('/api/admin/access-requests', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, action: 'approve', note: 'added directly by an operator' }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 404) {
        throw new Error(`${email} has not requested access, so there is no row to approve yet.`)
      }
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setInviteEmail('')
      setNotice(`${email} can now create an account.`)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add that address')
    } finally {
      setBusyEmail(null)
    }
  }

  return (
    <div className="p-6 max-w-4xl" data-testid="admin-access-requests">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Access requests</h1>
        <p className="text-sm text-bh-text-dim mt-1">
          Sign-up is invite-only. An <strong>approved</strong> address here is the only thing that lets
          someone create an account — revoking stops future sign-ups but does not remove an account
          that already exists.
        </p>
      </header>

      <div className="card p-4 mb-6">
        <label htmlFor="invite-email" className="block text-sm font-medium mb-1">
          Approve an address directly
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            id="invite-email"
            type="email"
            placeholder="them@example.com"
            value={inviteEmail}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInviteEmail(e.target.value)}
            data-testid="access-invite-input"
          />
          <Button
            onClick={() => void inviteDirectly()}
            disabled={!inviteEmail.trim() || busyEmail !== null}
            data-testid="access-invite-submit"
            className="whitespace-nowrap"
          >
            <UserPlus className="w-4 h-4" aria-hidden="true" />
            Approve
          </Button>
        </div>
      </div>

      <div className="mb-4">
        <StatusFilterTabs
          to="/admin/access-requests"
          current={filter}
          options={ACCESS_STATUS_FILTERS}
          testIdPrefix="access-filter"
        />
      </div>

      {notice && (
        <p className="text-sm mb-4 text-bh-success" role="status" data-testid="access-notice">{notice}</p>
      )}
      {error && (
        <p className="text-sm mb-4 text-bh-danger" role="alert" data-testid="access-error">{error}</p>
      )}

      {loading
        ? (
            <p className="text-sm text-bh-text-dim flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              Loading…
            </p>
          )
        : requests.length === 0
          ? (
              <p className="text-sm text-bh-text-dim" data-testid="access-empty">
                {filter === 'pending'
                  ? 'Nobody is waiting. Requests appear here as people ask for access.'
                  : `No ${filter === 'all' ? '' : filter} requests.`}
              </p>
            )
          : (
              <ul className="space-y-2" data-testid="access-request-list">
                {requests.map((row) => (
                  <li key={row.email} className="card p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium break-all">{row.email}</span>
                        <span className={`text-xs px-2 py-0.5 rounded ${STATUS_STYLE[row.status]}`}>
                          {row.status}
                        </span>
                        {row.inviteConsumedAt && (
                          <span className="text-xs text-bh-text-dim">signed up</span>
                        )}
                        {row.hasLiveInvite && !row.inviteConsumedAt && (
                          <span className="text-xs text-bh-text-dim flex items-center gap-1">
                            <Mail className="w-3 h-3" aria-hidden="true" />
                            invite live
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-bh-text-dim mt-1">
                        asked {new Date(row.requestedAt).toLocaleDateString()}
                        {row.decidedAt && ` · decided ${new Date(row.decidedAt).toLocaleDateString()}`}
                        {row.note && ` · ${row.note}`}
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      {row.status !== 'approved' && (
                        <Button
                          size="sm"
                          onClick={() => void decide(row.email, 'approve')}
                          disabled={busyEmail !== null}
                          data-testid={`access-approve-${row.email}`}
                        >
                          <Check className="w-4 h-4" aria-hidden="true" />
                          Approve
                        </Button>
                      )}
                      {row.status === 'pending' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void decide(row.email, 'reject')}
                          disabled={busyEmail !== null}
                          data-testid={`access-reject-${row.email}`}
                        >
                          <X className="w-4 h-4" aria-hidden="true" />
                          Reject
                        </Button>
                      )}
                      {row.status === 'approved' && (
                        <Button
                          size="sm"
                          variant="danger-outline"
                          onClick={() => void decide(row.email, 'revoke')}
                          disabled={busyEmail !== null}
                          data-testid={`access-revoke-${row.email}`}
                        >
                          <ShieldOff className="w-4 h-4" aria-hidden="true" />
                          Revoke
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
    </div>
  )
}
