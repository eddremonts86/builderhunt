/**
 * Verified-subject provenance + restrict-processing panel (plans/UI/tasks.md Wave 4
 * "Add verified-subject provenance UI" and "Add restrict-processing confirmation and state").
 *
 * Reads `GET /api/me/builder/:builderId/evidence-provenance`, which is already the allowlisted
 * projection (source, field categories, observation date, retention state, plus current
 * restriction state) — this component only renders what that route returns, it never fetches or
 * displays anything about the organizations, recruiters, or scores behind the evidence.
 */
import * as React from 'react'
import { ShieldAlert, ShieldOff, ExternalLink } from 'lucide-react'

interface EvidenceProvenancePanelProps {
  builderId: string
}

interface ProvenanceEntry {
  source: string
  fieldCategories: string[]
  observedAt: string
  expiresAt: string
  retentionState: 'active' | 'expired'
}

type PanelState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'restricted'; since: string }
  | { kind: 'ready'; provenance: ProvenanceEntry[] }

export function EvidenceProvenancePanel({ builderId }: EvidenceProvenancePanelProps) {
  const [state, setState] = React.useState<PanelState>({ kind: 'loading' })
  const [confirming, setConfirming] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [restrictError, setRestrictError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const res = await fetch(`/api/me/builder/${builderId}/evidence-provenance`, { credentials: 'include' })
      if (!res.ok) {
        setState({ kind: 'error', message: 'Could not load evidence provenance.' })
        return
      }
      const body = await res.json() as { provenance: ProvenanceEntry[]; restrictedSince: string | null }
      if (body.restrictedSince) {
        setState({ kind: 'restricted', since: body.restrictedSince })
      } else {
        setState({ kind: 'ready', provenance: body.provenance })
      }
    } catch {
      setState({ kind: 'error', message: 'Network error loading evidence provenance.' })
    }
  }, [builderId])

  React.useEffect(() => { void load() }, [load])

  const confirmRestrict = async () => {
    setSubmitting(true)
    setRestrictError(null)
    try {
      const res = await fetch(`/api/me/builder/${builderId}/restrict-processing`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) {
        setRestrictError('Could not restrict processing. Please try again.')
        return
      }
      setConfirming(false)
      await load()
    } catch {
      setRestrictError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (state.kind === 'loading') {
    return <div className="card p-5 animate-pulse h-20" data-testid="evidence-provenance-panel-loading" />
  }

  if (state.kind === 'error') {
    return (
      <div className="card p-5" data-testid="evidence-provenance-panel" data-state="error">
        <p className="text-sm text-bh-text-dim" role="alert">{state.message}</p>
      </div>
    )
  }

  if (state.kind === 'restricted') {
    return (
      <div className="card p-5" data-testid="evidence-provenance-panel" data-state="restricted">
        <h3 className="text-base font-semibold text-bh-text flex items-center gap-2 mb-2">
          <ShieldOff className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Automated processing restricted
        </h3>
        <p className="text-sm text-bh-text-dim">
          Since {new Date(state.since).toLocaleDateString()}, no organization can run automated enrichment against your
          public profile. Existing enrichment evidence has been purged.
        </p>
        <PrivacyLinks />
      </div>
    )
  }

  const { provenance } = state

  return (
    <div className="card p-5" data-testid="evidence-provenance-panel" data-state="ready">
      <h3 className="text-base font-semibold text-bh-text flex items-center gap-2 mb-3">
        <ShieldAlert className="w-4 h-4 text-bh-accent" aria-hidden="true" />
        Evidence about you
      </h3>

      {provenance.length === 0 ? (
        <p className="text-sm text-bh-text-dim" data-testid="evidence-provenance-empty">
          No enrichment evidence has been collected about your public profile yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {provenance.map((entry, index) => (
            <li
              key={`${entry.source}-${index}`}
              className="border border-bh-border rounded-lg p-3"
              data-testid="evidence-provenance-item"
              data-retention-state={entry.retentionState}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-bh-text-dim">{entry.source}</span>
                <span className="text-xs text-bh-text-dim">
                  {entry.retentionState === 'active' ? 'Retained' : 'Retention expired'}
                </span>
              </div>
              {entry.fieldCategories.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {entry.fieldCategories.map((field) => (
                    <span key={field} className="badge">{field}</span>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-bh-text-dim mt-1">
                Observed {new Date(entry.observedAt).toLocaleDateString()} · retention until{' '}
                {new Date(entry.expiresAt).toLocaleDateString()}
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 pt-4 border-t border-bh-border">
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-xs px-2 py-1 rounded bg-bh-border text-bh-text-dim hover:text-bh-text"
            data-testid="restrict-processing-open"
          >
            Restrict automated processing
          </button>
        ) : (
          <div className="space-y-2" data-testid="restrict-processing-confirm">
            <p className="text-sm text-bh-text">
              This cancels every queued or running enrichment job for your profile and purges existing enrichment
              evidence across every organization. This does not delete your account or claimed profile — you can find
              full removal guidance in <a href="/settings/privacy" className="text-bh-accent hover:underline">Privacy settings</a>.
            </p>
            {restrictError && <p className="text-sm text-bh-danger" role="alert">{restrictError}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={confirmRestrict}
                disabled={submitting}
                className="text-xs px-2 py-1 rounded bg-bh-danger/10 text-bh-danger disabled:opacity-50"
                data-testid="restrict-processing-confirm-button"
              >
                {submitting ? 'Restricting…' : 'Confirm restriction'}
              </button>
              <button
                type="button"
                onClick={() => { setConfirming(false); setRestrictError(null) }}
                disabled={submitting}
                className="text-xs px-2 py-1 rounded bg-bh-border text-bh-text-dim"
                data-testid="restrict-processing-cancel"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <PrivacyLinks />
    </div>
  )
}

function PrivacyLinks() {
  return (
    <p className="text-[11px] text-bh-text-dim mt-3 flex items-center gap-1">
      <a href="/legal/privacy" className="text-bh-accent hover:underline inline-flex items-center gap-1">
        Privacy policy <ExternalLink className="w-3 h-3" aria-hidden="true" />
      </a>
      <span aria-hidden="true">·</span>
      <a href="/settings/privacy" className="text-bh-accent hover:underline">Profile removal guidance</a>
    </p>
  )
}
