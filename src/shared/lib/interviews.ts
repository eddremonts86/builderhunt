/**
 * Interview domain contracts, state machines, and prohibited-output validation (plan:
 * calendar-scheduling-interview-intelligence, spec.md "Data model" → "Documents and interviews",
 * "State contracts" → Document/Interview, "Live capture contract", and "AI task contracts").
 * Pure — no I/O. Reuses `interview-config.ts`'s capture-mode/capability enums and
 * `scheduling.ts`'s consent-purpose contracts rather than redefining them.
 *
 * spec.md scope explicitly excludes "automated candidate scores, ranks, hire/reject
 * recommendations, personality inference, emotion recognition, voice identification, or
 * culture-fit analysis" — `assertNoProhibitedInterviewContent` is the mechanical backstop for
 * that exclusion, applied to every AI-generated report/brief before it is ever persisted or shown.
 */
import { z } from 'zod'
import { INTERVIEW_CAPTURE_CAPABILITIES, INTERVIEW_CAPTURE_MODES, INTERVIEW_SUPPORTED_LANGUAGES } from './interview-config'

export class InterviewDomainError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'InterviewDomainError'
  }
}

// ── Document state machine (spec.md "State contracts" → Document) ───────────────────────────

export const DOCUMENT_STATUSES = ['pending_upload', 'uploaded', 'scanning', 'extracting', 'ready', 'rejected', 'failed'] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

const DOCUMENT_STATUS_TRANSITIONS: Record<DocumentStatus, readonly DocumentStatus[]> = {
  pending_upload: ['uploaded', 'failed'],
  uploaded: ['scanning', 'rejected', 'failed'],
  scanning: ['extracting', 'rejected', 'failed'],
  extracting: ['ready', 'rejected', 'failed'],
  ready: [],
  rejected: [],
  failed: [],
}

export function assertValidDocumentStatusTransition(from: DocumentStatus, to: DocumentStatus): void {
  if (!DOCUMENT_STATUS_TRANSITIONS[from].includes(to)) {
    throw new InterviewDomainError(`Cannot transition a candidate document from '${from}' to '${to}'`, 'invalid_state_transition')
  }
}

/**
 * Collapses the two storage columns into the one status a candidate or organizer sees.
 *
 * `candidate_documents` tracks scanning and extraction separately because they fail separately and
 * retry separately. Nobody outside the worker needs that: a candidate wants to know whether their CV
 * is still processing, usable, or refused. Deriving the answer — rather than storing a third status
 * column alongside the two real ones — means the DTO cannot drift out of step with the rows.
 *
 * The bias is deliberately toward *not* claiming readiness. Anything unrecognised reports `failed`,
 * because a status the caller invented a reading for is how "we do not know" becomes "it is fine".
 */
export function deriveDocumentStatus(input: {
  scanStatus: string
  extractionStatus: string
}): DocumentStatus {
  switch (input.scanStatus) {
    case 'awaiting_upload': return 'pending_upload'
    case 'pending': return 'uploaded'
    case 'scanning': return 'scanning'
    case 'infected': return 'rejected'
    case 'failed': return 'failed'
    case 'clean':
      switch (input.extractionStatus) {
        case 'pending':
        case 'running': return 'extracting'
        case 'succeeded': return 'ready'
        // `skipped` on a clean document should not occur — the worker only skips extraction when it
        // rejects a scan — but the document itself passed and is downloadable, so readiness is the
        // honest answer rather than a failure the candidate cannot act on.
        case 'skipped': return 'ready'
        default: return 'failed'
      }
    default: return 'failed'
  }
}

export const candidateDocumentSchema = z.object({
  id: z.string().uuid(),
  submissionId: z.string().uuid(),
  originalName: z.string().min(1).max(255),
  declaredMediaType: z.string().min(1),
  detectedMediaType: z.string().min(1).nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i).nullable(),
  bytes: z.number().int().positive(),
  status: z.enum(DOCUMENT_STATUSES),
  rejectionCode: z.string().nullable(),
  retentionExpiresAt: z.string().datetime(),
}).strict().refine(
  (doc) => doc.status !== 'rejected' || doc.rejectionCode !== null,
  { message: 'a rejected document must carry a rejectionCode', path: ['rejectionCode'] },
)
export type CandidateDocument = z.infer<typeof candidateDocumentSchema>

const documentSectionMapEntrySchema = z.object({
  page: z.number().int().positive().optional(),
  section: z.string().min(1).optional(),
  offset: z.number().int().nonnegative(),
}).strict()

export const documentExtractionSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  parserVersion: z.string().min(1),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/i),
  text: z.string(),
  sectionMap: z.array(documentSectionMapEntrySchema),
  errorCode: z.string().nullable(),
}).strict()
export type DocumentExtraction = z.infer<typeof documentExtractionSchema>

// ── Interview session state machine (spec.md "State contracts" → Interview) ─────────────────

export const INTERVIEW_SESSION_STATES = [
  'not_started', 'consent_pending', 'ready', 'live', 'processing', 'review', 'finalized', 'paused', 'failed', 'abandoned',
] as const
export type InterviewSessionState = (typeof INTERVIEW_SESSION_STATES)[number]

const INTERVIEW_SESSION_STATE_TRANSITIONS: Record<InterviewSessionState, readonly InterviewSessionState[]> = {
  not_started: ['consent_pending', 'abandoned'],
  consent_pending: ['ready', 'abandoned'],
  ready: ['live', 'abandoned'],
  live: ['processing', 'paused', 'failed', 'abandoned'],
  processing: ['review', 'failed', 'abandoned'],
  review: ['finalized', 'failed', 'abandoned'],
  paused: ['live', 'abandoned', 'failed'],
  finalized: [],
  failed: [],
  abandoned: [],
}

export function assertValidInterviewSessionTransition(from: InterviewSessionState, to: InterviewSessionState): void {
  if (!INTERVIEW_SESSION_STATE_TRANSITIONS[from].includes(to)) {
    throw new InterviewDomainError(`Cannot transition an interview session from '${from}' to '${to}'`, 'invalid_state_transition')
  }
}

export const SPEAKER_ESTIMATES = ['speaker_a', 'speaker_b', 'unknown'] as const
export type SpeakerEstimate = (typeof SPEAKER_ESTIMATES)[number]

/** spec.md "Live capture contract": channel 0 = organizer, channel 1 = candidate_or_remote. `null` until an organizer corrects/confirms the mapping. */
export const SPEAKER_MAPPINGS = ['organizer', 'candidate_or_remote'] as const
export type SpeakerMapping = (typeof SPEAKER_MAPPINGS)[number]

export const interviewSessionSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  ownerUserId: z.string().min(1),
  state: z.enum(INTERVIEW_SESSION_STATES),
  captureMode: z.enum(INTERVIEW_CAPTURE_MODES),
  language: z.enum(INTERVIEW_SUPPORTED_LANGUAGES),
  provider: z.string().min(1),
  consentNoticeVersion: z.string().min(1),
  browserName: z.string().min(1).nullable(),
  browserMajor: z.string().min(1).nullable(),
  captureCapability: z.enum(INTERVIEW_CAPTURE_CAPABILITIES),
  startedAt: z.string().datetime().nullable(),
  pausedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  heartbeatAt: z.string().datetime().nullable(),
  providerRequestId: z.string().nullable(),
  providerBilledSeconds: z.number().int().nonnegative(),
  version: z.number().int().positive(),
}).strict()
export type InterviewSession = z.infer<typeof interviewSessionSchema>

// ── Transcript segments (spec.md: "stable provider segment ID, sequence, speaker estimate/mapping") ─

export const transcriptSegmentSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  providerSegmentId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  speakerEstimate: z.enum(SPEAKER_ESTIMATES),
  speakerMapping: z.enum(SPEAKER_MAPPINGS).nullable(),
  text: z.string(),
  startsMs: z.number().int().nonnegative(),
  endsMs: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1).nullable(),
  correctedByUserId: z.string().nullable(),
  correctedAt: z.string().datetime().nullable(),
  retentionExpiresAt: z.string().datetime(),
}).strict()
  .refine((segment) => segment.endsMs > segment.startsMs, { message: 'endsMs must be after startsMs', path: ['endsMs'] })
  .refine(
    (segment) => (segment.correctedByUserId === null) === (segment.correctedAt === null),
    { message: 'correctedByUserId and correctedAt must be set together (correction audit)', path: ['correctedAt'] },
  )
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>

/**
 * DB-level uniqueness (`unique session/provider segment` and `unique session/sequence`) modeled
 * here as a pure batch invariant, since a single-row schema can't express a cross-row constraint.
 */
export function assertNoDuplicateSegments(segments: readonly Pick<TranscriptSegment, 'sessionId' | 'providerSegmentId' | 'sequence'>[]): void {
  const seenByProviderId = new Set<string>()
  const seenBySequence = new Set<string>()
  for (const segment of segments) {
    const providerKey = `${segment.sessionId}|${segment.providerSegmentId}`
    if (seenByProviderId.has(providerKey)) {
      throw new InterviewDomainError(`Duplicate provider segment ID within session ${segment.sessionId}`, 'duplicate_segment_id')
    }
    seenByProviderId.add(providerKey)

    const sequenceKey = `${segment.sessionId}|${segment.sequence}`
    if (seenBySequence.has(sequenceKey)) {
      throw new InterviewDomainError(`Duplicate segment sequence within session ${segment.sessionId}`, 'duplicate_sequence')
    }
    seenBySequence.add(sequenceKey)
  }
}

// ── Evidence reference integrity (spec.md: "Every factual claim requires source IDs") ───────

/** Throws on any segment ID referenced by evidence that isn't in the session's actual segment set — never a silent dangling reference. */
export function assertNoDanglingSegmentEvidence(referencedSegmentIds: readonly string[], knownSegmentIds: ReadonlySet<string>): void {
  for (const id of referencedSegmentIds) {
    if (!knownSegmentIds.has(id)) {
      throw new InterviewDomainError(`Evidence references unknown segment ID: ${id}`, 'dangling_evidence')
    }
  }
}

// ── Source manifest (spec.md "AI task contracts" → interview-brief-generate input) ──────────

export const SOURCE_KINDS = ['document', 'approved_web', 'public_profile', 'submitted_link'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

const sourceLocationSchema = z.object({
  page: z.number().int().positive().optional(),
  section: z.string().min(1).optional(),
  url: z.string().url().optional(),
}).strict()

/** Only `document`/`approved_web`/approved `public_profile` may carry factual `text` — a restricted `submitted_link` carries URL/label only (spec.md). */
export const sourceManifestEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(SOURCE_KINDS),
  label: z.string().min(1),
  text: z.string().optional(),
  location: sourceLocationSchema.optional(),
}).strict().refine(
  (source) => source.kind !== 'submitted_link' || source.text === undefined,
  { message: "a restricted 'submitted_link' source cannot carry factual text", path: ['text'] },
)
export type SourceManifestEntry = z.infer<typeof sourceManifestEntrySchema>

/** Throws on any sourceId referenced by a claim/question that isn't in the brief's own source manifest. */
export function assertNoDanglingSourceReference(referencedSourceIds: readonly string[], manifest: readonly SourceManifestEntry[]): void {
  const knownIds = new Set(manifest.map((entry) => entry.id))
  for (const id of referencedSourceIds) {
    if (!knownIds.has(id)) {
      throw new InterviewDomainError(`Evidence references unknown source ID: ${id}`, 'dangling_evidence')
    }
  }
}

// ── Prohibited-output validation (spec.md scope exclusions + "AI task contracts") ───────────

/**
 * Matches score/rank/personality/emotion/culture-fit/hire-reject language and common protected-
 * trait-proxy phrasing. Deliberately broad (word-boundary, case-insensitive) — a false positive
 * forces a human look at AI-generated interview content, which is the safe failure direction here.
 */
const PROHIBITED_OUTPUT_PATTERNS: RegExp[] = [
  /\bscor(e|es|ed|ing)\b/i,
  /\brank(s|ed|ing)?\b/i,
  /\bpersonality\b/i,
  /\bemotion(al)?\b/i,
  /\bculture[\s-]?fit\b/i,
  /\bhire\b/i,
  /\breject(ed|ion)?\b/i,
  /\brecommend(ation|ed)?\s+(to\s+)?(hire|reject)\b/i,
  /\bculture[\s-]?add\b/i,
]

export interface ProhibitedContentFinding {
  pattern: string
  excerpt: string
}

/** Scans free text for prohibited output patterns. Returns findings rather than throwing so a caller can decide (block, log, force a repair attempt) — the boundary decision belongs to the route, not this pure check. */
export function findProhibitedInterviewContent(text: string): ProhibitedContentFinding[] {
  const findings: ProhibitedContentFinding[] = []
  for (const pattern of PROHIBITED_OUTPUT_PATTERNS) {
    const match = text.match(pattern)
    if (match) {
      findings.push({ pattern: pattern.source, excerpt: match[0] })
    }
  }
  return findings
}

/** Throws if any prohibited pattern is found anywhere in `text` — the hard gate applied before any AI-generated report/brief content is persisted or shown. */
export function assertNoProhibitedInterviewContent(text: string): void {
  const findings = findProhibitedInterviewContent(text)
  if (findings.length > 0) {
    throw new InterviewDomainError(
      `Prohibited interview-output content detected: ${findings.map((f) => f.excerpt).join(', ')}`,
      'prohibited_output',
    )
  }
}

// ── Interview brief (spec.md "AI task contracts" → interview-brief-generate) ────────────────

const confidenceLevelSchema = z.enum(['low', 'medium', 'high'])

export const interviewBriefContentSchema = z.object({
  candidateSummary: z.string().min(1),
  relevantEvidence: z.array(z.object({
    claim: z.string().min(1),
    sourceIds: z.array(z.string().min(1)).min(1),
    confidence: confidenceLevelSchema,
  }).strict()),
  informationGaps: z.array(z.string().min(1)),
  contradictions: z.array(z.object({
    description: z.string().min(1),
    sourceIds: z.array(z.string().min(1)).min(1),
  }).strict()),
  questionGroups: z.array(z.object({
    category: z.enum(['general', 'technical', 'critical']),
    question: z.string().min(1),
    rationale: z.string().min(1),
    sourceIds: z.array(z.string().min(1)),
  }).strict()),
}).strict()
export type InterviewBriefContent = z.infer<typeof interviewBriefContentSchema>

export const INTERVIEW_BRIEF_STATUSES = ['draft', 'active', 'superseded'] as const
export type InterviewBriefStatus = (typeof INTERVIEW_BRIEF_STATUSES)[number]

export const interviewBriefSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  ownerUserId: z.string().min(1),
  version: z.number().int().positive(),
  status: z.enum(INTERVIEW_BRIEF_STATUSES),
  content: interviewBriefContentSchema,
  evidenceManifest: z.array(sourceManifestEntrySchema),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  editedByUserId: z.string().nullable(),
  retentionExpiresAt: z.string().datetime(),
}).strict()
export type InterviewBrief = z.infer<typeof interviewBriefSchema>

/** Validates every claim/question sourceId against the brief's own evidence manifest — no dangling references. */
export function assertBriefEvidenceIntegrity(brief: Pick<InterviewBrief, 'content' | 'evidenceManifest'>): void {
  const allReferences = [
    ...brief.content.relevantEvidence.flatMap((e) => e.sourceIds),
    ...brief.content.contradictions.flatMap((c) => c.sourceIds),
    ...brief.content.questionGroups.flatMap((q) => q.sourceIds),
  ]
  assertNoDanglingSourceReference(allReferences, brief.evidenceManifest)
}

// ── Interview suggestions (spec.md "AI task contracts" → interview-followup-suggest) ────────

export const INTERVIEW_SUGGESTION_STATES = ['proposed', 'used', 'saved', 'dismissed'] as const
export type InterviewSuggestionState = (typeof INTERVIEW_SUGGESTION_STATES)[number]

export const interviewFollowupSuggestionSchema = z.object({
  id: z.string().min(1),
  topicId: z.string().min(1),
  question: z.string().min(1),
  rationale: z.string().min(1),
  segmentIds: z.array(z.string().min(1)),
}).strict()
export type InterviewFollowupSuggestion = z.infer<typeof interviewFollowupSuggestionSchema>

/** spec.md: "Output ... questions ... max 3." "The result is ephemeral unless explicitly saved or used." */
export const interviewFollowupSuggestOutputSchema = z.object({
  questions: z.array(interviewFollowupSuggestionSchema).max(3),
}).strict()
export type InterviewFollowupSuggestOutput = z.infer<typeof interviewFollowupSuggestOutputSchema>

export const persistedInterviewSuggestionSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  question: z.string().min(1),
  rationale: z.string().min(1),
  evidenceSegmentIds: z.array(z.string().uuid()),
  state: z.enum(INTERVIEW_SUGGESTION_STATES),
  promptVersion: z.string().min(1),
  createdAt: z.string().datetime(),
}).strict()
export type PersistedInterviewSuggestion = z.infer<typeof persistedInterviewSuggestionSchema>

// ── Interview report (spec.md "AI task contracts" → interview-report-generate) ──────────────

export const INTERVIEW_REPORT_STATUSES = ['draft', 'final'] as const
export type InterviewReportStatus = (typeof INTERVIEW_REPORT_STATUSES)[number]

export const interviewReportContentSchema = z.object({
  summary: z.array(z.object({
    statement: z.string().min(1),
    segmentIds: z.array(z.string().min(1)),
  }).strict()),
  answersByTopic: z.array(z.object({
    topicId: z.string().min(1),
    answer: z.string().min(1),
    segmentIds: z.array(z.string().min(1)),
    status: z.enum(['answered', 'partial', 'unanswered']),
  }).strict()),
  openQuestions: z.array(z.string().min(1)),
  followUps: z.array(z.object({
    action: z.string().min(1),
    owner: z.string().min(1).optional(),
    segmentIds: z.array(z.string().min(1)),
  }).strict()),
}).strict()
export type InterviewReportContent = z.infer<typeof interviewReportContentSchema>

export const interviewReportSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  version: z.number().int().positive(),
  status: z.enum(INTERVIEW_REPORT_STATUSES),
  content: interviewReportContentSchema,
  evidenceSegmentIds: z.array(z.string().uuid()),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  editedByUserId: z.string().nullable(),
  finalizedAt: z.string().datetime().nullable(),
  retentionExpiresAt: z.string().datetime(),
}).strict().refine(
  (report) => (report.status === 'final') === (report.finalizedAt !== null),
  { message: 'finalizedAt must be set exactly when status is final', path: ['finalizedAt'] },
)
export type InterviewReport = z.infer<typeof interviewReportSchema>

/** Runs every content field's free text through the prohibited-output gate before a report is ever persisted or shown. */
export function assertReportContentIsClean(content: InterviewReportContent): void {
  for (const entry of content.summary) assertNoProhibitedInterviewContent(entry.statement)
  for (const entry of content.answersByTopic) assertNoProhibitedInterviewContent(entry.answer)
  for (const question of content.openQuestions) assertNoProhibitedInterviewContent(question)
  for (const followUp of content.followUps) assertNoProhibitedInterviewContent(followUp.action)
}

// ── Deterministic fallback templates (spec.md: "persistent failure returns a deterministic editable template") ─

/** No randomness, no wall-clock read — the same topic list always produces the exact same template, so a caller can safely retry/compare without surprises. */
export function buildFallbackReportTemplate(topics: readonly { id: string }[]): InterviewReportContent {
  return {
    summary: [{ statement: 'AI-generated summary is unavailable. Please complete this section manually.', segmentIds: [] }],
    // Not an empty string. `interviewReportContentSchema` requires `answer` to be non-empty, so the
    // template as written could not be persisted — the fallback would have failed at exactly the moment the
    // provider did, which is the one moment it exists for. `tests/unit/shared/lib/interviews.test.ts`
    // asserts the template validates against its own schema.
    answersByTopic: topics.map((topic) => ({
      topicId: topic.id,
      answer: 'Not written up. Add what was said, or leave this topic as unanswered.',
      segmentIds: [],
      status: 'unanswered' as const,
    })),
    openQuestions: [],
    followUps: [],
  }
}

export function buildFallbackBriefTemplate(): InterviewBriefContent {
  return {
    candidateSummary: 'AI-generated candidate summary is unavailable. Please complete this section manually.',
    relevantEvidence: [],
    informationGaps: [],
    contradictions: [],
    questionGroups: [],
  }
}
