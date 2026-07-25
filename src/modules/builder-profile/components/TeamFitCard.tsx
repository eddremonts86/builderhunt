/**
 * Team Fit Card (plan: team-synergy). Compares this candidate against the
 * viewer's own tracked-builder team via POST /api/builders/:id/synergy.
 * Collapsed by default; every outcome renders something concrete (AI
 * result, baseline "rule-based estimate", too-small hint, or an upgrade
 * prompt) — never a dead button.
 */
import * as React from 'react'
import { ChevronDown, ChevronUp, Users2, Loader2, Sparkles, Lock } from 'lucide-react'
import { Button } from '~/components/ui'

interface SynergyAnalysis {
  synergyScore: number
  summary: string
  complementaryStrengths: string[]
  overlaps: string[]
  frictionPoints: string[]
  confidence: 'low' | 'medium' | 'high'
}

interface SynergyBaseline {
  score: number
  notes: string[]
}

type SynergyResult =
  | { kind: 'ai'; analysis: SynergyAnalysis; teamSize: number }
  | { kind: 'baseline'; baseline: SynergyBaseline; teamSize: number }
  | { kind: 'teamTooSmall' }
  | { kind: 'plan' }
  | { kind: 'error' }

const CONFIDENCE_LABEL: Record<SynergyAnalysis['confidence'], string> = {
  low: 'Low confidence',
  medium: 'Medium confidence',
  high: 'High confidence',
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 70 ? 'text-bh-success' : score >= 40 ? 'text-bh-warning' : 'text-bh-danger'
  return (
    <span className={`text-2xl font-bold ${color}`} data-testid="team-fit-score">
      {score}
    </span>
  )
}

export function TeamFitCard({ builderId, trackedBuildersCount }: { builderId: string; trackedBuildersCount: number }) {
  const [open, setOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [result, setResult] = React.useState<SynergyResult | null>(null)

  if (trackedBuildersCount < 2) return null

  const runAnalysis = async () => {
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch(`/api/builders/${builderId}/synergy`, {
        method: 'POST',
        credentials: 'include',
      })
      if (res.status === 429) {
        setResult({ kind: 'plan' })
        return
      }
      const data = await res.json()
      if (data.teamTooSmall) {
        setResult({ kind: 'teamTooSmall' })
      } else if (data.analysis) {
        setResult({ kind: 'ai', analysis: data.analysis, teamSize: data.teamSize })
      } else if (data.baseline) {
        setResult({ kind: 'baseline', baseline: data.baseline, teamSize: data.teamSize })
      } else {
        setResult({ kind: 'error' })
      }
    } catch {
      setResult({ kind: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const handleToggle = () => {
    const opening = !open
    setOpen(opening)
    if (opening && !result && !loading) void runAnalysis()
  }

  return (
    <div className="card p-5" data-testid="team-fit-card">
      <button
        type="button"
        onClick={handleToggle}
        className="flex items-center justify-between w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 rounded-lg"
        data-testid="team-fit-toggle"
      >
        <span className="flex items-center gap-2 text-base font-semibold text-bh-text">
          <Users2 className="w-4 h-4" aria-hidden="true" />
          Analyze team fit against your {trackedBuildersCount} tracked builders
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-bh-text-dim" /> : <ChevronDown className="w-4 h-4 text-bh-text-dim" />}
      </button>

      {open && (
        <div className="mt-4" data-testid="team-fit-mode" data-mode={result?.kind ?? (loading ? 'loading' : 'idle')}>
          {loading && (
            <div className="flex items-center gap-2 text-sm text-bh-text-muted">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              Analyzing team fit…
            </div>
          )}

          {!loading && result?.kind === 'teamTooSmall' && (
            <p className="text-xs text-bh-text-dim">Track at least 2 builders to analyze team fit.</p>
          )}

          {!loading && result?.kind === 'plan' && (
            <div className="rounded-lg border border-bh-accent/30 bg-bh-accent-soft p-4 space-y-2" data-testid="team-fit-upgrade">
              <p className="flex items-center gap-2 text-sm font-semibold text-bh-text">
                <Lock className="w-4 h-4 text-bh-accent" aria-hidden="true" />
                Team fit analysis is a Team-plan feature
              </p>
              <p className="text-xs text-bh-text-muted">
                Upgrade to Team to see how candidates complement the people you've already tracked.
              </p>
            </div>
          )}

          {!loading && result?.kind === 'error' && (
            <p className="text-xs text-bh-text-dim">Couldn't analyze team fit right now — try again shortly.</p>
          )}

          {!loading && result?.kind === 'baseline' && (
            <div className="rounded-lg border border-bh-border bg-bh-bg-alt/40 p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <ScoreBadge score={result.baseline.score} />
                <span
                  className="badge inline-flex items-center gap-1 border-bh-border bg-bh-surface-2 text-bh-text-dim text-[11px] font-semibold"
                  data-testid="team-fit-degraded-badge"
                >
                  rule-based estimate
                </span>
              </div>
              {result.baseline.notes.length > 0 && (
                <ul className="text-sm text-bh-text space-y-1 list-disc list-inside">
                  {result.baseline.notes.map((note, i) => <li key={i}>{note}</li>)}
                </ul>
              )}
              <p className="text-[11px] text-bh-text-dim">vs your {result.teamSize} tracked builders</p>
            </div>
          )}

          {!loading && result?.kind === 'ai' && (
            <div className="rounded-lg border border-bh-border bg-bh-bg-alt/40 p-4 space-y-3" data-testid="team-fit-result">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <ScoreBadge score={result.analysis.synergyScore} />
                  <span className="text-xs text-bh-text-dim">/ 100</span>
                </div>
                <span
                  className="badge inline-flex items-center gap-1 border-bh-accent/30 bg-bh-accent-soft text-bh-accent text-[11px] font-semibold"
                  data-testid="team-fit-confidence"
                >
                  {CONFIDENCE_LABEL[result.analysis.confidence]}
                </span>
              </div>

              <p className="text-sm text-bh-text">{result.analysis.summary}</p>

              {result.analysis.complementaryStrengths.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-bh-success mb-1">What they add</p>
                  <ul className="text-sm text-bh-text space-y-1 list-disc list-inside">
                    {result.analysis.complementaryStrengths.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                </div>
              )}

              {result.analysis.overlaps.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim mb-1">Where they overlap</p>
                  <ul className="text-sm text-bh-text-muted space-y-1 list-disc list-inside">
                    {result.analysis.overlaps.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                </div>
              )}

              {result.analysis.frictionPoints.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-bh-warning mb-1">Possible friction</p>
                  <ul className="text-sm text-bh-text-muted space-y-1 list-disc list-inside">
                    {result.analysis.frictionPoints.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                </div>
              )}

              <p className="flex items-center gap-1 text-[11px] text-bh-text-dim pt-1">
                <Sparkles className="w-3 h-3" aria-hidden="true" />
                vs your {result.teamSize} tracked builders · AI
              </p>
            </div>
          )}

          {!loading && !result && (
            <Button type="button" variant="secondary" onClick={runAnalysis} data-testid="team-fit-retry">
              Analyze team fit
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
