import * as React from 'react'
import { Lightbulb, Lock, Sparkles } from 'lucide-react'
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '~/components/ui'
import { BRIEF_DOMAINS, RANKING_MODES, type BriefDomain, type RankingMode, type SolutionRun } from '~/shared/lib/solutions/contracts'
import { DEMO_SOLUTION_RUN } from '~/shared/lib/solutions/demo-fixtures'

const DOMAIN_LABELS: Record<BriefDomain, string> = {
  software_and_ai: 'Software & AI',
  translation_and_transcription: 'Translation & transcription',
  research_and_data: 'Research & data',
  content_and_design: 'Content & design',
  automation: 'Automation',
  other: 'Other',
}

const RANKING_LABELS: Record<RankingMode, string> = {
  recommended: 'Recommended',
  maximum_quality: 'Maximum quality',
  lower_cost_time: 'Lower cost / time',
}

const ROUTE_TYPE_LABELS: Record<SolutionRun['routes'][number]['routeType'], string> = {
  human: 'Human',
  ai: 'AI',
  hybrid: 'Hybrid',
}

interface DraftBrief {
  description: string
  domain: BriefDomain
  capabilities: string
  budgetKnown: boolean
  budgetMaxDollars: string
  rankingMode: RankingMode
}

function initialDraft(): DraftBrief {
  return { description: '', domain: 'software_and_ai', capabilities: '', budgetKnown: false, budgetMaxDollars: '', rankingMode: 'recommended' }
}

type Step = 'brief' | 'interpretation' | 'confirm' | 'result'

export interface SolutionsPageProps {
  /** Injected for tests — defaults to a real fetch against `/api/billing/summary`. */
  fetchEntitlement?: () => Promise<{ paidActionsAllowed: boolean }>
}

export function SolutionsPage({ fetchEntitlement }: SolutionsPageProps = {}) {
  const [entitlement, setEntitlement] = React.useState<'loading' | 'locked' | 'unlocked'>('loading')
  const [draft, setDraft] = React.useState<DraftBrief>(initialDraft)
  const [step, setStep] = React.useState<Step>('brief')
  const [clarifyingAnswer, setClarifyingAnswer] = React.useState('')

  React.useEffect(() => {
    const load = fetchEntitlement
      ?? (() => fetch('/api/billing/summary', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : { capabilities: { paidActionsAllowed: false } }))
        .then((data: { capabilities?: { paidActionsAllowed?: boolean } }) => ({ paidActionsAllowed: Boolean(data.capabilities?.paidActionsAllowed) })))
    load()
      .then((result) => setEntitlement(result.paidActionsAllowed ? 'unlocked' : 'locked'))
      .catch(() => setEntitlement('locked'))
  }, [fetchEntitlement])

  // Deterministic materiality rule for the shell demo: an unknown budget is the one clarifying
  // question that would materially change viable routes (spec.md: "at most one clarifying
  // question when ambiguity would materially change the viable routes"). Phase 7's real
  // interpreter replaces this with an LLM-driven decision under the same one-question ceiling.
  const needsClarification = !draft.budgetKnown

  function handlePreviewInterpretation(e: React.FormEvent) {
    e.preventDefault()
    if (!draft.description.trim() || !draft.capabilities.trim()) return
    setStep('interpretation')
  }

  function handleConfirmInterpretation() {
    setStep('confirm')
  }

  function handleConfirmCharge() {
    setStep('result')
  }

  function handleReset() {
    setDraft(initialDraft())
    setClarifyingAnswer('')
    setStep('brief')
  }

  if (entitlement === 'loading') {
    return <div className="container py-12" data-testid="solutions-loading" aria-live="polite">Loading…</div>
  }

  if (entitlement === 'locked') {
    return (
      <div className="container py-12 max-w-3xl" data-testid="solutions-locked">
        <div className="card p-8 border border-bh-border/60 bg-bh-surface rounded-2xl text-center">
          <Lock className="w-8 h-8 text-bh-accent mx-auto mb-4" aria-hidden="true" />
          <h1 className="text-2xl font-bold mb-2">Solutions is a Pro, Pro Max, and Team feature</h1>
          <p className="text-bh-text-muted mb-6 max-w-lg mx-auto">
            Describe a piece of digital work and get up to three evidence-backed ways to solve it —
            a human specialist, an AI system, or a hybrid workflow — compared side by side.
          </p>
          <a href="/pricing" className="btn-primary inline-flex" data-testid="solutions-upgrade-cta">Upgrade to unlock</a>
          <div className="mt-8 text-left">
            <p className="text-xs uppercase tracking-wider text-bh-text-dim mb-3">Example output</p>
            <DemoResultLanes run={DEMO_SOLUTION_RUN} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="container py-12 max-w-3xl" data-testid="solutions-page">
      <header className="mb-8">
        <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
          <Lightbulb className="w-6 h-6 text-bh-accent" aria-hidden="true" />
          Solutions
        </h1>
        <p className="text-bh-text-muted mt-1">Describe the outcome you need. Nothing is saved until you explicitly save a result.</p>
      </header>

      {step === 'brief' && (
        <form onSubmit={handlePreviewInterpretation} className="card p-6 space-y-5 border border-bh-border/60 rounded-2xl" data-testid="brief-form">
          <div>
            <Label htmlFor="brief-description">What do you need done?</Label>
            <Textarea
              id="brief-description"
              required
              rows={4}
              placeholder="e.g. Translate a 20-page technical manual from English to Spanish"
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              data-testid="brief-description-input"
            />
          </div>
          <div>
            <Label htmlFor="brief-domain">Domain</Label>
            <Select value={draft.domain} onValueChange={(value) => setDraft((d) => ({ ...d, domain: value as BriefDomain }))}>
              <SelectTrigger id="brief-domain" data-testid="brief-domain-select"><SelectValue /></SelectTrigger>
              <SelectContent>
                {BRIEF_DOMAINS.map((domain) => (
                  <SelectItem key={domain} value={domain}>{DOMAIN_LABELS[domain]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="brief-capabilities">Capabilities needed (comma-separated)</Label>
            <Input
              id="brief-capabilities"
              required
              placeholder="translation, quality_assurance"
              value={draft.capabilities}
              onChange={(e) => setDraft((d) => ({ ...d, capabilities: e.target.value }))}
              data-testid="brief-capabilities-input"
            />
          </div>
          <div>
            <Label htmlFor="brief-ranking">Ranking preference</Label>
            <Select value={draft.rankingMode} onValueChange={(value) => setDraft((d) => ({ ...d, rankingMode: value as RankingMode }))}>
              <SelectTrigger id="brief-ranking" data-testid="brief-ranking-select"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RANKING_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>{RANKING_LABELS[mode]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={!draft.description.trim() || !draft.capabilities.trim()} data-testid="brief-preview-button">
            Preview interpretation
          </Button>
        </form>
      )}

      {step === 'interpretation' && (
        <div className="card p-6 space-y-5 border border-bh-border/60 rounded-2xl" data-testid="interpretation-preview">
          <h2 className="text-lg font-semibold">Here&apos;s what we understood</h2>
          <dl className="text-sm space-y-2">
            <div><dt className="inline font-semibold">Deliverable: </dt><dd className="inline text-bh-text-muted">{draft.description}</dd></div>
            <div><dt className="inline font-semibold">Domain: </dt><dd className="inline text-bh-text-muted">{DOMAIN_LABELS[draft.domain]}</dd></div>
            <div><dt className="inline font-semibold">Capabilities: </dt><dd className="inline text-bh-text-muted">{draft.capabilities}</dd></div>
            <div><dt className="inline font-semibold">Ranking: </dt><dd className="inline text-bh-text-muted">{RANKING_LABELS[draft.rankingMode]}</dd></div>
          </dl>

          {needsClarification && (
            <div data-testid="clarifying-question">
              <Label htmlFor="clarify-budget">One quick question: do you have a maximum budget in mind?</Label>
              <div className="flex gap-2 items-center mt-1">
                <Input
                  id="clarify-budget"
                  type="number"
                  placeholder="Leave blank if unknown"
                  value={clarifyingAnswer}
                  onChange={(e) => setClarifyingAnswer(e.target.value)}
                  data-testid="clarify-budget-input"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setDraft((d) => ({ ...d, budgetKnown: true, budgetMaxDollars: clarifyingAnswer }))}
                  data-testid="clarify-submit-button"
                >
                  Set budget
                </Button>
              </div>
            </div>
          )}

          <div className="flex gap-3">
            <Button type="button" onClick={handleConfirmInterpretation} data-testid="interpretation-confirm-button">
              This looks right
            </Button>
            <Button type="button" variant="secondary" onClick={() => setStep('brief')} data-testid="interpretation-back-button">
              Correct it
            </Button>
          </div>
        </div>
      )}

      {step === 'confirm' && (
        <div className="card p-6 space-y-5 border border-bh-border/60 rounded-2xl" data-testid="credit-confirmation">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-bh-accent" aria-hidden="true" />
            Confirm generation
          </h2>
          <p className="text-sm text-bh-text-muted">
            This will use a maximum of <strong>10 credits</strong> (solutions.generate.v1). You&apos;ll
            only be charged once a usable result is produced — an unusable or failed run is never charged.
          </p>
          <div className="flex gap-3">
            <Button type="button" onClick={handleConfirmCharge} data-testid="charge-confirm-button">Confirm and generate</Button>
            <Button type="button" variant="secondary" onClick={handleReset} data-testid="charge-cancel-button">Cancel</Button>
          </div>
        </div>
      )}

      {step === 'result' && (
        <div className="space-y-4" data-testid="result-lanes">
          <div className="card p-4 border border-bh-accent/30 bg-bh-accent-soft rounded-xl text-sm" data-testid="demo-result-banner">
            {DEMO_SOLUTION_RUN.warnings[0]}
          </div>
          <DemoResultLanes run={DEMO_SOLUTION_RUN} />
          <Button type="button" variant="secondary" onClick={handleReset} data-testid="result-reset-button">Start a new brief</Button>
        </div>
      )}
    </div>
  )
}

function DemoResultLanes({ run }: { run: SolutionRun }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3" data-testid="demo-result-lanes">
      {run.routes.map((route) => (
        <div
          key={route.routeType}
          className="card p-4 border border-bh-border/60 rounded-xl flex flex-col gap-2"
          data-testid={`route-${route.routeType}`}
          data-status={route.status}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-bh-text-dim">{ROUTE_TYPE_LABELS[route.routeType]}</span>
            <span
              className={
                route.status === 'recommended' ? 'text-xs font-semibold text-bh-success'
                  : route.status === 'available' ? 'text-xs font-semibold text-bh-text-muted'
                    : 'text-xs font-semibold text-bh-text-dim'
              }
            >
              {route.status === 'recommended' ? 'Recommended' : route.status === 'available' ? 'Available' : 'Unavailable'}
            </span>
          </div>
          {route.status === 'unavailable' || !route.estimate ? (
            <p className="text-sm text-bh-text-muted" data-testid={`route-${route.routeType}-unavailable-reason`}>{route.unavailableReason}</p>
          ) : (
            <>
              <p className="text-sm font-medium">{route.summary}</p>
              <p className="text-xs text-bh-text-muted">
                ${(route.estimate.costMinCents / 100).toFixed(0)}–${(route.estimate.costMaxCents / 100).toFixed(0)} · {route.estimate.timeMinHours}–{route.estimate.timeMaxHours}h
              </p>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
