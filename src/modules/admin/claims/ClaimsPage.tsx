import * as React from 'react'
import { ExternalLink, ShieldCheck } from 'lucide-react'
import { Button, Input, Textarea } from '~/components/ui'

type ClaimStatus = 'pending' | 'verified' | 'rejected' | 'revoked' | 'expired'

interface AdminBuilderClaim {
  id: string
  status: ClaimStatus
  evidenceSource: string
  evidenceReference: string
  subjectUserId: string
  subjectName: string | null
  subjectEmail: string | null
  builderIdentityId: string
  builderSource: string
  builderUsername: string
  builderDisplayName: string | null
  expiresAt: string | null
  verifiedAt: string | null
  revokedAt: string | null
  revokedByUserId: string | null
  revocationReason: string | null
  createdAt: string
  directoryPublished: boolean
  portfolioPublished: boolean
}

interface ListResponse {
  rows: AdminBuilderClaim[]
  nextCursor: { createdAt: string; id: string } | null
}

const STATUS_FILTERS: Array<{ value: ClaimStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'verified', label: 'Verified' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'revoked', label: 'Revoked' },
  { value: 'expired', label: 'Expired' },
]

const STATUS_COLOR: Record<ClaimStatus, string> = {
  pending: 'bg-bh-surface text-bh-text-muted',
  verified: 'bg-bh-success/15 text-bh-success',
  rejected: 'bg-bh-text-dim/15 text-bh-text-dim',
  revoked: 'bg-bh-danger/15 text-bh-danger',
  expired: 'bg-bh-warning/15 text-bh-warning',
}

export function ClaimsPage() {
  const [rows, setRows] = React.useState<AdminBuilderClaim[]>([])
  const [nextCursor, setNextCursor] = React.useState<{ createdAt: string; id: string } | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [statusFilter, setStatusFilter] = React.useState<ClaimStatus | 'all'>('all')
  const [sourceFilter, setSourceFilter] = React.useState('')
  const [expandedId, setExpandedId] = React.useState<string | null>(null)
  const [revokeReason, setRevokeReason] = React.useState('')
  const [revoking, setRevoking] = React.useState(false)
  const [revokeError, setRevokeError] = React.useState<string | null>(null)

  const buildQuery = React.useCallback((cursor?: { createdAt: string; id: string } | null) => {
    const params = new URLSearchParams()
    if (statusFilter !== 'all') params.set('status', statusFilter)
    if (sourceFilter.trim()) params.set('source', sourceFilter.trim())
    if (cursor) {
      params.set('before', cursor.createdAt)
      params.set('id', cursor.id)
    }
    return params.toString()
  }, [statusFilter, sourceFilter])

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/builder-claims?${buildQuery()}`, { credentials: 'include' })
      if (!res.ok) {
        setError(`Failed to load: ${res.status}`)
        return
      }
      const body = await res.json() as ListResponse
      setRows(body.rows)
      setNextCursor(body.nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [buildQuery])

  React.useEffect(() => { load() }, [load])

  const loadMore = async () => {
    if (!nextCursor) return
    setLoadingMore(true)
    try {
      const res = await fetch(`/api/admin/builder-claims?${buildQuery(nextCursor)}`, { credentials: 'include' })
      if (!res.ok) return
      const body = await res.json() as ListResponse
      setRows((prev) => [...prev, ...body.rows])
      setNextCursor(body.nextCursor)
    } finally {
      setLoadingMore(false)
    }
  }

  const openDetail = (id: string) => {
    setExpandedId(expandedId === id ? null : id)
    setRevokeReason('')
    setRevokeError(null)
  }

  const revoke = async (claim: AdminBuilderClaim) => {
    if (revokeReason.trim().length < 3) {
      setRevokeError('A reason (at least 3 characters) is required.')
      return
    }
    setRevoking(true)
    setRevokeError(null)
    try {
      const res = await fetch(`/api/admin/builder-claims/${claim.id}/revoke`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: revokeReason.trim() }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setRevokeError(body.error ?? `Failed: ${res.status}`)
        return
      }
      setExpandedId(null)
      setRevokeReason('')
      await load()
    } catch (e) {
      setRevokeError(e instanceof Error ? e.message : String(e))
    } finally {
      setRevoking(false)
    }
  }

  return (
    <div data-testid="admin-claims-page">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-bh-accent" aria-hidden="true" />
          Claims
        </h1>
        <p className="text-sm text-bh-text-muted mt-1">
          Builder profile claims across every organization — status, verification, and publication
          state. Revoking here takes effect immediately on the public profile and portfolio.
        </p>
      </header>

      {error && (
        <div className="card border-bh-danger/30 bg-bh-danger/5 p-3 mb-4 text-sm text-bh-danger" role="alert">
          {error}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filter by status">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setStatusFilter(f.value)}
            aria-pressed={statusFilter === f.value}
            data-testid={`admin-claims-filter-${f.value}`}
            className={`rounded px-2.5 py-1 text-xs font-medium ${
              statusFilter === f.value ? 'bg-bh-accent text-white' : 'bg-bh-surface text-bh-text-muted hover:text-bh-text'
            }`}
          >
            {f.label}
          </button>
        ))}
        <Input
          type="text"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          placeholder="Filter by source (github, reddit…)"
          className="w-56 h-7 text-xs"
          data-testid="admin-claims-filter-source"
        />
      </div>

      {loading ? (
        <p className="text-sm text-bh-text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-bh-text-muted">No claims match this filter.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((claim) => (
            <div key={claim.id} data-testid={`admin-claim-row-${claim.id}`}>
              <div className="card p-4 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className={`text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded ${STATUS_COLOR[claim.status]}`}>
                      {claim.status}
                    </span>
                    <span className="text-[10px] text-bh-text-dim uppercase tracking-wider">{claim.builderSource}</span>
                    {claim.directoryPublished && (
                      <span className="text-[10px] text-bh-success">Directory published</span>
                    )}
                    {claim.portfolioPublished && (
                      <span className="text-[10px] text-bh-success">Portfolio published</span>
                    )}
                  </div>
                  <p className="font-semibold text-sm">
                    {claim.builderDisplayName ?? claim.builderUsername}
                    <span className="text-bh-text-dim font-normal"> · claimed by {claim.subjectName ?? claim.subjectEmail ?? claim.subjectUserId}</span>
                  </p>
                  <p className="text-xs text-bh-text-dim mt-1">
                    Created {new Date(claim.createdAt).toLocaleString()}
                    {claim.verifiedAt && ` · Verified ${new Date(claim.verifiedAt).toLocaleString()}`}
                    {claim.revokedAt && ` · Revoked ${new Date(claim.revokedAt).toLocaleString()}`}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <a
                    href={`/builders/${claim.builderIdentityId}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-xs text-bh-accent hover:underline inline-flex items-center gap-1"
                  >
                    Profile <ExternalLink className="w-3 h-3" aria-hidden="true" />
                  </a>
                  {claim.portfolioPublished && (
                    <a
                      href={`/portfolio/${claim.id}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-xs text-bh-accent hover:underline inline-flex items-center gap-1"
                    >
                      Portfolio <ExternalLink className="w-3 h-3" aria-hidden="true" />
                    </a>
                  )}
                  <Button
                    type="button"
                    onClick={() => openDetail(claim.id)}
                    variant="secondary"
                    size="sm"
                    data-testid={`admin-claim-detail-toggle-${claim.id}`}
                  >
                    {expandedId === claim.id ? 'Close' : 'Details'}
                  </Button>
                </div>
              </div>

              {expandedId === claim.id && (
                <div className="card p-4 mt-1 space-y-3" data-testid={`admin-claim-detail-${claim.id}`}>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <dt className="text-bh-text-dim">Claim id</dt><dd className="font-mono">{claim.id}</dd>
                    <dt className="text-bh-text-dim">Subject user</dt><dd>{claim.subjectEmail ?? claim.subjectUserId}</dd>
                    <dt className="text-bh-text-dim">Evidence source</dt><dd>{claim.evidenceSource}</dd>
                    <dt className="text-bh-text-dim">Evidence reference</dt><dd className="font-mono truncate">{claim.evidenceReference}</dd>
                    <dt className="text-bh-text-dim">Expires</dt><dd>{claim.expiresAt ? new Date(claim.expiresAt).toLocaleString() : '—'}</dd>
                    {claim.revocationReason && (
                      <>
                        <dt className="text-bh-text-dim">Revocation reason</dt><dd>{claim.revocationReason}</dd>
                      </>
                    )}
                  </dl>

                  {claim.status === 'verified' && (
                    <div className="border-t border-bh-border pt-3 space-y-2">
                      <label htmlFor={`admin-claim-revoke-reason-${claim.id}`} className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block">
                        Revoke — reason (required)
                      </label>
                      <Textarea
                        id={`admin-claim-revoke-reason-${claim.id}`}
                        value={revokeReason}
                        onChange={(e) => setRevokeReason(e.target.value)}
                        placeholder="Why is this claim being revoked?"
                        className="w-full min-h-[60px]"
                        data-testid="admin-claim-revoke-reason"
                      />
                      {revokeError && <p className="text-xs text-bh-danger" role="alert">{revokeError}</p>}
                      <Button
                        type="button"
                        onClick={() => revoke(claim)}
                        disabled={revoking || revokeReason.trim().length < 3}
                        variant="danger"
                        size="sm"
                        data-testid={`admin-claim-revoke-confirm-${claim.id}`}
                      >
                        {revoking ? 'Revoking…' : 'Revoke claim'}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {nextCursor && (
            <div className="pt-2">
              <Button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                variant="secondary"
                size="sm"
                data-testid="admin-claims-load-more"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
