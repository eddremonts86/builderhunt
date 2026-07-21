/**
 * Public Evidence Card (plan: stealth-scraping — Public Profile Enrichment).
 * Spec §13. Fetches GET /api/builders/:id/evidence on mount, offers a manual
 * refresh, polls with capped backoff while a job is active, and — when
 * evidence needs review — lets the viewer accept/reject (server enforces
 * owner/admin only; a 403 here just surfaces a message, it never fakes the
 * action as having happened).
 */
import * as React from 'react'
import { ShieldCheck, RefreshCw, ExternalLink } from 'lucide-react'

interface PublicEvidenceCardProps {
  builderId: string
}

interface EnrichmentJob {
  id: string
  status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'
  lastErrorCode: string | null
}

interface EnrichmentEvidence {
  id: string
  connector: string
  sourceUrl: string
  payload: { headline?: string; organization?: string; topics?: string[] }
  confidenceBps: number
  matchSignals: string[]
  resolution: 'accepted' | 'review' | 'rejected'
  observedAt: string
  expiresAt: string
}

type CardState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'idle'; evidence: EnrichmentEvidence[] }
  | { kind: 'active'; job: EnrichmentJob; evidence: EnrichmentEvidence[] }
  | { kind: 'restricted' }
  | { kind: 'error'; message: string }

const POLL_DELAYS_MS = [2000, 3000, 5000, 8000, 13000]
const MAX_POLLS = POLL_DELAYS_MS.length

function confidenceLabel(bps: number): string {
  if (bps >= 9000) return 'High confidence'
  if (bps >= 7000) return 'Needs review'
  return 'Low confidence'
}

export function PublicEvidenceCard({ builderId }: PublicEvidenceCardProps) {
  const [state, setState] = React.useState<CardState>({ kind: 'loading' })
  const [refreshing, setRefreshing] = React.useState(false)
  const pollCountRef = React.useRef(0)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = React.useRef(true)

  const loadRef = React.useRef<() => Promise<void>>(async () => {})

  const schedulePoll = React.useCallback(() => {
    if (pollCountRef.current >= MAX_POLLS) return
    const delay = POLL_DELAYS_MS[pollCountRef.current]
    pollCountRef.current += 1
    timerRef.current = setTimeout(() => {
      if (mountedRef.current) loadRef.current()
    }, delay)
  }, [])

  const load = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/builders/${builderId}/evidence/`, { credentials: 'include' })
      if (!mountedRef.current) return
      if (!res.ok) {
        setState({ kind: 'unavailable' })
        return
      }
      const body = await res.json() as { job: EnrichmentJob | null; evidence: EnrichmentEvidence[] }
      if (body.job && (body.job.status === 'queued' || body.job.status === 'running')) {
        setState({ kind: 'active', job: body.job, evidence: body.evidence })
        schedulePoll()
      } else {
        setState({ kind: 'idle', evidence: body.evidence })
      }
    } catch {
      if (mountedRef.current) setState({ kind: 'error', message: 'Network error loading public evidence' })
    }
  }, [builderId, schedulePoll])

  React.useEffect(() => {
    loadRef.current = load
  }, [load])

  React.useEffect(() => {
    mountedRef.current = true
    load()
    return () => {
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builderId])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      const res = await fetch(`/api/builders/${builderId}/evidence-refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectors: ['github'] }),
      })
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}))
        if (body.error === 'processing_restricted') {
          setState({ kind: 'restricted' })
          return
        }
      }
      if (res.status === 503) {
        setState({ kind: 'unavailable' })
        return
      }
      pollCountRef.current = 0
      await load()
    } finally {
      setRefreshing(false)
    }
  }

  const handleReview = async (evidenceId: string, resolution: 'accepted' | 'rejected') => {
    const res = await fetch(`/api/builders/${builderId}/evidence/${evidenceId}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution }),
    })
    if (res.ok) await load()
  }

  if (state.kind === 'loading') {
    return <div className="card p-5 animate-pulse h-20" data-testid="public-evidence-card-loading" />
  }
  if (state.kind === 'unavailable') return null
  if (state.kind === 'restricted') {
    return (
      <div className="card p-5" data-testid="public-evidence-card" data-state="restricted">
        <p className="text-sm text-bh-text-dim">This builder has restricted automated processing of their public profile.</p>
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div className="card p-5" data-testid="public-evidence-card" data-state="error">
        <p className="text-sm text-bh-text-dim" role="alert">{state.message}</p>
      </div>
    )
  }

  const jobActive = state.kind === 'active'
  const evidence = state.kind === 'active' ? state.evidence : state.evidence

  return (
    <div className="card p-5" data-testid="public-evidence-card" data-state={jobActive ? 'active' : 'idle'}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-base font-semibold text-bh-text flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Public evidence
        </h3>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing || jobActive}
          data-testid="evidence-refresh-button"
          className="text-xs text-bh-text-dim hover:text-bh-text flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing || jobActive ? 'animate-spin' : ''}`} aria-hidden="true" />
          {jobActive ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {evidence.length === 0 && !jobActive && (
        <p className="text-sm text-bh-text-dim" data-testid="evidence-empty">
          No public evidence yet. Refresh to check official-API sources.
        </p>
      )}

      <ul className="space-y-3">
        {evidence.map((item) => (
          <li key={item.id} className="border border-bh-border rounded-lg p-3" data-testid="evidence-item" data-resolution={item.resolution}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-bh-text-dim">{item.connector}</span>
              <span className="text-xs text-bh-text-dim">{confidenceLabel(item.confidenceBps)}</span>
            </div>
            {item.payload.headline && <p className="text-sm text-bh-text mt-1">{item.payload.headline}</p>}
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-xs text-bh-accent flex items-center gap-1 mt-1"
            >
              Source <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </a>
            <p className="text-[11px] text-bh-text-dim mt-1">
              Observed {new Date(item.observedAt).toLocaleDateString()} · expires {new Date(item.expiresAt).toLocaleDateString()}
            </p>
            {item.resolution === 'review' && (
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => handleReview(item.id, 'accepted')}
                  className="text-xs px-2 py-1 rounded bg-bh-accent/10 text-bh-accent"
                  data-testid="evidence-accept"
                >
                  Accept
                </button>
                <button
                  type="button"
                  onClick={() => handleReview(item.id, 'rejected')}
                  className="text-xs px-2 py-1 rounded bg-bh-border text-bh-text-dim"
                  data-testid="evidence-reject"
                >
                  Reject
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
