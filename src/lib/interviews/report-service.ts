import { randomUUID } from 'node:crypto'
import {
  buildInterviewReportOutputSchema,
  getTask,
  INTERVIEW_REPORT_PROMPT_VERSION,
  INTERVIEW_REPORT_WINDOW_SEGMENTS,
  type InterviewReportTaskInput,
} from '~/shared/lib/ai/tasks'
import { sensitiveCompletion } from '~/shared/lib/ai/sensitive'
import { withInterviewCredits } from '~/modules/interviews/billing'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import type { TenantTransaction } from '~/shared/lib/db/client'
import { env } from '~/shared/lib/env'
import {
  assertReportContentIsClean,
  buildFallbackReportTemplate,
  interviewReportContentSchema,
} from '~/shared/lib/interviews'
import {
  assertReportCitationsResolve,
  findActiveBrief,
  finalizeReport,
  findLatestReport,
  insertReportVersion,
  listSessionSegments,
  type InterviewReportRow,
  type InterviewSessionRow,
} from '~/shared/lib/repositories/interviews'

/**
 * The post-interview report (plan: calendar-scheduling-interview-intelligence, Phase 10).
 *
 * ## The report never concludes anything, and three separate things enforce that
 *
 * The content schema has no rating field. The prohibited-output gate rejects the vocabulary. And the
 * *citation* check means a statement has to point at something someone actually said. A model can be
 * persuaded past a prompt; it cannot produce a shape the schema does not have.
 *
 * ## A provider failure produces a template, not an error
 *
 * The interview happened. The organizer needs somewhere to write it up, and refusing to create a report
 * because a model was unavailable would lose the one artifact the whole feature exists to produce. The
 * template says on its face that no model wrote it — `provider: null` is the marker, the same as the
 * brief's.
 *
 * ## Credits are settled on what happened, and released when nothing did
 *
 * Five credits reserved, settled at five on a real generation, released in full when the provider never
 * produced anything. A template that cost nothing must not be charged for: an organizer who was handed a
 * blank form and billed for a report would be right to be angry.
 */

export class ReportServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not_found'
      | 'not_owner'
      | 'no_transcript'
      | 'insufficient_credits'
      | 'not_entitled'
      | 'version_conflict'
      | 'invalid_content'
      | 'dangling_reference'
      | 'already_final',
  ) {
    super(message)
    this.name = 'ReportServiceError'
  }
}

export type ReportFallbackReason = 'ai_disabled' | 'provider_failed' | 'invalid_output' | 'no_topics'

export type ReportOutcome =
  | { kind: 'generated'; report: InterviewReportRow }
  | { kind: 'template'; report: InterviewReportRow; reason: ReportFallbackReason }
  | { kind: 'no_transcript' }

interface TopicInput {
  id: string
  question: string
}

/**
 * Generates the report for a finished interview.
 *
 * Called after `finishSession` has moved the session to `processing`. It does not require that state,
 * deliberately: a regeneration after an edit is legitimate, and coupling report generation to a one-way
 * transition would make the second attempt impossible.
 */
export async function generateReport(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  params: {
    session: InterviewSessionRow
    /** The organizer's own notes, if they want them considered. Never the candidate's words. */
    organizerNotes?: string | null
    now?: Date
    complete?: typeof sensitiveCompletion
  },
): Promise<ReportOutcome> {
  const now = params.now ?? new Date()
  const complete = params.complete ?? sensitiveCompletion
  const session = params.session

  if (session.ownerUserId !== principal.userId) {
    throw new ReportServiceError('only the interview owner can generate its report', 'not_owner')
  }

  const segments = await listSessionSegments(transaction, {
    organizationId: principal.organizationId,
    sessionId: session.id,
  })
  if (segments.length === 0) {
    // No transcript at all — a manual-only interview, or one whose capture never started. A report with no
    // evidence would be a page of empty sections presented as a record.
    return { kind: 'no_transcript' }
  }

  const brief = await findActiveBrief(transaction, {
    organizationId: principal.organizationId,
    eventId: session.eventId,
  })
  const topics = topicsFrom(brief?.content)
  const evidenceSegmentIds = segments.map((segment) => segment.id)
  const retentionExpiresAt = new Date(now.getTime() + env.INTERVIEW_TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60_000)

  const persistTemplate = async (reason: ReportFallbackReason): Promise<ReportOutcome> => {
    const report = await insertReportVersion(transaction, {
      organizationId: principal.organizationId,
      eventId: session.eventId,
      ownerUserId: principal.userId,
      content: buildFallbackReportTemplate(topics),
      // Still the real evidence list, so the organizer's own citations resolve while they write it up.
      evidenceSegmentIds,
      // No provenance at all: the row says plainly that no model wrote it rather than naming one that
      // did not.
      provider: null,
      model: null,
      promptVersion: null,
      retentionExpiresAt,
    })
    return { kind: 'template', report, reason }
  }

  if (topics.length === 0) {
    // No brief means no topics to answer, and `answersByTopic` is where the report's structure comes from.
    // A template lets the organizer write the record they need without a model inventing a shape for it.
    return persistTemplate('no_topics')
  }
  if (env.SENSITIVE_AI_ENABLED !== 'true') {
    // Before reserving. Charging for a report the switch forbids generating would be indefensible.
    return persistTemplate('ai_disabled')
  }

  const task = getTask('interview-report-generate')
  if (!task) throw new Error('interview-report-generate is not registered')

  const input: InterviewReportTaskInput = {
    roleTitle: brief?.content.candidateSummary.slice(0, 200) || 'this role',
    topics,
    // The tail, if the interview somehow exceeded the window. Losing the *start* of a conversation is worse
    // than losing the end for a brief and better for a report: the closing minutes are where commitments
    // and follow-ups are made.
    segments: segments.slice(-INTERVIEW_REPORT_WINDOW_SEGMENTS).map((segment) => ({
      id: segment.id,
      speaker: speakerLabelFor(segment, session.captureMode),
      startsMs: segment.startsMs,
      text: segment.text,
    })),
    organizerNotes: params.organizerNotes ?? null,
  }

  const parsedInput = task.inputSchema.safeParse(input)
  if (!parsedInput.success) return persistTemplate('invalid_output')

  try {
    const outcome = await withInterviewCredits(
      transaction,
      principal,
      {
        operation: 'report',
        reservationId: randomUUID(),
        // Derived from the session and the version that will be written, so a retried request replays
        // instead of reserving a second five credits for the same report.
        idempotencyKey: `report:${session.id}:${(await findLatestReport(transaction, {
          organizationId: principal.organizationId, eventId: session.eventId,
        }))?.version ?? 0}`,
      },
      async () => {
        const completion = await complete({
          system: task.system,
          prompt: task.buildPrompt(parsedInput.data),
          // Built with this transcript in hand, so a citation to a segment we did not send fails
          // validation rather than reaching a reviewer who clicks it and lands on nothing.
          schema: buildInterviewReportOutputSchema(parsedInput.data),
          maxOutputTokens: task.maxOutputTokens,
        })
        const report = await insertReportVersion(transaction, {
          organizationId: principal.organizationId,
          eventId: session.eventId,
          ownerUserId: principal.userId,
          content: completion.output,
          evidenceSegmentIds,
          provider: completion.provider,
          model: completion.model,
          promptVersion: INTERVIEW_REPORT_PROMPT_VERSION,
          retentionExpiresAt,
        })
        return {
          result: report,
          // Five, because that is what the rate card charges for a report and what was produced. The
          // reservation's own ceiling clamps it regardless.
          actualUnits: 5,
          providerReference: null,
        }
      },
    )
    return { kind: 'generated', report: outcome.result }
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 'insufficient_credits') {
      // Not a template. A report is a deliberate, priced action the organizer asked for, and silently
      // handing them a blank form instead would hide the fact that they need to top up.
      throw new ReportServiceError('not enough credits to generate the report', 'insufficient_credits')
    }
    if (code === 'insufficient_entitlement') {
      throw new ReportServiceError('this plan does not include interview reports', 'not_entitled')
    }
    if (error instanceof ReportServiceError) throw error

    const name = (error as Error)?.name
    // `withInterviewCredits` released the reservation on the way out, so the template costs nothing —
    // which is the point: an organizer handed a blank form and billed for a report would be right to be
    // angry.
    const badOutput = name === 'AIParseError' || name === 'ZodError' || name === 'InterviewBriefError'
    return persistTemplate(badOutput ? 'invalid_output' : 'provider_failed')
  }
}

/**
 * Saves a human edit as a new version.
 *
 * A new version rather than an update, for the same reason briefs are versioned: the report is the artifact
 * a decision is argued from, and silently overwriting what a model wrote would erase the difference between
 * the machine's record and the human's correction.
 *
 * `expectedVersion` is the optimistic guard. Two organizers editing the same report is a real scenario when
 * a panel interviews together.
 */
export async function editReport(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  params: {
    session: InterviewSessionRow
    expectedVersion: number
    content: unknown
    now?: Date
  },
): Promise<InterviewReportRow> {
  const now = params.now ?? new Date()
  if (params.session.ownerUserId !== principal.userId) {
    throw new ReportServiceError('only the interview owner can edit its report', 'not_owner')
  }

  const latest = await findLatestReport(transaction, {
    organizationId: principal.organizationId,
    eventId: params.session.eventId,
  })
  if (!latest) throw new ReportServiceError('there is no report to edit', 'not_found')
  if (latest.version !== params.expectedVersion) {
    throw new ReportServiceError(
      `report is at version ${latest.version}, not ${params.expectedVersion}`,
      'version_conflict',
    )
  }
  if (latest.status === 'final') {
    // A finalized report is the record. Editing it would change what a decision was made from, after the
    // fact — a new interview, or an appended note, is the honest route.
    throw new ReportServiceError('this report is final and cannot be edited', 'already_final')
  }

  const parsed = interviewReportContentSchema.safeParse(params.content)
  if (!parsed.success) throw new ReportServiceError('the edited report is not valid', 'invalid_content')

  try {
    // The same two checks a generated report passes. A hand-edited report is exactly where an unsupported
    // claim would be introduced, so the citation check matters *more* here, not less.
    assertReportCitationsResolve(parsed.data, latest.evidenceSegmentIds)
    assertReportContentIsClean(parsed.data)
  } catch (error) {
    const code = (error as { code?: unknown }).code
    throw new ReportServiceError(
      (error as Error).message,
      code === 'dangling_source' ? 'dangling_reference' : 'invalid_content',
    )
  }

  return insertReportVersion(transaction, {
    organizationId: principal.organizationId,
    eventId: params.session.eventId,
    ownerUserId: principal.userId,
    content: parsed.data,
    // The evidence list is inherited, never taken from the request. An editable evidence list would let a
    // citation be pointed at a segment that was never in the transcript, which is the whole thing the
    // citation check exists to stop.
    evidenceSegmentIds: latest.evidenceSegmentIds,
    // Provenance of the *original* generation is preserved, plus who edited it. A reader deciding how much
    // weight to give the report needs both.
    provider: latest.provider,
    model: latest.model,
    promptVersion: latest.promptVersion,
    editedByUserId: principal.userId,
    retentionExpiresAt: new Date(now.getTime() + env.INTERVIEW_TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60_000),
  })
}

/**
 * Marks a version final.
 *
 * Final means "this is the record". The optimistic version guard stops a panel from finalizing a draft
 * someone else has since replaced, and the repository's `status = 'draft'` predicate stops a second
 * finalize rewriting when the decision was recorded.
 */
export async function finalize(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  params: { session: InterviewSessionRow; expectedVersion: number; now?: Date },
): Promise<InterviewReportRow> {
  if (params.session.ownerUserId !== principal.userId) {
    throw new ReportServiceError('only the interview owner can finalize its report', 'not_owner')
  }

  const latest = await findLatestReport(transaction, {
    organizationId: principal.organizationId,
    eventId: params.session.eventId,
  })
  if (!latest) throw new ReportServiceError('there is no report to finalize', 'not_found')
  if (latest.version !== params.expectedVersion) {
    throw new ReportServiceError(
      `report is at version ${latest.version}, not ${params.expectedVersion}`,
      'version_conflict',
    )
  }
  if (latest.status === 'final') throw new ReportServiceError('this report is already final', 'already_final')

  // Re-checked at the boundary. The content passed on the way in, but the evidence list is what makes a
  // citation resolvable, and finalizing is the last moment anyone will look.
  assertReportCitationsResolve(latest.content, latest.evidenceSegmentIds)

  try {
    return await finalizeReport(transaction, {
      organizationId: principal.organizationId,
      eventId: params.session.eventId,
      version: params.expectedVersion,
      finalizedAt: params.now ?? new Date(),
    })
  } catch (error) {
    if ((error as { code?: unknown }).code === 'version_conflict') {
      throw new ReportServiceError((error as Error).message, 'version_conflict')
    }
    throw error
  }
}

/** The brief's questions as report topics, with the same derived ids the suggestion service uses. */
function topicsFrom(content: unknown): TopicInput[] {
  const groups = (content as { questionGroups?: Array<{ category: string; question: string }> } | null)?.questionGroups
  if (!Array.isArray(groups)) return []
  const rank = { critical: 0, technical: 1, general: 2 } as Record<string, number>
  return [...groups]
    .sort((a, b) => (rank[a.category] ?? 3) - (rank[b.category] ?? 3))
    // Same derivation as `suggestion-service`, so a suggestion citing `topic:2` and a report answering
    // `topic:2` mean the same topic. Two independent numberings would silently disagree.
    .map((group, index) => ({ id: `topic:${index + 1}`, question: group.question }))
}

function speakerLabelFor(
  segment: { speakerEstimate: string; speakerMapping: string | null },
  captureMode: string,
): string {
  if (segment.speakerMapping === 'organizer') return 'Interviewer'
  if (segment.speakerMapping === 'candidate_or_remote') return 'Candidate'
  if (captureMode === 'remote_call') {
    if (segment.speakerEstimate === 'speaker_a') return 'Interviewer'
    if (segment.speakerEstimate === 'speaker_b') return 'Candidate'
  }
  if (segment.speakerEstimate === 'speaker_a') return 'Speaker A'
  if (segment.speakerEstimate === 'speaker_b') return 'Speaker B'
  return 'Unattributed'
}
