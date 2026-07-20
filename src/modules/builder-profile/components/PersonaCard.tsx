/**
 * AI Persona Card (plan: ai-profile-enrichment). Fetches
 * GET /api/builders/:id/enrichment on mount and renders one of: loading
 * skeleton, full persona card, "not enough data" placeholder, or a stale
 * card + budget/error note. Server-only artifact — no Chrome AI path, no
 * rule-based v1 (degradation rung 4: hidden entirely when the AI platform
 * is disabled or has no server key configured).
 */
import * as React from 'react'
import { Sparkles, RefreshCw } from 'lucide-react'
import { useAICapabilities } from '~/shared/lib/ai/useAICapabilities'
import type { BuilderAIEnrichment } from '~/shared/lib/ai/enrichment'

interface PersonaCardProps {
  builderId: string
  /** Whether the current viewer may trigger a manual refresh. */
  canRefresh?: boolean
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'insufficient' }
  | { kind: 'ready'; enrichment: BuilderAIEnrichment }
  | { kind: 'error'; message: string; stale?: BuilderAIEnrichment }
  | { kind: 'hidden' }

const SENIORITY_LABEL: Record<BuilderAIEnrichment['estimatedSeniority'], string> = {
  junior: 'Junior',
  mid: 'Mid-level',
  senior: 'Senior',
  lead: 'Lead',
}

function relativeDate(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000))
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return new Date(iso).toLocaleDateString()
}

export function PersonaCard({ builderId, canRefresh = false }: PersonaCardProps) {
  const { disabled, serverAI } = useAICapabilities()
  const [state, setState] = React.useState<FetchState>({ kind: 'loading' })
  const [refreshing, setRefreshing] = React.useState(false)

  const load = React.useCallback(async (opts: { refresh?: boolean } = {}) => {
    if (opts.refresh) setRefreshing(true)
    else setState({ kind: 'loading' })
    try {
      const res = await fetch(`/api/builders/${builderId}/enrichment`, {
        method: opts.refresh ? 'POST' : 'GET',
        credentials: 'include',
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok) {
        if (body.insufficient) setState({ kind: 'insufficient' })
        else if (body.enrichment) setState({ kind: 'ready', enrichment: body.enrichment })
        else setState({ kind: 'error', message: 'Unexpected response' })
        return
      }
      setState((prev) => ({
        kind: 'error',
        message: body.error === 'budget' || body.error === 'plan'
          ? 'Daily AI limit reached — showing the last generated card'
          : body.error === 'rate_limited'
            ? 'Refresh limit reached — try again later'
            : 'Could not generate a persona card right now',
        stale: prev.kind === 'ready' ? prev.enrichment : prev.kind === 'error' ? prev.stale : undefined,
      }))
    } catch {
      setState((prev) => ({
        kind: 'error',
        message: 'Network error while generating the persona card',
        stale: prev.kind === 'ready' ? prev.enrichment : prev.kind === 'error' ? prev.stale : undefined,
      }))
    } finally {
      if (opts.refresh) setRefreshing(false)
    }
  }, [builderId])

  React.useEffect(() => {
    if (disabled || !serverAI) {
      setState({ kind: 'hidden' })
      return
    }
    load()
    // Only re-fetch when the builder or platform availability changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builderId, disabled, serverAI])

  if (state.kind === 'hidden') return null

  return (
    <div className="card p-5" data-testid="persona-card">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-base font-semibold text-bh-text flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          AI Persona
        </h3>
        {canRefresh && (state.kind === 'ready' || state.kind === 'error') && (
          <button
            type="button"
            onClick={() => load({ refresh: true })}
            disabled={refreshing}
            className="btn-ghost btn-sm text-xs py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338]"
            data-testid="persona-refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
            Refresh
          </button>
        )}
      </div>

      {state.kind === 'loading' && (
        <div className="space-y-2 animate-pulse" data-testid="persona-loading">
          <div className="h-4 bg-bh-bg-alt rounded w-3/4" />
          <div className="h-4 bg-bh-bg-alt rounded w-1/2" />
          <div className="h-4 bg-bh-bg-alt rounded w-2/3" />
        </div>
      )}

      {state.kind === 'insufficient' && (
        <p className="text-sm text-bh-text-dim" data-testid="persona-insufficient">
          Not enough public activity for an AI summary.
        </p>
      )}

      {state.kind === 'error' && !state.stale && (
        <p className="text-sm text-bh-text-dim" data-testid="persona-error">
          {state.message}
        </p>
      )}

      {(state.kind === 'ready' || (state.kind === 'error' && state.stale)) && (() => {
        const enrichment = state.kind === 'ready' ? state.enrichment : state.stale!
        return (
          <div className="space-y-3" data-testid="persona-content">
            {state.kind === 'error' && (
              <p className="text-[11px] text-bh-text-dim" data-testid="persona-note">
                {state.message}
              </p>
            )}
            <p className="text-sm text-bh-text">{enrichment.summary}</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="badge inline-flex items-center gap-1 border-bh-accent/30 bg-bh-accent-soft text-bh-accent text-[11px] font-semibold">
                {SENIORITY_LABEL[enrichment.estimatedSeniority]}
              </span>
              <span className="text-xs text-bh-text-muted">{enrichment.primaryFocus}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {enrichment.strengths.map((strength) => (
                <span key={strength} className="badge text-[11px]">{strength}</span>
              ))}
            </div>
            <p className="text-xs text-bh-text-dim">{enrichment.codingStyle}</p>
            <p className="text-[10px] text-bh-text-dim uppercase tracking-wider pt-1">
              AI-generated · {relativeDate(enrichment.enrichedAt)}
            </p>
          </div>
        )
      })()}
    </div>
  )
}
