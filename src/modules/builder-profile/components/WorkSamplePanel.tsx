/**
 * Work-Sample Panel (plan: work-sample). Recruiter pastes a public GitHub
 * URL (repo/PR/file); POST /api/work-samples/analyze returns a structured
 * AI review, persisted as the recruiter's own artifact (never shown on the
 * builder's profile). Collapsed by default, mirrors TeamFitCard's
 * disclosure pattern. Hidden entirely when server AI is unavailable — there
 * is no rule-based fallback for this feature (ai-policy rung 4).
 */
import * as React from 'react'
import { ChevronDown, ChevronUp, FileCode2, Loader2, Lock, RefreshCw, Trash2, Copy, Check, AlertTriangle } from 'lucide-react'
import { Button, Input } from '~/components/ui'
import { PaidStateActions } from '~/shared/components/PaidStateActions'
import { useAICapabilities } from '~/shared/lib/ai/useAICapabilities'

interface LevelSignal {
  signal: string
  evidence: string
  direction: 'senior' | 'junior' | 'neutral'
}

interface WorkSampleAnalysis {
  whatItDemonstrates: string
  technologies: string[]
  levelSignals: LevelSignal[]
  strengths: string[]
  concerns: string[]
  redFlags: string[]
  suggestedInterviewQuestions: string[]
  confidence: 'low' | 'medium' | 'high'
  analyzedAt: string
  contentHash: string
}

interface WorkSampleRow {
  id: string
  sampleUrl: string
  sampleType: string
  analysis: WorkSampleAnalysis
  createdAt: string
  updatedAt: string
}

type AnalyzeState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'result'; analysis: WorkSampleAnalysis }
  | { kind: 'plan' }
  | { kind: 'stale_session' }
  | { kind: 'unsupported_url' }
  | { kind: 'not_found' }
  | { kind: 'rate_limited' }
  | { kind: 'error' }

const CONFIDENCE_LABEL: Record<WorkSampleAnalysis['confidence'], string> = {
  low: 'Low confidence',
  medium: 'Medium confidence',
  high: 'High confidence',
}

const DIRECTION_STYLE: Record<LevelSignal['direction'], string> = {
  senior: 'text-bh-success',
  junior: 'text-bh-warning',
  neutral: 'text-bh-text-dim',
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      className="shrink-0 text-bh-text-dim hover:text-bh-accent"
      aria-label="Copy question"
      title="Copy question"
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  )
}

function AnalysisResult({ analysis }: { analysis: WorkSampleAnalysis }) {
  return (
    <div className="rounded-lg border border-bh-border bg-bh-bg-alt/40 p-4 space-y-3" data-testid="work-sample-result">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-bh-text">{analysis.whatItDemonstrates}</p>
        <span
          className="badge shrink-0 inline-flex items-center gap-1 border-bh-accent/30 bg-bh-accent-soft text-bh-accent text-[11px] font-semibold"
          data-testid="work-sample-confidence"
        >
          {CONFIDENCE_LABEL[analysis.confidence]}
        </span>
      </div>

      {analysis.technologies.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {analysis.technologies.map((tech) => (
            <span key={tech} className="badge-neutral text-[0.6875rem] px-2 py-0.5">{tech}</span>
          ))}
        </div>
      )}

      {analysis.levelSignals.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim mb-1">Level signals</p>
          <ul className="text-sm text-bh-text space-y-1.5">
            {analysis.levelSignals.map((s, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className={`mt-0.5 text-[10px] font-bold uppercase shrink-0 ${DIRECTION_STYLE[s.direction]}`}>
                  {s.direction}
                </span>
                <span>{s.signal} <span className="text-bh-text-dim">— {s.evidence}</span></span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {analysis.strengths.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-bh-success mb-1">Strengths</p>
          <ul className="text-sm text-bh-text space-y-1 list-disc list-inside">
            {analysis.strengths.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}

      {analysis.concerns.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-bh-warning mb-1">Concerns</p>
          <ul className="text-sm text-bh-text-muted space-y-1 list-disc list-inside">
            {analysis.concerns.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}

      {analysis.redFlags.length > 0 && (
        <div className="rounded-md border border-bh-danger/30 bg-bh-danger/5 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-bh-danger mb-1">
            <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
            Red flags
          </p>
          <ul className="text-sm text-bh-text space-y-1 list-disc list-inside">
            {analysis.redFlags.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}

      {analysis.suggestedInterviewQuestions.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim mb-1">Interview questions</p>
          <ul className="text-sm text-bh-text space-y-1.5">
            {analysis.suggestedInterviewQuestions.map((q, i) => (
              <li key={i} className="flex items-start justify-between gap-2">
                <span>{q}</span>
                <CopyButton text={q} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[11px] text-bh-text-dim pt-1 border-t border-bh-border/60">
        AI-generated review of public code, not a hire decision — verify before acting on it.
      </p>
    </div>
  )
}

export function WorkSamplePanel({ builderId }: { builderId: string }) {
  const { serverAI, disabled } = useAICapabilities()
  const [open, setOpen] = React.useState(false)
  const [url, setUrl] = React.useState('')
  const [state, setState] = React.useState<AnalyzeState>({ kind: 'idle' })
  const [previous, setPrevious] = React.useState<WorkSampleRow[]>([])
  const [previousLoaded, setPreviousLoaded] = React.useState(false)

  const loadPrevious = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/work-samples?builderId=${encodeURIComponent(builderId)}`, { credentials: 'include' })
      setPrevious(res.ok ? await res.json() : [])
    } catch {
      setPrevious([])
    } finally {
      setPreviousLoaded(true)
    }
  }, [builderId])

  const handleToggle = () => {
    const opening = !open
    setOpen(opening)
    if (opening && !previousLoaded) void loadPrevious()
  }

  const analyze = async (force = false) => {
    if (!url.trim()) return
    setState({ kind: 'loading' })
    try {
      const res = await fetch('/api/work-samples/analyze', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), builderId, force }),
      })
      if (res.status === 401) {
        setState({ kind: 'stale_session' })
        return
      }
      const data = await res.json().catch(() => ({}))
      if (res.status === 429 && data.error === 'plan') {
        setState({ kind: 'plan' })
        return
      }
      if (res.status === 429) {
        setState({ kind: 'rate_limited' })
        return
      }
      if (res.status === 400) {
        setState({ kind: 'unsupported_url' })
        return
      }
      if (res.status === 404) {
        setState({ kind: 'not_found' })
        return
      }
      if (!res.ok || !data.analysis) {
        setState({ kind: 'error' })
        return
      }
      setState({ kind: 'result', analysis: data.analysis })
      void loadPrevious()
    } catch {
      setState({ kind: 'error' })
    }
  }

  const deleteAnalysis = async (id: string) => {
    await fetch(`/api/work-samples/${id}`, { method: 'DELETE', credentials: 'include' })
    void loadPrevious()
  }

  if (disabled || !serverAI) return null

  return (
    <div className="card p-5" data-testid="work-sample-panel">
      <button
        type="button"
        onClick={handleToggle}
        className="flex items-center justify-between w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 rounded-lg"
        data-testid="work-sample-toggle"
      >
        <span className="flex items-center gap-2 text-base font-semibold text-bh-text">
          <FileCode2 className="w-4 h-4" aria-hidden="true" />
          Analyze a work sample
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-bh-text-dim" /> : <ChevronDown className="w-4 h-4 text-bh-text-dim" />}
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          <div className="flex items-center gap-2">
            <Input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo, /pull/142, or /blob/main/file.ts"
              data-testid="work-sample-url-input"
            />
            <Button
              type="button"
              variant="primary"
              onClick={() => void analyze(false)}
              disabled={state.kind === 'loading' || !url.trim()}
              data-testid="work-sample-analyze-button"
            >
              {state.kind === 'loading' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Analyze'}
            </Button>
          </div>

          {state.kind === 'loading' && (
            <p className="text-xs text-bh-text-muted flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              Fetching and reviewing the sample — this can take up to 30s…
            </p>
          )}

          {state.kind === 'plan' && (
            <div className="rounded-lg border border-bh-accent/30 bg-bh-accent-soft p-4 space-y-3" data-testid="work-sample-upgrade">
              <p className="flex items-center gap-2 text-sm font-semibold text-bh-text">
                <Lock className="w-4 h-4 text-bh-accent" aria-hidden="true" />
                Work-sample analysis is a Team-plan feature
              </p>
              <p className="text-xs text-bh-text-muted">
                Upgrade to Team to get AI-reviewed work samples with level signals and interview questions.
              </p>
              <PaidStateActions reason="not_entitled" className="justify-start" />
            </div>
          )}

          {state.kind === 'stale_session' && (
            <div className="rounded-lg border border-bh-border/60 bg-bh-surface p-4 space-y-3" data-testid="work-sample-stale-session">
              <p className="flex items-center gap-2 text-sm font-semibold text-bh-text">
                <Lock className="w-4 h-4 text-bh-accent" aria-hidden="true" />
                Sign in again to continue
              </p>
              <p className="text-xs text-bh-text-muted">Your session needs refreshing before we can analyze this sample.</p>
              <PaidStateActions reason="stale_session" className="justify-start" />
            </div>
          )}

          {state.kind === 'unsupported_url' && (
            <p className="text-xs text-bh-danger">
              That doesn't look like a GitHub repo, pull request, or file URL. Try a link like
              github.com/owner/repo, .../pull/142, or .../blob/main/path/to/file.
            </p>
          )}

          {state.kind === 'not_found' && (
            <p className="text-xs text-bh-danger">Sample not found — it may be private, deleted, or the URL is wrong.</p>
          )}

          {state.kind === 'rate_limited' && (
            <p className="text-xs text-bh-danger">Too many analyses this hour — try again shortly.</p>
          )}

          {state.kind === 'error' && (
            <p className="text-xs text-bh-danger">Couldn't analyze that sample right now — try again shortly.</p>
          )}

          {state.kind === 'result' && <AnalysisResult analysis={state.analysis} />}

          {previous.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim mb-2">
                Your previous analyses
              </p>
              <div className="space-y-1.5">
                {previous.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center gap-2 rounded-lg border border-bh-border bg-bh-bg-alt/30 p-2.5"
                    data-testid={`work-sample-previous-${row.id}`}
                  >
                    <span className="text-xs text-bh-text truncate flex-1" title={row.sampleUrl}>
                      {row.sampleUrl}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => { setUrl(row.sampleUrl); void analyze(true) }}
                      aria-label="Re-analyze"
                      title="Re-analyze"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void deleteAnalysis(row.id)}
                      className="hover:text-bh-danger hover:bg-bh-danger/10"
                      aria-label="Delete analysis"
                      title="Delete analysis"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
