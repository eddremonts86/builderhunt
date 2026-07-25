import * as React from 'react'
import { Braces, FlaskConical, FileText, GitBranch, TextCursorInput, Loader2, Lock, Sparkles } from 'lucide-react'
import {
  codeStyleFingerprintV2Schema,
  generateFingerprint,
  type CodeStyleFingerprint,
  type CodeStyleFingerprintV2,
} from '~/shared/lib/code-style'
import { useAICapabilities } from '~/shared/lib/ai/useAICapabilities'
import { Button } from '~/components/ui/button'

interface CodeStyleCardProps {
  builder: {
    id?: string
    source?: string
    language?: string | null
    topics?: string[]
    followersCount?: number
    metadata?: Record<string, unknown>
    /** Raw stored envelope from the tracked-builder API branch; validated here. */
    codeStyleFingerprint?: unknown
  }
}

const PARADIGM_LABEL: Record<CodeStyleFingerprint['paradigm'], string> = {
  functional: 'Functional',
  oop: 'Object-oriented',
  pragmatic: 'Pragmatic',
}

type AnalyzeState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'plan' }
  | { kind: 'budget' }
  | { kind: 'insufficient' }
  | { kind: 'error'; message: string }

function MetricBar({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Braces
  label: string
  value: number
}) {
  return (
    <div data-testid="code-style-metric">
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="flex items-center gap-1.5 text-bh-text-dim uppercase tracking-wider text-[10px]">
          <Icon className="w-3 h-3" aria-hidden="true" />
          {label}
        </span>
        <span className="font-semibold text-bh-text">{value}</span>
      </div>
      <div className="h-1.5 rounded-full bg-bh-bg-alt overflow-hidden">
        <div
          className="h-full rounded-full bg-bh-accent"
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </div>
    </div>
  )
}

function formatAnalyzedAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'recently'
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return date.toLocaleDateString()
}

export function CodeStyleCard({ builder }: CodeStyleCardProps) {
  const { serverAI, disabled } = useAICapabilities()
  const [analyzed, setAnalyzed] = React.useState<CodeStyleFingerprintV2 | null>(null)
  const [state, setState] = React.useState<AnalyzeState>({ kind: 'idle' })

  // A freshly generated fingerprint wins over the one that arrived with the
  // page, so the card updates in place after "Analyze real code".
  const storedV2 = React.useMemo(() => {
    if (analyzed) return analyzed
    const parsed = codeStyleFingerprintV2Schema.safeParse(builder.codeStyleFingerprint)
    return parsed.success ? parsed.data : null
  }, [analyzed, builder.codeStyleFingerprint])

  const heuristic = React.useMemo(() => generateFingerprint(builder), [builder])
  const shown = storedV2 ?? heuristic
  const isGitHub = builder.source === 'github'
  const canAnalyze = isGitHub && Boolean(builder.id) && serverAI && !disabled

  const analyze = async () => {
    setState({ kind: 'loading' })
    try {
      const res = await fetch(`/api/builders/${builder.id}/fingerprint`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // Always force: the button exists precisely to re-analyze, and the
        // endpoint's own freshness check already short-circuits a normal load.
        body: JSON.stringify({ force: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 429) {
        setState({ kind: data.error === 'plan' ? 'plan' : 'budget' })
        return
      }
      if (data.insufficient) {
        setState({ kind: 'insufficient' })
        return
      }
      if (!res.ok || !data.fingerprint) {
        setState({ kind: 'error', message: 'Could not analyze this builder\'s code right now.' })
        return
      }
      const parsed = codeStyleFingerprintV2Schema.safeParse(data.fingerprint)
      if (!parsed.success) {
        setState({ kind: 'error', message: 'Received an unexpected fingerprint format.' })
        return
      }
      setAnalyzed(parsed.data)
      setState({ kind: 'idle' })
    } catch {
      setState({ kind: 'error', message: 'Could not analyze this builder\'s code right now.' })
    }
  }

  return (
    <div className="card p-5" data-testid="code-style-card" data-fingerprint-version={storedV2 ? 2 : 1}>
      <div className="flex items-center justify-between mb-1 gap-2">
        <h3 className="text-base font-semibold text-bh-text">Code-style profile</h3>
        <span className="badge badge-neutral" data-testid="code-style-paradigm">
          {PARADIGM_LABEL[shown.paradigm]}
        </span>
      </div>

      {storedV2 ? (
        <p className="text-xs text-bh-text-dim mb-4 flex items-center gap-1.5" data-testid="code-style-caption-v2">
          <Sparkles className="w-3 h-3 text-bh-accent shrink-0" aria-hidden="true" />
          AI-analyzed from {storedV2.analyzedFiles} file{storedV2.analyzedFiles === 1 ? '' : 's'} across{' '}
          {storedV2.analyzedRepos.length} repo{storedV2.analyzedRepos.length === 1 ? '' : 's'} ·{' '}
          {formatAnalyzedAt(storedV2.analyzedAt)}
        </p>
      ) : (
        <p className="text-xs text-bh-text-dim mb-4">
          Estimated from language and topic signals. v1 uses heuristics; real profiling would
          analyze actual source files.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <MetricBar icon={Braces} label="Modularity" value={shown.modularityScore} />
        <MetricBar icon={FlaskConical} label="Test intensity" value={shown.testIntensity} />
        <MetricBar icon={FileText} label="Documentation" value={shown.documentationRatio} />
        <MetricBar icon={GitBranch} label="Complexity control" value={shown.complexityControl} />
        <MetricBar icon={TextCursorInput} label="Naming consistency" value={shown.namingConsistency} />
      </div>

      {storedV2 && storedV2.evidence.length > 0 && (
        <div className="mt-4 pt-3 border-t border-bh-border/60" data-testid="code-style-evidence">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-bh-text-dim mb-1.5">
            Evidence
          </p>
          <ul className="text-xs text-bh-text-muted space-y-1 list-disc list-inside">
            {storedV2.evidence.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </div>
      )}

      {/* The action only appears where it can actually do something: a GitHub
          builder, with server AI available. Everywhere else the v1 estimate
          stands on its own rather than offering a button that 503s. */}
      {canAnalyze && (
        <div className="mt-4 pt-3 border-t border-bh-border/60 space-y-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={analyze}
            disabled={state.kind === 'loading'}
            data-testid="code-style-analyze"
          >
            {state.kind === 'loading'
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />Analyzing real code…</>
              : storedV2 ? 'Re-analyze real code' : 'Analyze real code'}
          </Button>

          {state.kind === 'plan' && (
            <p className="text-xs text-bh-text-muted flex items-center gap-1.5" data-testid="code-style-upgrade">
              <Lock className="w-3 h-3 text-bh-accent shrink-0" aria-hidden="true" />
              Real-code analysis is a Pro feature — upgrade to profile actual source files.
            </p>
          )}
          {state.kind === 'budget' && (
            <p className="text-xs text-bh-text-muted">
              You've used today's code analyses. This resets tomorrow.
            </p>
          )}
          {state.kind === 'insufficient' && (
            <p className="text-xs text-bh-text-muted" data-testid="code-style-insufficient">
              No analyzable source found in this builder's public repos — the estimate above stands.
            </p>
          )}
          {state.kind === 'error' && (
            <p className="text-xs text-bh-danger">{state.message}</p>
          )}
        </div>
      )}
    </div>
  )
}
