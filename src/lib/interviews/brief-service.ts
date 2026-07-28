import { randomUUID } from 'node:crypto'
import { AIDisabledError, AIParseError, AIProviderError } from '~/shared/lib/ai/errors'
import { sensitiveCompletion } from '~/shared/lib/ai/sensitive'
import {
  INTERVIEW_BRIEF_PROMPT_VERSION,
  buildInterviewBriefOutputSchema,
  getTask,
  type InterviewBriefTaskInput,
} from '~/shared/lib/ai/tasks'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import type { TenantTransaction } from '~/shared/lib/db/client'
import { env } from '~/shared/lib/env'
import type { InterviewBriefContent, SourceManifestEntry } from '~/shared/lib/interviews'
import { withInterviewCredits } from '~/modules/interviews/billing'
import {
  insertBriefVersion,
  updateBriefContent,
  type InterviewBriefRow,
} from '~/shared/lib/repositories/interviews'
import { assembleBriefEvidence } from './evidence'

/**
 * Generates and versions interview briefs (plan:
 * calendar-scheduling-interview-intelligence, Phase 8).
 *
 * ## The order is credits, then provider, then persistence
 *
 * `withInterviewCredits` wraps the provider call, so nothing is sent to a model before a reservation
 * exists and the actual usage is settled afterwards. The brief row is written *inside* that wrapper's
 * work callback and therefore inside the caller's transaction: if persistence fails, the settlement
 * rolls back with it and the organizer is not charged for a brief they never received.
 *
 * ## A brief with no evidence is refused, not generated
 *
 * Asking a model to assess a candidate from an empty manifest produces confident prose about nobody.
 * `no_evidence` is returned instead, with the counts, so the UI can say "two documents are still being
 * scanned" — which is an answer the organizer can act on, unlike a brief that quietly omitted them.
 *
 * ## Failure produces a deterministic fallback, never a partial model brief
 *
 * When sensitive AI is switched off, or the provider fails, or the output does not validate, the caller
 * gets a fallback brief assembled by `buildFallbackBrief` — plain, honest, and marked by carrying no
 * provider/model/promptVersion at all. It exists so an interview can still be prepared for, and it is
 * deliberately not a retry: re-rolling an assessment somebody will act on is worse than a manual one.
 */

export type BriefGenerationOutcome =
  | { kind: 'generated'; brief: InterviewBriefRow; settledUnits: number }
  | { kind: 'fallback'; brief: InterviewBriefRow; reason: BriefFallbackReason }
  | { kind: 'no_evidence'; summary: Awaited<ReturnType<typeof assembleBriefEvidence>>['summary'] }

export type BriefFallbackReason = 'ai_disabled' | 'provider_failed' | 'invalid_output'

export class BriefServiceError extends Error {
  constructor(message: string, readonly code: 'insufficient_entitlement' | 'insufficient_credits' | 'version_conflict') {
    super(message)
    this.name = 'BriefServiceError'
  }
}

function retentionExpiry(now: Date): Date {
  return new Date(now.getTime() + env.INTERVIEW_DOCUMENT_RETENTION_DAYS * 24 * 60 * 60_000)
}

/**
 * A brief assembled without a model.
 *
 * Every claim is the trivially true one — "this source was supplied" — so nothing here asserts anything
 * about the candidate that the sources do not literally contain. The questions are generic and say so.
 * The point is not to imitate a generated brief; it is to give the interviewer the evidence list and an
 * honest starting point, and to make the absence of AI visible rather than disguised.
 */
export function buildFallbackBrief(params: {
  roleTitle: string
  manifest: readonly SourceManifestEntry[]
  reason: BriefFallbackReason
}): InterviewBriefContent {
  const citable = params.manifest.filter((entry) => entry.kind !== 'submitted_link')
  const links = params.manifest.filter((entry) => entry.kind === 'submitted_link')

  const why = params.reason === 'ai_disabled'
    ? 'AI brief generation is currently switched off.'
    : 'The brief could not be generated automatically this time.'

  return {
    candidateSummary: [
      `${why} This is a manual starting point for the ${params.roleTitle} interview.`,
      citable.length > 0
        ? `${citable.length} supplied source${citable.length === 1 ? '' : 's'} are listed below for you to read.`
        : 'No readable sources were supplied.',
    ].join(' '),
    // Each source gets one claim that is true by construction: it was supplied. `low` confidence
    // because "this document exists" is not evidence about the candidate.
    relevantEvidence: citable.map((entry) => ({
      claim: `A source was supplied: ${entry.label}.`,
      sourceIds: [entry.id],
      confidence: 'low' as const,
    })),
    informationGaps: [
      'This brief was not generated from the sources — read them directly before the interview.',
      ...(links.length > 0
        ? [`${links.length} link${links.length === 1 ? '' : 's'} could not be read automatically and must be opened manually.`]
        : []),
    ],
    contradictions: [],
    questionGroups: [
      {
        category: 'general' as const,
        question: 'Walk me through the work you are most proud of in this area.',
        rationale: 'Generic opener — this brief was not generated from the supplied sources.',
        sourceIds: [],
      },
    ],
  }
}

/**
 * Generates a brief for one interview.
 *
 * `expectedLatestVersion` is the optimistic guard: the caller passes the version it was showing, and a
 * concurrent generation that already advanced past it fails with `version_conflict` rather than adding a
 * third version nobody asked for. Passing `null` means "there should be none yet".
 */
export async function generateBrief(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  params: {
    eventId: string
    submissionId: string
    roleTitle: string
    roleContext: string
    now?: Date
    /** Injected in tests; production uses the real sensitive boundary. */
    complete?: typeof sensitiveCompletion
  },
): Promise<BriefGenerationOutcome> {
  const now = params.now ?? new Date()
  const complete = params.complete ?? sensitiveCompletion

  const evidence = await assembleBriefEvidence(transaction, {
    organizationId: principal.organizationId,
    submissionId: params.submissionId,
  })

  if (evidence.summary.citableSources === 0) {
    // Nothing to read. A model given an empty manifest writes confident prose about nobody, and the
    // organizer cannot tell that from a real brief.
    return { kind: 'no_evidence', summary: evidence.summary }
  }

  const persistFallback = async (reason: BriefFallbackReason): Promise<BriefGenerationOutcome> => {
    const brief = await insertBriefVersion(transaction, {
      organizationId: principal.organizationId,
      eventId: params.eventId,
      ownerUserId: principal.userId,
      content: buildFallbackBrief({ roleTitle: params.roleTitle, manifest: evidence.manifest, reason }),
      evidenceManifest: evidence.manifest,
      // No provenance at all, which is the provenance check's "deterministic fallback" branch: the row
      // says plainly that no model wrote it rather than naming one that did not.
      provider: null,
      model: null,
      promptVersion: null,
      retentionExpiresAt: retentionExpiry(now),
    })
    return { kind: 'fallback', brief, reason }
  }

  const task = getTask('interview-brief-generate')
  if (!task) throw new Error('interview-brief-generate is not registered')

  const input: InterviewBriefTaskInput = {
    roleTitle: params.roleTitle,
    roleContext: params.roleContext,
    sources: [...evidence.manifest],
  }
  const parsedInput = task.inputSchema.safeParse(input)
  if (!parsedInput.success) {
    // The manifest exceeded a bound the task enforces. A fallback rather than an error: the evidence is
    // real, we simply cannot prompt with all of it, and the interviewer still needs the list.
    return persistFallback('invalid_output')
  }

  if (env.SENSITIVE_AI_ENABLED !== 'true') {
    // Checked before reserving. Charging for a brief the switch forbids generating would be indefensible.
    return persistFallback('ai_disabled')
  }

  try {
    const outcome = await withInterviewCredits(
      transaction,
      principal,
      { operation: 'brief', reservationId: randomUUID(), idempotencyKey: `brief:${params.eventId}:${now.toISOString()}` },
      async () => {
        const completion = await complete({
          system: task.system,
          prompt: task.buildPrompt(parsedInput.data),
          // Built with this manifest in hand, so a citation to a source we did not send fails
          // validation rather than reaching the database.
          schema: buildInterviewBriefOutputSchema(evidence.manifest),
          maxOutputTokens: task.maxOutputTokens,
        })

        const brief = await insertBriefVersion(transaction, {
          organizationId: principal.organizationId,
          eventId: params.eventId,
          ownerUserId: principal.userId,
          content: completion.output,
          evidenceManifest: evidence.manifest,
          provider: completion.provider,
          model: completion.model,
          promptVersion: INTERVIEW_BRIEF_PROMPT_VERSION,
          retentionExpiresAt: retentionExpiry(now),
        })

        return {
          result: brief,
          // The card's flat 5 units. Token-proportional settlement would make the price of preparing for
          // an interview depend on how long the candidate's CV happens to be.
          actualUnits: 5,
          providerReference: `${completion.provider}:${completion.model}`,
        }
      },
    )

    return { kind: 'generated', brief: outcome.result, settledUnits: outcome.settledUnits }
  } catch (error) {
    // Entitlement and credits are the caller's problem to surface, not something to paper over with a
    // fallback: an organizer who is out of credits needs to know that, and a silent fallback would look
    // like the feature is simply poor.
    if (error instanceof Error && error.name === 'FeatureBillingError') {
      const code = (error as { code?: string }).code
      throw new BriefServiceError(error.message, code === 'insufficient_credits' ? 'insufficient_credits' : 'insufficient_entitlement')
    }
    if (error instanceof Error && error.name === 'InterviewBriefError' && (error as { code?: string }).code === 'version_conflict') {
      throw new BriefServiceError(error.message, 'version_conflict')
    }
    // A provider or validation failure. The reservation was already released by the wrapper.
    if (error instanceof AIDisabledError) return persistFallback('ai_disabled')
    if (error instanceof AIParseError) return persistFallback('invalid_output')
    if (error instanceof AIProviderError) return persistFallback('provider_failed')
    throw error
  }
}

/**
 * Applies an organizer's manual edit.
 *
 * A thin pass-through to the repository on purpose: the validation, the dangling-citation check and the
 * optimistic version guard all belong there, and re-implementing any of them here would give two answers
 * to the same question. What this adds is the error translation the routes want.
 */
export async function editBrief(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  params: {
    eventId: string
    expectedVersion: number
    content: unknown
    evidenceManifest: unknown
    /** `active` when the organizer is accepting the brief as they save it. */
    status?: 'draft' | 'active'
  },
): Promise<InterviewBriefRow> {
  try {
    return await updateBriefContent(transaction, {
      organizationId: principal.organizationId,
      eventId: params.eventId,
      expectedVersion: params.expectedVersion,
      content: params.content,
      evidenceManifest: params.evidenceManifest,
      editedByUserId: principal.userId,
      status: params.status,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'InterviewBriefError' && (error as { code?: string }).code === 'version_conflict') {
      throw new BriefServiceError(error.message, 'version_conflict')
    }
    throw error
  }
}
