import {
  buildInterviewFollowupOutputSchema,
  getTask,
  INTERVIEW_FOLLOWUP_PROMPT_VERSION,
  INTERVIEW_FOLLOWUP_THROTTLE_SECONDS,
  INTERVIEW_FOLLOWUP_WINDOW_SEGMENTS,
  type InterviewFollowupTaskInput,
} from '~/shared/lib/ai/tasks'
import { sensitiveCompletion } from '~/shared/lib/ai/sensitive'
import { authorizeContextualQuestion } from '~/modules/interviews/billing'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import type { TenantTransaction } from '~/shared/lib/db/client'
import { env } from '~/shared/lib/env'
import type { InterviewFollowupSuggestion } from '~/shared/lib/interviews'
import {
  findActiveBrief,
  insertSuggestion,
  listSessionSegments,
  listSuggestions,
  updateSuggestionState,
  type InterviewSessionRow,
} from '~/shared/lib/repositories/interviews'

/**
 * Contextual follow-up questions during a live interview (plan:
 * calendar-scheduling-interview-intelligence, Phase 10).
 *
 * ## A proposal leaves no trace unless the organizer acts on it
 *
 * spec.md: "The result is ephemeral unless explicitly saved or used." So this service *returns*
 * suggestions and writes nothing. A row appears only when the organizer says they used one, saved one, or
 * dismissed one — and a dismissal is recorded solely so the same question is not proposed again.
 *
 * That is not a storage optimisation. A model asked "what should I follow up on" during an interview
 * produces things the organizer glanced at and rejected, and a table of every rejected question about a
 * named candidate is a record of impressions nobody agreed to keep.
 *
 * ## Failure is silent, and silence means the prepared questions
 *
 * Every degradation path — throttled, no new speech, provider down, switch off, not entitled, paused —
 * returns the brief's *pending prepared questions* instead. An organizer mid-conversation cannot read an
 * error, and the useful fallback is the list they already prepared. `reason` is returned so the UI can be
 * quiet about it rather than showing a failure.
 *
 * ## Included, but only while paid transcription is running
 *
 * `authorizeContextualQuestion` enforces both halves: the tier must include the feature, and a
 * transcription reservation must be active. The second half is what stops a free-riding pattern of
 * finishing the session and then mining the transcript for questions at zero cost.
 */

export type SuggestionOutcome =
  | { kind: 'suggested'; suggestions: InterviewFollowupSuggestion[]; provider: string; model: string }
  | { kind: 'prepared'; suggestions: InterviewFollowupSuggestion[]; reason: DegradeReason }

export type DegradeReason =
  | 'throttled'
  | 'no_new_speech'
  | 'not_live'
  | 'ai_disabled'
  | 'not_entitled'
  | 'transcription_not_active'
  | 'provider_failed'
  | 'invalid_output'
  | 'no_brief'

export interface TopicState {
  id: string
  question: string
  rationale: string
  covered: boolean
}

/** In-memory per-session throttle state. One entry per live session, cleared when it finishes. */
export interface ThrottleState {
  lastRequestedAt: number
  lastSegmentId: string | null
  /** Set while a request is in flight, so two clicks produce one provider call. */
  inFlight: boolean
}

const throttleBySession = new Map<string, ThrottleState>()

/** Exported for tests and for the finish path, which must not leave state behind for a reused id. */
export function clearSuggestionThrottle(sessionId: string): void {
  throttleBySession.delete(sessionId)
}

export function suggestionThrottleState(sessionId: string): ThrottleState | undefined {
  return throttleBySession.get(sessionId)
}

/**
 * Derives which prepared topics have been discussed.
 *
 * Deliberately crude — a token-overlap heuristic, not a model call. Two reasons: asking a model which
 * topics are covered would cost a second sensitive completion per request for a hint, and a *wrong*
 * "covered" is cheap here (the topic is deprioritised, not deleted) while a wrong answer in the report
 * would be a fabrication.
 *
 * The organizer sees the pending list and can ignore it.
 */
export function deriveTopicCoverage(params: {
  topics: ReadonlyArray<{ id: string; question: string; rationale: string }>
  segments: ReadonlyArray<{ text: string }>
}): TopicState[] {
  const spoken = params.segments.map((segment) => segment.text.toLowerCase()).join(' ')
  return params.topics.map((topic) => ({
    ...topic,
    covered: coveredBy(topic.question, spoken),
  }))
}

/** Content words only, and at least half of them, so "Tell me about X" is not matched by "tell me". */
function coveredBy(question: string, spoken: string): boolean {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word))
  if (words.length === 0) return false
  const hits = words.filter((word) => spoken.includes(word)).length
  return hits / words.length >= 0.5
}

const STOP_WORDS = new Set([
  'tell', 'about', 'what', 'when', 'where', 'which', 'would', 'could', 'should', 'have', 'this',
  'that', 'they', 'them', 'your', 'been', 'were', 'with', 'from', 'into', 'more', 'most', 'much',
  'work', 'like', 'make', 'made', 'does', 'done', 'time',
])

export interface SuggestParams {
  session: InterviewSessionRow
  now?: Date
  /** Injected in tests; production uses the real sensitive boundary. */
  complete?: typeof sensitiveCompletion
}

/**
 * Asks for up to three follow-ups, or returns the prepared questions.
 *
 * The order of the gates is the whole design: cheap local checks first, then entitlement, then the
 * provider. A throttled request must not consult the billing platform, and a session with no new speech
 * must not reach either — the commonest reason to ask twice is impatience, and the answer would be the
 * same completion at full cost.
 */
export async function suggestFollowups(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  params: SuggestParams,
): Promise<SuggestionOutcome> {
  const now = params.now ?? new Date()
  const session = params.session
  const complete = params.complete ?? sensitiveCompletion

  const brief = await findActiveBrief(transaction, {
    organizationId: principal.organizationId,
    eventId: session.eventId,
  })
  const prepared = preparedQuestionsFrom(brief?.content)

  // Paused or finished. A suggestion about what was just said is meaningless when nothing is being said,
  // and a paused session has told the candidate that capture stopped.
  if (session.state !== 'live') return degrade(prepared, 'not_live')

  const allSegments = await listSessionSegments(transaction, {
    organizationId: principal.organizationId,
    sessionId: session.id,
  })
  if (allSegments.length === 0) return degrade(prepared, 'no_new_speech')

  // The recent tail, oldest-first within the window so the model reads the conversation in order.
  const window = allSegments.slice(-INTERVIEW_FOLLOWUP_WINDOW_SEGMENTS)
  const newest = window[window.length - 1]

  const throttle = throttleBySession.get(session.id)
  if (throttle) {
    if (throttle.inFlight) {
      // Two clicks, one provider call. Without this the second request pays for a completion the organizer
      // will never see, because the first one's answer arrives and replaces it.
      return degrade(prepared, 'throttled')
    }
    const elapsedSeconds = (now.getTime() - throttle.lastRequestedAt) / 1_000
    if (elapsedSeconds < INTERVIEW_FOLLOWUP_THROTTLE_SECONDS) return degrade(prepared, 'throttled')
    if (throttle.lastSegmentId === newest.id) {
      // Nothing has been said since the last answer. The same window produces the same suggestions, so
      // this would be a paid restatement.
      return degrade(prepared, 'no_new_speech')
    }
  }

  if (env.SENSITIVE_AI_ENABLED !== 'true') return degrade(prepared, 'ai_disabled')
  if (!brief) {
    // No prepared topics means no topic ids to attribute a suggestion to, and the output schema requires
    // one. Degrading here is honest; sending an empty topic list would guarantee a validation failure.
    return degrade(prepared, 'no_brief')
  }

  try {
    await authorizeContextualQuestion(transaction, principal, {
      // The session being live *is* the active reservation: `goLive` takes it and nothing else sets this
      // state. Reading a reservation row here would be a second source of truth for the same fact.
      transcriptionReservationActive: true,
    })
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return degrade(prepared, code === 'transcription_not_active' ? 'transcription_not_active' : 'not_entitled')
  }

  const topics = deriveTopicCoverage({ topics: prepared, segments: window })
  const task = getTask('interview-followup-suggest')
  if (!task) throw new Error('interview-followup-suggest is not registered')

  const input: InterviewFollowupTaskInput = {
    roleTitle: brief.content.candidateSummary.slice(0, 200) || 'this role',
    topics: topics.map((topic) => ({ id: topic.id, question: topic.question, covered: topic.covered })),
    segments: window.map((segment) => ({
      id: segment.id,
      // The label, never the raw estimate: `speaker_a` means nothing to a model, and a confirmed mapping
      // is better information than the guess it replaced.
      speaker: speakerLabelFor(segment, session.captureMode),
      text: segment.text,
    })),
  }

  const parsedInput = task.inputSchema.safeParse(input)
  if (!parsedInput.success) return degrade(prepared, 'invalid_output')

  const state: ThrottleState = { lastRequestedAt: now.getTime(), lastSegmentId: newest.id, inFlight: true }
  throttleBySession.set(session.id, state)

  try {
    const completion = await complete({
      system: task.system,
      prompt: task.buildPrompt(parsedInput.data),
      // Built with this window in hand, so a citation to a segment we did not send fails validation
      // rather than reaching an organizer who clicks it and lands on nothing.
      schema: buildInterviewFollowupOutputSchema(parsedInput.data),
      maxOutputTokens: task.maxOutputTokens,
    })
    return {
      kind: 'suggested',
      suggestions: [...completion.output.questions],
      provider: completion.provider,
      model: completion.model,
    }
  } catch (error) {
    // Silent by design. The organizer is mid-sentence; the useful answer is the list they prepared, and
    // the distinction between "provider down" and "output invalid" matters only to a log.
    const name = (error as Error)?.name
    // `ZodError` as well as `AIParseError`: the sensitive boundary validates with `safeParse` and reports
    // `AIParseError`, but a schema thrown from anywhere else in the chain is still a bad *output* rather
    // than a provider outage — and the two lead a log in opposite directions.
    const badOutput = name === 'AIParseError' || name === 'ZodError'
    return degrade(prepared, badOutput ? 'invalid_output' : 'provider_failed')
  } finally {
    // Cleared even on failure, so one provider outage does not lock the session out of asking again. The
    // timestamp stays, which is what keeps the thirty-second floor in force.
    state.inFlight = false
  }
}

function degrade(prepared: TopicState[] | InterviewFollowupSuggestion[], reason: DegradeReason): SuggestionOutcome {
  return {
    kind: 'prepared',
    // The pending ones first, and never more than three, so the panel looks the same whether the model
    // answered or not. A fallback that looked different would tell the candidate something went wrong.
    suggestions: (prepared as TopicState[])
      .filter((topic) => 'covered' in topic ? !topic.covered : true)
      .slice(0, 3)
      .map((topic) => ({
        id: topic.id,
        topicId: topic.id,
        question: (topic as TopicState).question,
        rationale: (topic as TopicState).rationale,
        // No segments: a prepared question responds to nothing that was said, and pretending otherwise
        // would put a citation on a question written before the interview began.
        segmentIds: [],
      })),
    reason,
  }
}

/** The brief's critical and technical questions, which are what a follow-up panel should fall back to. */
function preparedQuestionsFrom(content: unknown): TopicState[] {
  const groups = (content as { questionGroups?: Array<{ category: string; question: string; rationale: string }> } | null)?.questionGroups
  if (!Array.isArray(groups)) return []
  const rank = { critical: 0, technical: 1, general: 2 } as Record<string, number>
  return [...groups]
    .sort((a, b) => (rank[a.category] ?? 3) - (rank[b.category] ?? 3))
    .map((group, index) => ({
      // Stable and derived, so the same brief always yields the same topic ids — which is what lets a
      // suggestion cite a topic and a later report resolve it.
      id: `topic:${index + 1}`,
      question: group.question,
      rationale: group.rationale,
      covered: false,
    }))
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
  // In-person diarization, or an unattributed line. `Speaker A` rather than a guess at a role: telling the
  // model the candidate said something the interviewer said would produce a follow-up aimed at nobody.
  if (segment.speakerEstimate === 'speaker_a') return 'Speaker A'
  if (segment.speakerEstimate === 'speaker_b') return 'Speaker B'
  return 'Unattributed'
}

/**
 * Records that the organizer acted on a suggestion.
 *
 * This is the only write in this module. `used` and `saved` are kept because the organizer chose to keep
 * them; `dismissed` is kept only so the same question is not proposed again.
 */
export async function recordSuggestionAction(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  params: {
    session: InterviewSessionRow
    suggestion: InterviewFollowupSuggestion
    action: 'used' | 'saved' | 'dismissed'
    retentionExpiresAt: Date
  },
): Promise<{ id: string; state: string }> {
  const row = await insertSuggestion(transaction, {
    organizationId: principal.organizationId,
    sessionId: params.session.id,
    question: params.suggestion.question,
    rationale: params.suggestion.rationale,
    evidenceSegmentIds: params.suggestion.segmentIds,
    state: params.action,
    promptVersion: INTERVIEW_FOLLOWUP_PROMPT_VERSION,
    retentionExpiresAt: params.retentionExpiresAt,
  })
  return { id: row.id, state: row.state }
}

/** Changes the state of a suggestion already recorded — "saved, then actually asked it". */
export async function changeSuggestionState(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  params: {
    session: InterviewSessionRow
    suggestionId: string
    action: 'used' | 'saved' | 'dismissed'
  },
): Promise<{ id: string; state: string } | null> {
  const row = await updateSuggestionState(transaction, {
    organizationId: principal.organizationId,
    sessionId: params.session.id,
    suggestionId: params.suggestionId,
    state: params.action,
  })
  return row ? { id: row.id, state: row.state } : null
}

/** What the organizer kept, for the report to consider and the workspace to show. */
export async function listRecordedSuggestions(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  sessionId: string,
) {
  return listSuggestions(transaction, { organizationId: principal.organizationId, sessionId })
}
