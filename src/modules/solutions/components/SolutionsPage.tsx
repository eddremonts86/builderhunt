/**
 * The Solutions surface, bound to the real endpoints (plan 43 Phase 8; plans/UI task 78).
 *
 * ## The order the user experiences, and why it is this order
 *
 *   describe → **confirm the exact charge** → generate → result → (save, choose a route)
 *
 * There is no interpretation step before the confirmation, and that is the change from the preview shell.
 * spec.md requires the reservation to exist *before* any provider access, and interpretation is provider
 * access — so a page that showed "here's what we understood" before the user agreed to pay was either lying
 * about what it did or spending money nobody authorized. What the user confirms is a number the server told us
 * (`GET /api/solutions/billing-state`), echoed back verbatim so a stale price is refused rather than billed.
 *
 * ## Clarification costs nothing
 *
 * When the run needs one question answered, the server releases the hold and returns the question. Answering it
 * and pressing generate again is the only charge. The copy says so, because a user asked to answer a question
 * mid-flow will otherwise assume they are being charged twice.
 *
 * ## Cancel is a disconnect
 *
 * `AbortController.abort()` drops the stream; the server sees `request.signal` fire and releases the
 * reservation. No cancel endpoint, no run id to authorize, nothing to leak.
 */
import * as React from 'react'
import { Lightbulb, Lock, Sparkles } from 'lucide-react'
import { Button, Label, Textarea } from '~/components/ui'
import { PaidStateActions } from '~/shared/components/PaidStateActions'
import type { SolutionRoute } from '~/shared/lib/solutions/contracts'
import { DEMO_SOLUTION_RUN } from '~/shared/lib/solutions/demo-fixtures'
import { RunResult } from './RunResult'

interface ChargeDto {
  operation: string
  units: number
  rateCardVersion: number
}

interface ActionDto {
  charge: ChargeDto
  available: boolean
  unavailableReason: string | null
}

export interface BillingStateDto {
  balanceUnits: number
  generate: ActionDto
  regenerate: ActionDto
}

interface GeneratedRunDto {
  status: 'complete'
  runId: string
  brief: unknown
  routes: SolutionRoute[]
  routeExplanations: Array<{ provenance: 'model' | 'deterministic'; fallbackReason?: string }>
  interpretation: { unknownFields: string[]; provenance: string; promptVersion: string | null }
  evidenceLevels: Record<string, string>
  attributions: Array<{ sourceKey: string; text: string; url: string }>
  warnings: string[]
  trace: { composerVersion: string; retrievalQueryHash: string; compositionHash: string; durationMs: number }
  settledUnits: number
}

type StreamEvent =
  | { event: 'progress'; data: { stage: string; fraction: number; detail?: string } }
  | { event: 'result'; data: GeneratedRunDto | { status: 'needs_clarification'; question: string; materiality: string } | { status: 'unreadable'; reason: string } }
  | { event: 'error'; data: { code: string; message: string } }

export interface SolutionsPageProps {
  /** Injected for tests — defaults to a real fetch against `/api/billing/summary`. */
  fetchEntitlement?: () => Promise<{ paidActionsAllowed: boolean; staleSession?: boolean }>
  /** Injected for tests — defaults to `/api/solutions/billing-state`. */
  fetchBillingState?: () => Promise<BillingStateDto | null>
  /** Injected for tests — defaults to the SSE call against `/api/solutions/generate`. */
  runGeneration?: (input: {
    briefText: string
    confirmation: { acceptedUnits: number; acceptedRateCardVersion: number }
    idempotencyKey: string
    clarification?: { question: string; answer: string }
    signal: AbortSignal
    onEvent: (event: StreamEvent) => void
  }) => Promise<void>
  saveRun?: (run: GeneratedRunDto) => Promise<{ id: string }>
}

type Entitlement = 'loading' | 'locked' | 'stale_session' | 'unlocked'
type Step = 'brief' | 'confirm' | 'running' | 'clarify' | 'result'

export function SolutionsPage({
  fetchEntitlement,
  fetchBillingState,
  runGeneration,
  saveRun,
}: SolutionsPageProps = {}) {
  const [entitlement, setEntitlement] = React.useState<Entitlement>('loading')
  const [billing, setBilling] = React.useState<BillingStateDto | null>(null)
  const [briefText, setBriefText] = React.useState('')
  const [step, setStep] = React.useState<Step>('brief')
  const [progress, setProgress] = React.useState<{ stage: string; fraction: number } | null>(null)
  const [run, setRun] = React.useState<GeneratedRunDto | null>(null)
  const [clarification, setClarification] = React.useState<{ question: string; materiality: string } | null>(null)
  const [answer, setAnswer] = React.useState('')
  const [error, setError] = React.useState<{ code: string; message: string } | null>(null)
  const [savedRunId, setSavedRunId] = React.useState<string | null>(null)
  const [chosenRoute, setChosenRoute] = React.useState<string | null>(null)
  const abortRef = React.useRef<AbortController | null>(null)
  // Stable across retries of the same intent, so a retried generation replays instead of charging twice.
  const idempotencyRef = React.useRef<string>(newIdempotencyKey())

  React.useEffect(() => {
    const load = fetchEntitlement ?? defaultFetchEntitlement
    load()
      .then((result) => setEntitlement(result.staleSession ? 'stale_session' : result.paidActionsAllowed ? 'unlocked' : 'locked'))
      .catch(() => setEntitlement('locked'))
  }, [fetchEntitlement])

  React.useEffect(() => {
    if (entitlement !== 'unlocked') return
    const load = fetchBillingState ?? defaultFetchBillingState
    load().then(setBilling).catch(() => setBilling(null))
  }, [entitlement, fetchBillingState])

  function reset() {
    abortRef.current?.abort()
    idempotencyRef.current = newIdempotencyKey()
    setBriefText('')
    setRun(null)
    setClarification(null)
    setAnswer('')
    setError(null)
    setProgress(null)
    setSavedRunId(null)
    setChosenRoute(null)
    setStep('brief')
  }

  async function generate(withAnswer?: { question: string; answer: string }) {
    const charge = billing?.generate.charge
    if (!charge) return
    setError(null)
    setProgress({ stage: 'starting', fraction: 0 })
    setStep('running')

    const controller = new AbortController()
    abortRef.current = controller
    const call = runGeneration ?? defaultRunGeneration

    try {
      await call({
        briefText,
        confirmation: { acceptedUnits: charge.units, acceptedRateCardVersion: charge.rateCardVersion },
        idempotencyKey: idempotencyRef.current,
        ...(withAnswer ? { clarification: withAnswer } : {}),
        signal: controller.signal,
        onEvent: (event) => {
          if (event.event === 'progress') {
            setProgress(event.data)
            return
          }
          if (event.event === 'error') {
            setError(event.data)
            setStep('brief')
            return
          }
          const result = event.data
          if (result.status === 'needs_clarification') {
            setClarification({ question: result.question, materiality: result.materiality })
            setStep('clarify')
            return
          }
          if (result.status === 'unreadable') {
            setError({ code: 'unreadable', message: result.reason })
            setStep('brief')
            return
          }
          setRun(result)
          setStep('result')
        },
      })
    } catch (cause) {
      if ((cause as Error).name !== 'AbortError') {
        setError({ code: 'generation_failed', message: 'Generation failed. You have not been charged.' })
      }
      setStep('brief')
    }
  }

  if (entitlement === 'loading') {
    return <div className="container py-12" data-testid="solutions-loading" aria-live="polite">Loading…</div>
  }

  if (entitlement === 'stale_session') {
    return (
      <LockedShell testId="solutions-stale-session" title="Sign in again to continue">
        <p className="text-bh-text-muted mb-6 max-w-lg mx-auto">Your session needs refreshing before we can check your plan.</p>
        <PaidStateActions reason="stale_session" />
      </LockedShell>
    )
  }

  if (entitlement === 'locked') {
    return (
      <LockedShell testId="solutions-locked" title="Solutions is a Pro, Pro Max, and Team feature">
        <p className="text-bh-text-muted mb-6 max-w-lg mx-auto">
          Describe a piece of digital work and get up to three evidence-backed ways to solve it — a human
          specialist, an AI system, or a hybrid workflow — compared side by side.
        </p>
        <PaidStateActions reason="not_entitled" />
        <div className="mt-8 text-left">
          <p className="text-xs uppercase tracking-wider text-bh-text-dim mb-3">Example output</p>
          <RunResult routes={DEMO_SOLUTION_RUN.routes} warnings={DEMO_SOLUTION_RUN.warnings} />
        </div>
      </LockedShell>
    )
  }

  const generateAction = billing?.generate
  const blocked = generateAction && !generateAction.available ? generateAction.unavailableReason : null

  return (
    <div className="container py-12 max-w-5xl" data-testid="solutions-page">
      <header className="mb-8">
        <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
          <Lightbulb className="w-6 h-6 text-bh-accent" aria-hidden="true" />
          Solutions
        </h1>
        <p className="text-bh-text-muted mt-1">
          Describe the outcome you need. Nothing is saved until you explicitly save a result.
        </p>
      </header>

      {/* One region announces every state change, so a screen reader hears the run start, progress, and finish
          without the focus moving out from under the user. */}
      <div className="sr-only" role="status" aria-live="polite" data-testid="solutions-announcer">
        {step === 'running' && progress ? `Working: ${progress.stage}` : ''}
        {step === 'result' ? 'Results ready' : ''}
        {step === 'clarify' ? 'One question before we can continue' : ''}
        {error ? error.message : ''}
      </div>

      {blocked && (
        <div className="card p-4 mb-6 border border-bh-border/60 bg-bh-bg-alt rounded-xl text-sm" data-testid="solutions-blocked">
          <BlockedMessage reason={blocked} balanceUnits={billing?.balanceUnits ?? 0} />
        </div>
      )}

      {error && (
        <div className="card p-4 mb-6 border border-bh-danger/40 bg-bh-danger-soft rounded-xl text-sm" data-testid="solutions-error">
          {error.message}
        </div>
      )}

      {step === 'brief' && (
        <form
          className="card p-6 space-y-5 border border-bh-border/60 rounded-2xl"
          data-testid="brief-form"
          onSubmit={(event) => { event.preventDefault(); setStep('confirm') }}
        >
          <div>
            <Label htmlFor="brief-description">What do you need done?</Label>
            <Textarea
              id="brief-description"
              required
              rows={5}
              placeholder="e.g. Translate a 20-page technical manual from English to Spanish by 30 September. Budget max 2000 EUR."
              value={briefText}
              onChange={(event) => setBriefText(event.target.value)}
              data-testid="brief-description-input"
            />
            <p className="text-xs text-bh-text-dim mt-1">
              Write it as you would to a colleague. Budgets, deadlines and constraints are read from your own words —
              and only kept when your words actually say them.
            </p>
          </div>
          <Button type="submit" disabled={briefText.trim().length === 0 || Boolean(blocked)} data-testid="brief-continue-button">
            Continue
          </Button>
        </form>
      )}

      {step === 'confirm' && generateAction && (
        <div className="card p-6 space-y-5 border border-bh-border/60 rounded-2xl" data-testid="credit-confirmation">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-bh-accent" aria-hidden="true" />
            Confirm the charge
          </h2>
          <p className="text-sm text-bh-text-muted">
            This costs <strong data-testid="confirm-charge-units">{generateAction.charge.units} credits</strong>.
            You are charged once, only when a usable result is produced — a failed or unusable run costs nothing,
            and if we need to ask you a question first, that question is free.
          </p>
          <p className="text-xs text-bh-text-dim" data-testid="confirm-balance">
            Your balance: {billing?.balanceUnits ?? 0} credits.
          </p>
          <div className="flex gap-3">
            <Button type="button" onClick={() => void generate()} data-testid="charge-confirm-button">
              Confirm and generate
            </Button>
            <Button type="button" variant="secondary" onClick={() => setStep('brief')} data-testid="charge-cancel-button">
              Back
            </Button>
          </div>
        </div>
      )}

      {step === 'running' && (
        <div className="card p-6 space-y-4 border border-bh-border/60 rounded-2xl" data-testid="generation-progress">
          <p className="text-sm font-medium">{stageLabel(progress?.stage)}</p>
          <div className="h-1.5 bg-bh-bg-alt rounded-full overflow-hidden">
            <div
              className="h-full bg-bh-accent transition-all"
              style={{ width: `${Math.round((progress?.fraction ?? 0) * 100)}%` }}
              role="progressbar"
              aria-valuenow={Math.round((progress?.fraction ?? 0) * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Generation progress"
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => { abortRef.current?.abort(); setStep('brief') }}
            data-testid="generation-cancel-button"
          >
            Cancel — you will not be charged
          </Button>
        </div>
      )}

      {step === 'clarify' && clarification && (
        <div className="card p-6 space-y-4 border border-bh-border/60 rounded-2xl" data-testid="clarifying-question">
          <h2 className="text-lg font-semibold">One question first</h2>
          <p className="text-sm">{clarification.question}</p>
          <p className="text-xs text-bh-text-dim">{clarification.materiality}. Answering costs nothing.</p>
          <Label htmlFor="clarify-answer">Your answer</Label>
          <Textarea
            id="clarify-answer"
            rows={2}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            data-testid="clarify-answer-input"
          />
          <div className="flex gap-3">
            <Button
              type="button"
              disabled={answer.trim().length === 0}
              onClick={() => void generate({ question: clarification.question, answer })}
              data-testid="clarify-submit-button"
            >
              Answer and generate
            </Button>
            <Button type="button" variant="secondary" onClick={reset} data-testid="clarify-cancel-button">Start over</Button>
          </div>
        </div>
      )}

      {step === 'result' && run && (
        <div className="space-y-4">
          <RunResult
            routes={run.routes}
            routeProvenance={run.routes.map((route, index) => ({
              routeType: route.routeType,
              provenance: run.routeExplanations[index]?.provenance ?? 'deterministic',
              fallbackReason: run.routeExplanations[index]?.fallbackReason ?? null,
            }))}
            evidenceLevels={run.evidenceLevels}
            warnings={run.warnings}
            unknownFields={run.interpretation.unknownFields}
            attributions={run.attributions}
            chosenRouteType={chosenRoute}
            onChoose={setChosenRoute}
          />
          <div className="flex gap-3 items-center">
            <Button
              type="button"
              disabled={Boolean(savedRunId)}
              onClick={() => {
                const save = saveRun ?? defaultSaveRun
                void save(run).then((saved) => setSavedRunId(saved.id)).catch(() => setError({
                  code: 'save_failed', message: 'Could not save this result. It is still on screen.',
                }))
              }}
              data-testid="save-run-button"
            >
              {savedRunId ? 'Saved' : 'Save this result'}
            </Button>
            <Button type="button" variant="secondary" onClick={reset} data-testid="result-reset-button">Start a new brief</Button>
            <span className="text-xs text-bh-text-dim" data-testid="result-charge">
              Charged {run.settledUnits} credits.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function LockedShell({ testId, title, children }: { testId: string; title: string; children: React.ReactNode }) {
  return (
    <div className="container py-12 max-w-3xl" data-testid={testId}>
      <div className="card p-8 border border-bh-border/60 bg-bh-surface rounded-2xl text-center">
        <Lock className="w-8 h-8 text-bh-accent mx-auto mb-4" aria-hidden="true" />
        <h1 className="text-2xl font-bold mb-2">{title}</h1>
        {children}
      </div>
    </div>
  )
}

/**
 * Each refusal leads somewhere different.
 *
 * A disabled feature has no remedy the user can buy, `tier_too_low` means upgrade, and `insufficient_credits`
 * means a credit pack. Collapsing them into "unavailable" sends everyone to the pricing page, including the
 * people an upgrade cannot help.
 */
function BlockedMessage({ reason, balanceUnits }: { reason: string; balanceUnits: number }) {
  if (reason === 'feature_disabled') {
    return <span>Solutions generation is switched off for now. Nothing you can do here — we will turn it on.</span>
  }
  if (reason === 'insufficient_credits') {
    return <span>Not enough credits: you have {balanceUnits}. Top up to generate a solution.</span>
  }
  if (reason === 'tier_too_low' || reason === 'no_subscription') {
    return <span>Solutions needs an active Pro, Pro Max, or Team plan.</span>
  }
  return <span>Solutions is unavailable right now.</span>
}

function stageLabel(stage?: string): string {
  switch (stage) {
    case 'interpreting': return 'Reading your brief…'
    case 'retrieving': return 'Searching people and tools…'
    case 'composing': return 'Building the three routes…'
    case 'explaining': return 'Writing the explanations…'
    case 'done': return 'Finishing up…'
    default: return 'Starting…'
  }
}

function newIdempotencyKey(): string {
  return `sol-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

const defaultFetchEntitlement = (): Promise<{ paidActionsAllowed: boolean; staleSession?: boolean }> =>
  fetch('/api/billing/summary', { credentials: 'include' }).then((response) => {
    if (response.status === 401) return { paidActionsAllowed: false, staleSession: true }
    if (!response.ok) return { paidActionsAllowed: false }
    return response.json().then((data: { capabilities?: { paidActionsAllowed?: boolean } }) => ({
      paidActionsAllowed: Boolean(data.capabilities?.paidActionsAllowed),
    }))
  })

const defaultFetchBillingState = (): Promise<BillingStateDto | null> =>
  fetch('/api/solutions/billing-state', { credentials: 'include' })
    .then((response) => (response.ok ? response.json() : null))

const defaultSaveRun = (run: GeneratedRunDto): Promise<{ id: string }> =>
  fetch('/api/solutions/runs', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      brief: run.brief,
      rankingMode: (run.brief as { rankingMode?: string }).rankingMode ?? 'recommended',
      retrievalQueryHash: run.trace.retrievalQueryHash,
      compositionHash: run.trace.compositionHash,
      composerVersion: run.trace.composerVersion,
      interpretPromptVersion: run.interpretation.promptVersion,
      warnings: run.warnings,
      routes: run.routes.map((route, index) => ({
        route,
        explanationProvenance: run.routeExplanations[index]?.provenance ?? 'deterministic',
        explanationFallbackReason: run.routeExplanations[index]?.fallbackReason ?? null,
      })),
    }),
  }).then((response) => {
    if (!response.ok) throw new Error('save failed')
    return response.json()
  })

/**
 * Reads the SSE stream by hand rather than with `EventSource`.
 *
 * `EventSource` cannot POST, and the request carries a brief, a confirmation, and an idempotency key — none of
 * which belong in a URL. Parsing is a two-line split because the server writes exactly one `event:`/`data:` pair
 * per message and nothing else.
 */
const defaultRunGeneration: NonNullable<SolutionsPageProps['runGeneration']> = async (input) => {
  const response = await fetch('/api/solutions/generate', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    signal: input.signal,
    body: JSON.stringify({
      briefText: input.briefText,
      confirmation: input.confirmation,
      idempotencyKey: input.idempotencyKey,
      ...(input.clarification ? { clarification: input.clarification } : {}),
    }),
  })

  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({ error: 'Generation failed' }))
    input.onEvent({ event: 'error', data: { code: 'request_failed', message: String(payload.error ?? 'Generation failed') } })
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const messages = buffer.split('\n\n')
    // The tail may be a partial message; keep it for the next chunk.
    buffer = messages.pop() ?? ''
    for (const message of messages) {
      const eventLine = message.split('\n').find((line) => line.startsWith('event: '))
      const dataLine = message.split('\n').find((line) => line.startsWith('data: '))
      if (!eventLine || !dataLine) continue
      try {
        input.onEvent({
          event: eventLine.slice(7).trim(),
          data: JSON.parse(dataLine.slice(6)),
        } as StreamEvent)
      } catch {
        // A malformed frame is dropped rather than aborting the stream: the terminal event may still arrive,
        // and killing the run over one unparsable progress tick would lose a result the user paid for.
      }
    }
  }
}
