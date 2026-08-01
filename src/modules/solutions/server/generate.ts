/**
 * The end-to-end generation flow (plan 43 Phase 8, "Connect the end-to-end generation flow").
 *
 * **Server-only.** Reaches the credit boundary, the repositories, and the `postgres` driver.
 *
 * ## The order, and where the money is
 *
 *   confirm → **reserve** → interpret → retrieve → compose → explain → settle or release
 *
 * Everything provider-backed happens inside `withSolutionsCredits`' work callback, which is what spec.md means
 * by "reserve before interpretation or other provider access". Retrieval and composition touch no provider at
 * all — they are SQL and arithmetic — so a run whose flags are off costs nothing and still produces routes.
 *
 * ## Clarification: released, not held
 *
 * spec.md says to "keep clarification inside that reservation". A round trip to ask the user a question would
 * mean holding a reservation across two HTTP requests, with all the server state, timeout, and abandonment
 * handling that implies. This does something simpler with the same promise: when interpretation returns a
 * material question and the caller has not answered one yet, the run stops and the hold is **released**, so the
 * user is charged nothing for the question and exactly once for the run that answers it. The unanswered
 * interpretation call is a cost we absorb.
 *
 * The abuse this invites — looping for free interpretation calls — is bounded by the one-question ceiling: the
 * second attempt carries `priorClarification`, and `pickQuestion` refuses to ask again.
 *
 * ## Cancellation
 *
 * `signal` is checked between stages and before each explanation. An aborted run throws, which releases the
 * reservation through the same path as any other failure. Mid-provider-call cancellation is not attempted: the
 * provider has already been paid for that call, and pretending otherwise would make the release a lie.
 */
import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import type { TenantTransaction } from '~/shared/lib/db/client'
import { log } from '~/shared/lib/log'
import type { SolutionBrief, SolutionRoute } from '~/shared/lib/solutions/contracts'
import { composeRoutes } from '~/lib/solutions/composer/compose'
import { explainRoute, type ExplainedRoute } from '~/lib/solutions/ai/explain'
import { interpretBrief, type InterpretedBrief } from '~/lib/solutions/ai/interpret'
import { humanLane } from '~/lib/solutions/retrieval/lanes'
import { retrieveForBrief } from '~/lib/solutions/retrieval/retrieve'
import { listAttributionsForEvidence, listComponentClaimSnippets, type SourceAttribution } from '~/shared/lib/repositories/solution-catalog'
import { withSolutionsCredits, type SolutionsCreditConfirmation } from './billing'

export type GenerationStage = 'interpreting' | 'retrieving' | 'composing' | 'explaining' | 'done'

export interface GenerationProgress {
  stage: GenerationStage
  /** 0–1. Coarse on purpose: a precise-looking bar that jumps is worse than an honest coarse one. */
  fraction: number
  detail?: string
}

export interface GenerateInput {
  /** What the user typed. Structured interpretation happens server-side, after the reservation. */
  briefText: string
  /** The user's answer to the one question a previous attempt asked. */
  clarificationAnswer?: { question: string; answer: string }
  confirmation: SolutionsCreditConfirmation
  /** Reused verbatim on retry, which is what makes a duplicate request replay instead of double-charging. */
  idempotencyKey: string
  reservationId?: string
  operation?: 'generate' | 'regenerate'
  signal?: AbortSignal
  onProgress?: (progress: GenerationProgress) => void
  db?: PostgresJsDatabase
}

export interface GeneratedRun {
  status: 'complete'
  runId: string
  brief: SolutionBrief
  routes: SolutionRoute[]
  routeExplanations: ExplainedRoute[]
  interpretation: Omit<InterpretedBrief, 'brief'>
  componentVersionIds: string[]
  evidenceIds: string[]
  /** Per-component evidence levels, keyed by `componentId@version`, so the UI can say "vendor's own claim". */
  evidenceLevels: Record<string, string>
  /**
   * Attribution notices the surface is *required* to display.
   *
   * `remoteok_jobs` and `jobicy_jobs` grant access on that condition. Carried in the run payload rather than
   * left to the client to look up, so a surface cannot render the data and forget the obligation.
   */
  attributions: SourceAttribution[]
  warnings: string[]
  trace: { composerVersion: string; retrievalQueryHash: string; compositionHash: string; durationMs: number }
  settledUnits: number
}

export interface NeedsClarification {
  status: 'needs_clarification'
  question: string
  /** Why the answer changes the result. Shown to the user, because "just answer this" is not a reason. */
  materiality: string
  settledUnits: 0
}

export interface Unreadable {
  status: 'unreadable'
  /** No capability could be established, so there is nothing to retrieve against. */
  reason: string
  settledUnits: 0
}

export type GenerationOutcome = GeneratedRun | NeedsClarification | Unreadable

export async function generateSolutions(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: GenerateInput,
): Promise<GenerationOutcome> {
  const operation = input.operation ?? 'generate'
  const reservationId = input.reservationId ?? randomUUID()
  const started = Date.now()

  const charge = await withSolutionsCredits(
    transaction,
    principal,
    { operation, reservationId, idempotencyKey: input.idempotencyKey, confirmation: input.confirmation },
    async () => {
      const outcome = await runStages(input, started)
      return {
        result: outcome.result,
        // A clarification request and an unreadable brief are both *not* usable results: the user has nothing
        // to act on but a question. Releasing is what makes the eventual answered run the only charge.
        usable: outcome.result.status === 'complete',
        providerInvoked: outcome.providerInvoked,
        providerReference: null,
      }
    },
  )

  const result = charge.result
  if (result.status !== 'complete') return result
  return { ...result, settledUnits: charge.settledUnits }
}

async function runStages(
  input: GenerateInput,
  started: number,
): Promise<{ result: GenerationOutcome; providerInvoked: boolean }> {
  const report = (stage: GenerationStage, fraction: number, detail?: string) =>
    input.onProgress?.({ stage, fraction, ...(detail ? { detail } : {}) })

  throwIfAborted(input.signal)
  report('interpreting', 0.1)
  const interpretation = await interpretBrief({
    briefText: input.briefText,
    ...(input.clarificationAnswer ? { priorClarification: input.clarificationAnswer } : {}),
  })
  const interpretInvoked = interpretation.provenance === 'model'

  if (!interpretation.brief) {
    return {
      result: {
        status: 'unreadable',
        reason: 'No capability could be identified in this brief. Choose the capabilities you need and try again.',
        settledUnits: 0,
      },
      providerInvoked: interpretInvoked,
    }
  }

  // Asked before anything expensive runs, so an unanswered question costs one interpretation rather than a
  // whole composition.
  if (interpretation.clarifyingQuestion && !input.clarificationAnswer) {
    return {
      result: {
        status: 'needs_clarification',
        question: interpretation.clarifyingQuestion.question,
        materiality: interpretation.clarifyingQuestion.materiality,
        settledUnits: 0,
      },
      providerInvoked: interpretInvoked,
    }
  }

  const brief = interpretation.brief
  throwIfAborted(input.signal)
  report('retrieving', 0.35)
  const retrieval = await retrieveForBrief(brief, { ...(input.db ? { db: input.db } : {}) })
  const people = await humanLane(brief.deliverable.description, 20, input.db)

  throwIfAborted(input.signal)
  report('composing', 0.55)
  const composed = await composeRoutes({ brief, retrieval, people, ...(input.db ? { db: input.db } : {}) })

  report('explaining', 0.7)
  const evidence = await loadEvidence(composed.componentVersionIds, input.db)
  const attributions = await loadAttributions(composed.componentVersionIds, input.db)
  const explanations: ExplainedRoute[] = []
  let explainInvoked = false
  for (const route of composed.routes) {
    throwIfAborted(input.signal)
    const explained = await explainRoute({
      route,
      evidence: evidence.filter((snippet) => route.evidenceIds.includes(snippet.evidenceId)),
    })
    if (explained.provenance === 'model') explainInvoked = true
    explanations.push(explained)
  }

  // The prose the model produced replaces the composer's, and only the prose: statuses, estimates, coverage and
  // evidence are the composer's output and are not the model's to change.
  const routes = composed.routes.map((route, index) => ({
    ...route,
    summary: explanations[index]?.summary ?? route.summary,
    fitExplanation: explanations[index]?.fitExplanation ?? route.fitExplanation,
  }))

  report('done', 1)
  return {
    result: {
      status: 'complete',
      runId: randomUUID(),
      brief,
      routes,
      routeExplanations: explanations,
      interpretation: {
        provenance: interpretation.provenance,
        ...(interpretation.fallbackReason ? { fallbackReason: interpretation.fallbackReason } : {}),
        unknownFields: interpretation.unknownFields,
        discardedConstraints: interpretation.discardedConstraints,
        promptVersion: interpretation.promptVersion,
      },
      componentVersionIds: composed.componentVersionIds,
      evidenceIds: [...new Set(routes.flatMap((route) => route.evidenceIds))].sort(),
      evidenceLevels: Object.fromEntries(evidence.map((snippet) => [snippet.evidenceId, snippet.evidenceLevel])),
      attributions,
      warnings: composed.warnings,
      trace: {
        composerVersion: composed.trace.composerVersion,
        retrievalQueryHash: composed.trace.retrievalQueryHash,
        compositionHash: composed.trace.compositionHash,
        durationMs: Date.now() - started,
      },
      settledUnits: 0,
    },
    providerInvoked: interpretInvoked || explainInvoked,
  }
}

/**
 * The catalog's own claims for the components a route cites.
 *
 * Only what the routes cite — the explanation is given the evidence for its own components and nothing else, so
 * there is no adjacent claim it could reach for.
 */
async function loadEvidence(componentVersionIds: readonly string[], db?: PostgresJsDatabase) {
  if (componentVersionIds.length === 0) return []
  try {
    return await listComponentClaimSnippets(componentVersionIds, db)
  } catch (error) {
    // A route explains itself from the composer's own text when the evidence read fails. Losing the prose is
    // better than explaining a route from evidence nobody could load.
    log.warn('solutions_evidence_load_failed', { error: error instanceof Error ? error.message : String(error) })
    return []
  }
}

/**
 * Attribution obligations for the sources behind the cited components.
 *
 * Unlike the evidence read, a failure here is **not** swallowed into an empty list quietly: showing a source's
 * data without its required notice is how access to that source is lost. The run still completes — refusing to
 * answer would be worse for the user — but the failure is logged at error level so it is visible, and the
 * missing notice is the reason.
 */
async function loadAttributions(componentVersionIds: readonly string[], db?: PostgresJsDatabase): Promise<SourceAttribution[]> {
  if (componentVersionIds.length === 0) return []
  try {
    return await listAttributionsForEvidence(componentVersionIds, db)
  } catch (error) {
    log.error('solutions_attribution_load_failed', {
      error: error instanceof Error ? error.message : String(error),
      componentVersionIds: componentVersionIds.length,
    })
    return []
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Generation cancelled')
    error.name = 'AbortError'
    throw error
  }
}
