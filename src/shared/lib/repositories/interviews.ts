import { and, desc, eq, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import type { WorkerTransaction } from '../db/worker-db'
import { interviewBriefs, interviewSessions, transcriptSegments } from '../db/schema'
import {
  assertNoDanglingSourceReference,
  interviewBriefContentSchema,
  sourceManifestEntrySchema,
  type InterviewBriefContent,
  type SourceManifestEntry,
} from '../interviews'

/**
 * Interview brief persistence (plan: calendar-scheduling-interview-intelligence, Phase 8).
 *
 * ## Nothing unvalidated reaches the column
 *
 * `content` and `evidence_manifest` are `jsonb`, which will accept anything. Every write here parses
 * against `interviewBriefContentSchema` and `sourceManifestEntrySchema` first, and cross-checks that
 * every `sourceId` the content cites is present in the manifest being stored alongside it. A brief whose
 * citations point at sources the row does not carry is worse than an unvalidated one: the UI renders a
 * confident-looking reference that resolves to nothing, and nobody can tell whether the source was
 * removed or never existed.
 *
 * ## Versions are inserted, never overwritten
 *
 * `interview_briefs_event_version_unique` is what makes that safe: two concurrent generations cannot
 * both claim version 3, so the loser gets a constraint violation instead of silently replacing the
 * winner's text. `insertBriefVersion` therefore reads the current maximum and inserts in one statement
 * rather than reading, incrementing in JS, and writing — which would leave exactly that window open.
 */

export type BriefTransaction = TenantTransaction | WorkerTransaction

export interface InterviewBriefRow {
  id: string
  organizationId: string
  eventId: string
  ownerUserId: string
  version: number
  status: string
  content: InterviewBriefContent
  evidenceManifest: SourceManifestEntry[]
  provider: string | null
  model: string | null
  promptVersion: string | null
  editedByUserId: string | null
  retentionExpiresAt: Date
}

export class InterviewBriefError extends Error {
  constructor(message: string, readonly code: 'invalid_content' | 'invalid_manifest' | 'dangling_source' | 'version_conflict' | 'not_found') {
    super(message)
    this.name = 'InterviewBriefError'
  }
}

/**
 * Validates a content/manifest pair as one unit.
 *
 * Separately valid halves are not enough: the interesting failure is a well-formed brief citing a
 * well-formed manifest that does not contain the ids it cites.
 */
function validatePair(content: unknown, manifest: unknown): { content: InterviewBriefContent; manifest: SourceManifestEntry[] } {
  const parsedManifest = sourceManifestEntrySchema.array().safeParse(manifest)
  if (!parsedManifest.success) {
    throw new InterviewBriefError(
      `evidence manifest is invalid at: ${parsedManifest.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
      'invalid_manifest',
    )
  }
  const parsedContent = interviewBriefContentSchema.safeParse(content)
  if (!parsedContent.success) {
    // Paths, not values: the message reaches logs and the values are candidate material.
    throw new InterviewBriefError(
      `brief content is invalid at: ${parsedContent.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
      'invalid_content',
    )
  }

  const referenced = [
    ...parsedContent.data.relevantEvidence.flatMap((entry) => entry.sourceIds),
    ...parsedContent.data.contradictions.flatMap((entry) => entry.sourceIds),
    ...parsedContent.data.questionGroups.flatMap((group) => group.sourceIds),
  ]
  try {
    assertNoDanglingSourceReference(referenced, parsedManifest.data)
  } catch (error) {
    throw new InterviewBriefError((error as Error).message, 'dangling_source')
  }

  return { content: parsedContent.data, manifest: parsedManifest.data }
}

/**
 * Reads a column by either naming convention.
 *
 * This module gets rows from two places: drizzle's `.select()`/`.returning()`, which return camelCase
 * keys, and `transaction.execute(sql\`...\`)`, which returns Postgres's own snake_case. A mapper written
 * for one shape does not fail loudly on the other — `String(undefined)` yields the *string* `'undefined'`,
 * so a missing `editedByUserId` came back as text that looks like data and passes every null check.
 */
function column(row: Record<string, unknown>, camel: string, snake: string): unknown {
  return camel in row ? row[camel] : row[snake]
}

function optionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function toRow(row: Record<string, unknown>): InterviewBriefRow {
  return {
    id: String(row.id),
    organizationId: String(column(row, 'organizationId', 'organization_id')),
    eventId: String(column(row, 'eventId', 'event_id')),
    ownerUserId: String(column(row, 'ownerUserId', 'owner_user_id')),
    version: Number(row.version),
    status: String(row.status),
    content: row.content as InterviewBriefContent,
    evidenceManifest: (column(row, 'evidenceManifest', 'evidence_manifest') ?? []) as SourceManifestEntry[],
    provider: optionalText(row.provider),
    model: optionalText(row.model),
    promptVersion: optionalText(column(row, 'promptVersion', 'prompt_version')),
    editedByUserId: optionalText(column(row, 'editedByUserId', 'edited_by_user_id')),
    retentionExpiresAt: new Date(column(row, 'retentionExpiresAt', 'retention_expires_at') as string),
  }
}

/**
 * Inserts the next version of a brief and supersedes whatever was active.
 *
 * The version is computed inside the INSERT, from the table, so two concurrent generations serialise on
 * the unique index rather than racing a value read into JS. The loser sees a `version_conflict` and can
 * retry against the new maximum — which is the honest outcome, since its brief was built from evidence
 * that has since been superseded anyway.
 */
export async function insertBriefVersion(
  transaction: BriefTransaction,
  params: {
    organizationId: string
    eventId: string
    ownerUserId: string
    content: unknown
    evidenceManifest: unknown
    provider: string | null
    model: string | null
    promptVersion: string | null
    retentionExpiresAt: Date
    /** `draft` for a generated brief awaiting review; `active` once the organizer accepts it. */
    status?: 'draft' | 'active'
  },
): Promise<InterviewBriefRow> {
  const { content, manifest } = validatePair(params.content, params.evidenceManifest)

  // Superseding happens only when the *new* row is itself active. A generated draft awaiting review
  // must not retire the brief the organizer is currently working from — they would be left with a
  // pending draft and no active brief, which is a worse state than either version alone. Accepting the
  // draft (`activateBriefVersion`) is what supersedes.
  if ((params.status ?? 'draft') === 'active') {
    await transaction
      .update(interviewBriefs)
      .set({ status: 'superseded', updatedAt: new Date() })
      .where(and(
        eq(interviewBriefs.organizationId, params.organizationId),
        eq(interviewBriefs.eventId, params.eventId),
        eq(interviewBriefs.status, 'active'),
      ))
  }

  let result
  try {
    result = await transaction.execute(sql`
      insert into interview_briefs (
        organization_id, event_id, owner_user_id, version, status, content, evidence_manifest,
        provider, model, prompt_version, retention_expires_at
      )
      select
        ${params.organizationId}, ${params.eventId}, ${params.ownerUserId},
        coalesce(max(version), 0) + 1, ${params.status ?? 'draft'},
        ${JSON.stringify(content)}::jsonb, ${JSON.stringify(manifest)}::jsonb,
        ${params.provider}, ${params.model}, ${params.promptVersion},
        -- An ISO string with an explicit cast, not a JS Date: postgres.js cannot encode a Date passed as
        -- a raw parameter through this path and fails with an opaque ERR_INVALID_ARG_TYPE from its byte
        -- writer, nowhere near the column that caused it.
        ${params.retentionExpiresAt.toISOString()}::timestamptz
      from interview_briefs
      where organization_id = ${params.organizationId} and event_id = ${params.eventId}
      returning id, organization_id, event_id, owner_user_id, version, status, content,
                evidence_manifest, provider, model, prompt_version, edited_by_user_id,
                retention_expires_at
    `)
  } catch (error) {
    // The unique index doing its job: another generation claimed this version between the max() and
    // the insert.
    if (/interview_briefs_event_version_unique/.test((error as Error).message)) {
      throw new InterviewBriefError('another version was created concurrently; retry against the new latest', 'version_conflict')
    }
    throw error
  }

  const [row] = [...(result as unknown as Iterable<Record<string, unknown>>)]
  if (!row) throw new InterviewBriefError('brief insert returned no row', 'not_found')
  return toRow(row)
}

/** The version a reader should see. Null when an event has no brief yet. */
export async function findActiveBrief(
  transaction: BriefTransaction,
  params: { organizationId: string; eventId: string },
): Promise<InterviewBriefRow | null> {
  const rows = await transaction
    .select()
    .from(interviewBriefs)
    .where(and(
      eq(interviewBriefs.organizationId, params.organizationId),
      eq(interviewBriefs.eventId, params.eventId),
      eq(interviewBriefs.status, 'active'),
    ))
    .orderBy(desc(interviewBriefs.version))
    .limit(1)
  const row = rows[0]
  return row ? toRow(row as unknown as Record<string, unknown>) : null
}

/** The most recent version whatever its status — what a "regenerate" or an edit acts against. */
export async function findLatestBrief(
  transaction: BriefTransaction,
  params: { organizationId: string; eventId: string },
): Promise<InterviewBriefRow | null> {
  const rows = await transaction
    .select()
    .from(interviewBriefs)
    .where(and(
      eq(interviewBriefs.organizationId, params.organizationId),
      eq(interviewBriefs.eventId, params.eventId),
    ))
    .orderBy(desc(interviewBriefs.version))
    .limit(1)
  const row = rows[0]
  return row ? toRow(row as unknown as Record<string, unknown>) : null
}

export async function findBriefVersion(
  transaction: BriefTransaction,
  params: { organizationId: string; eventId: string; version: number },
): Promise<InterviewBriefRow | null> {
  const rows = await transaction
    .select()
    .from(interviewBriefs)
    .where(and(
      eq(interviewBriefs.organizationId, params.organizationId),
      eq(interviewBriefs.eventId, params.eventId),
      eq(interviewBriefs.version, params.version),
    ))
    .limit(1)
  const row = rows[0]
  return row ? toRow(row as unknown as Record<string, unknown>) : null
}

/** Every version, newest first — the version history an organizer can navigate. */
export async function listBriefVersions(
  transaction: BriefTransaction,
  params: { organizationId: string; eventId: string },
): Promise<InterviewBriefRow[]> {
  const rows = await transaction
    .select()
    .from(interviewBriefs)
    .where(and(
      eq(interviewBriefs.organizationId, params.organizationId),
      eq(interviewBriefs.eventId, params.eventId),
    ))
    .orderBy(desc(interviewBriefs.version))
  return rows.map((row) => toRow(row as unknown as Record<string, unknown>))
}

/**
 * Applies a human edit in place, guarded by the version the editor was looking at.
 *
 * In place rather than as a new version, deliberately: an edit is the organizer correcting *this*
 * brief, and minting a version per keystroke-batch would bury the model-generated/human-corrected
 * distinction under noise. `editedByUserId` is what records that a person changed it.
 *
 * `expectedVersion` is the optimistic guard. Without it, two tabs editing the same brief would each
 * write their own full content and the later one would silently discard the earlier's work.
 */
export async function updateBriefContent(
  transaction: BriefTransaction,
  params: {
    organizationId: string
    eventId: string
    expectedVersion: number
    content: unknown
    evidenceManifest: unknown
    editedByUserId: string
    status?: 'draft' | 'active'
  },
): Promise<InterviewBriefRow> {
  const { content, manifest } = validatePair(params.content, params.evidenceManifest)

  const rows = await transaction
    .update(interviewBriefs)
    .set({
      content: content as unknown as Record<string, unknown>,
      evidenceManifest: manifest as unknown as unknown[],
      editedByUserId: params.editedByUserId,
      ...(params.status ? { status: params.status } : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(interviewBriefs.organizationId, params.organizationId),
      eq(interviewBriefs.eventId, params.eventId),
      eq(interviewBriefs.version, params.expectedVersion),
    ))
    .returning()

  const row = rows[0]
  if (!row) {
    // Zero rows means the version moved, not that the brief vanished — a regeneration bumped it while
    // this edit was in flight. Named as a conflict so the UI can offer the new version rather than a
    // generic failure.
    throw new InterviewBriefError(
      `no brief at version ${params.expectedVersion}; it was superseded while you were editing`,
      'version_conflict',
    )
  }
  return toRow(row as unknown as Record<string, unknown>)
}

/** Marks a specific version active, superseding the rest. Used when an organizer accepts a draft. */
export async function activateBriefVersion(
  transaction: BriefTransaction,
  params: { organizationId: string; eventId: string; version: number },
): Promise<InterviewBriefRow> {
  await transaction
    .update(interviewBriefs)
    .set({ status: 'superseded', updatedAt: new Date() })
    .where(and(
      eq(interviewBriefs.organizationId, params.organizationId),
      eq(interviewBriefs.eventId, params.eventId),
      eq(interviewBriefs.status, 'active'),
    ))

  const rows = await transaction
    .update(interviewBriefs)
    .set({ status: 'active', updatedAt: new Date() })
    .where(and(
      eq(interviewBriefs.organizationId, params.organizationId),
      eq(interviewBriefs.eventId, params.eventId),
      eq(interviewBriefs.version, params.version),
    ))
    .returning()

  const row = rows[0]
  if (!row) throw new InterviewBriefError(`no brief at version ${params.version}`, 'not_found')
  return toRow(row as unknown as Record<string, unknown>)
}

// ── Live interview sessions (plan: calendar-scheduling-interview-intelligence, Phase 9) ──────────

/**
 * Session reads and writes.
 *
 * Every transition is guarded by `version`, and the guard is in the WHERE clause rather than checked
 * beforehand. Two tabs, or a tab and a reconnecting client, will both try to move a session; a
 * read-then-write would let the second silently overwrite the first's state, and "who finished this
 * interview" would become unanswerable.
 */
export interface InterviewSessionRow {
  id: string
  organizationId: string
  eventId: string
  ownerUserId: string
  state: string
  captureMode: string
  language: string
  provider: string
  consentNoticeVersion: string
  captureCapability: string
  startedAt: Date | null
  pausedAt: Date | null
  finishedAt: Date | null
  heartbeatAt: Date | null
  providerRequestId: string | null
  providerBilledSeconds: number
  version: number
}

function toSessionRow(row: Record<string, unknown>): InterviewSessionRow {
  const date = (value: unknown) => (value === null || value === undefined ? null : new Date(value as string))
  return {
    id: String(row.id),
    organizationId: String(column(row, 'organizationId', 'organization_id')),
    eventId: String(column(row, 'eventId', 'event_id')),
    ownerUserId: String(column(row, 'ownerUserId', 'owner_user_id')),
    state: String(row.state),
    captureMode: String(column(row, 'captureMode', 'capture_mode')),
    language: String(row.language),
    provider: String(row.provider),
    consentNoticeVersion: String(column(row, 'consentNoticeVersion', 'consent_notice_version')),
    captureCapability: String(column(row, 'captureCapability', 'capture_capability')),
    startedAt: date(column(row, 'startedAt', 'started_at')),
    pausedAt: date(column(row, 'pausedAt', 'paused_at')),
    finishedAt: date(column(row, 'finishedAt', 'finished_at')),
    heartbeatAt: date(column(row, 'heartbeatAt', 'heartbeat_at')),
    providerRequestId: optionalText(column(row, 'providerRequestId', 'provider_request_id')),
    providerBilledSeconds: Number(column(row, 'providerBilledSeconds', 'provider_billed_seconds')),
    version: Number(row.version),
  }
}

export async function findSessionByEvent(
  transaction: BriefTransaction,
  params: { organizationId: string; eventId: string },
): Promise<InterviewSessionRow | null> {
  const rows = await transaction
    .select()
    .from(interviewSessions)
    .where(and(
      eq(interviewSessions.organizationId, params.organizationId),
      eq(interviewSessions.eventId, params.eventId),
    ))
    .limit(1)
  const row = rows[0]
  return row ? toSessionRow(row as unknown as Record<string, unknown>) : null
}

/**
 * Creates the session for an event, or returns the one that already exists.
 *
 * `onConflictDoNothing` on `interview_sessions_event_unique` rather than a read-then-insert: two clients
 * opening the workspace at once would otherwise both see "no session" and both insert, and one would get
 * a constraint error it has no way to recover from. Here the loser simply reads the winner's row, which
 * is what it wanted anyway.
 */
export async function ensureSession(
  transaction: BriefTransaction,
  params: {
    organizationId: string
    eventId: string
    ownerUserId: string
    captureMode: string
    language: string
    provider: string
    consentNoticeVersion: string
    captureCapability: string
    retentionExpiresAt: Date
  },
): Promise<InterviewSessionRow> {
  await transaction
    .insert(interviewSessions)
    .values({
      organizationId: params.organizationId,
      eventId: params.eventId,
      ownerUserId: params.ownerUserId,
      captureMode: params.captureMode,
      language: params.language,
      provider: params.provider,
      consentNoticeVersion: params.consentNoticeVersion,
      captureCapability: params.captureCapability,
      retentionExpiresAt: params.retentionExpiresAt,
    })
    .onConflictDoNothing()

  const session = await findSessionByEvent(transaction, params)
  if (!session) throw new InterviewBriefError('session insert returned no row', 'not_found')
  return session
}

/**
 * Applies a state transition, guarded by the version the caller was holding.
 *
 * The version bump and the state change are one statement. A caller that read version 3, decided to
 * finish, and wrote while another client moved to `paused` will match zero rows and learn about it —
 * rather than overwriting a state somebody else chose.
 */
export async function transitionSession(
  transaction: BriefTransaction,
  params: {
    organizationId: string
    sessionId: string
    expectedVersion: number
    state: string
    startedAt?: Date | null
    pausedAt?: Date | null
    finishedAt?: Date | null
    heartbeatAt?: Date | null
    providerRequestId?: string | null
    providerBilledSeconds?: number
  },
): Promise<InterviewSessionRow> {
  const rows = await transaction
    .update(interviewSessions)
    .set({
      state: params.state,
      version: sql`${interviewSessions.version} + 1`,
      updatedAt: new Date(),
      ...(params.startedAt !== undefined ? { startedAt: params.startedAt } : {}),
      ...(params.pausedAt !== undefined ? { pausedAt: params.pausedAt } : {}),
      ...(params.finishedAt !== undefined ? { finishedAt: params.finishedAt } : {}),
      ...(params.heartbeatAt !== undefined ? { heartbeatAt: params.heartbeatAt } : {}),
      ...(params.providerRequestId !== undefined ? { providerRequestId: params.providerRequestId } : {}),
      ...(params.providerBilledSeconds !== undefined ? { providerBilledSeconds: params.providerBilledSeconds } : {}),
    })
    .where(and(
      eq(interviewSessions.organizationId, params.organizationId),
      eq(interviewSessions.id, params.sessionId),
      eq(interviewSessions.version, params.expectedVersion),
    ))
    .returning()

  const row = rows[0]
  if (!row) {
    throw new InterviewBriefError(
      `session is no longer at version ${params.expectedVersion}; another client moved it`,
      'version_conflict',
    )
  }
  return toSessionRow(row as unknown as Record<string, unknown>)
}

/** Records a sign of life. Deliberately not a transition: a heartbeat must not bump `version`. */
export async function touchSessionHeartbeat(
  transaction: BriefTransaction,
  params: { organizationId: string; sessionId: string; at: Date },
) {
  return transaction
    .update(interviewSessions)
    .set({ heartbeatAt: params.at })
    .where(and(
      eq(interviewSessions.organizationId, params.organizationId),
      eq(interviewSessions.id, params.sessionId),
    ))
    .returning({ id: interviewSessions.id })
}

/**
 * Persists a batch of final segments, ignoring ones already stored.
 *
 * `onConflictDoNothing` is what makes the outbox's resend a no-op. Returns the number actually written so
 * a caller can tell "accepted, already had it" from "accepted, new" — the outbox needs the first to
 * acknowledge and stop resending.
 */
export async function insertTranscriptSegments(
  transaction: BriefTransaction,
  params: {
    organizationId: string
    sessionId: string
    retentionExpiresAt: Date
    segments: ReadonlyArray<{
      providerSegmentId: string
      sequence: number
      speakerEstimate: string
      text: string
      startsMs: number
      endsMs: number
      confidence: number | null
    }>
  },
): Promise<{ accepted: string[]; inserted: number }> {
  if (params.segments.length === 0) return { accepted: [], inserted: 0 }

  const rows = await transaction
    .insert(transcriptSegments)
    .values(params.segments.map((segment) => ({
      organizationId: params.organizationId,
      sessionId: params.sessionId,
      providerSegmentId: segment.providerSegmentId,
      sequence: segment.sequence,
      speakerEstimate: segment.speakerEstimate,
      text: segment.text,
      startsMs: segment.startsMs,
      endsMs: segment.endsMs,
      // The column is `numeric`, which drizzle maps to a string. Passing a number here silently stores
      // nothing on some drivers, so the conversion is explicit.
      confidence: segment.confidence === null ? null : String(segment.confidence),
      retentionExpiresAt: params.retentionExpiresAt,
    })))
    .onConflictDoNothing()
    .returning({ providerSegmentId: transcriptSegments.providerSegmentId })

  return {
    // Every id the caller sent is acknowledged, whether it was new or already present. Acknowledging
    // only the new ones would make the outbox resend a duplicate forever.
    accepted: params.segments.map((segment) => segment.providerSegmentId),
    inserted: rows.length,
  }
}

/** Corrects who a segment is attributed to. The only field a human may change after the fact. */
export async function correctSegmentSpeaker(
  transaction: BriefTransaction,
  params: {
    organizationId: string
    sessionId: string
    segmentId: string
    speakerMapping: 'organizer' | 'candidate_or_remote'
    correctedByUserId: string
    at: Date
  },
) {
  return transaction
    .update(transcriptSegments)
    .set({
      speakerMapping: params.speakerMapping,
      // Author and time together: the check constraint requires it, and a correction without an author
      // is unattributable.
      correctedByUserId: params.correctedByUserId,
      correctedAt: params.at,
    })
    .where(and(
      eq(transcriptSegments.organizationId, params.organizationId),
      eq(transcriptSegments.sessionId, params.sessionId),
      eq(transcriptSegments.id, params.segmentId),
    ))
    .returning({ id: transcriptSegments.id })
}

export async function listSessionSegments(
  transaction: BriefTransaction,
  params: { organizationId: string; sessionId: string },
) {
  return transaction
    .select()
    .from(transcriptSegments)
    .where(and(
      eq(transcriptSegments.organizationId, params.organizationId),
      eq(transcriptSegments.sessionId, params.sessionId),
    ))
    .orderBy(transcriptSegments.sequence)
}
