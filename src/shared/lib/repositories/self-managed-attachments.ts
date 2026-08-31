/**
 * The attachments hanging off a self-managed profile (plan: phase-2/07-perfiles-autogestionados).
 *
 * ## The profile is resolved from the owner, never taken from the caller
 *
 * Every function takes `ownerUserId` and finds the profile from it. None takes a `profileId` from a
 * request: an id in a body is an id somebody will change, and "add an attachment to profile X" is
 * precisely the shape that lets one person publish a document on another person's page. The owner's
 * profile is unique among live rows, so there is nothing to disambiguate anyway.
 *
 * ## The two limits are counted in the database, not in the caller
 *
 * Twelve live attachments and one live CV, from the spec. Both are counted inside the same
 * transaction as the insert, so two uploads racing cannot both read eleven and both write. There is
 * no partial unique index behind the CV rule — one is possible and would be better, but adding it
 * belongs to the migration that owns the table rather than to this file, and until then the count is
 * the guarantee. That is stated here rather than assumed, because "enforced in the repository" reads
 * as weaker than it is only when nobody says which transaction it is enforced in.
 *
 * ## Deleting is two steps and this file is only the first
 *
 * `softDeleteAttachment` marks the row; the bytes stay in object storage until the worker sweeps
 * them. Removing the object first and the row second means a crash in between leaves a row pointing
 * at nothing, which renders as a broken download for as long as it takes somebody to notice.
 * `listPurgeableAttachments` is what the sweep reads, and `purgeDeletedAttachments` is what it calls
 * once the object is actually gone.
 */
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'

import { randomId } from '~/lib/utils'
import type { TenantTransaction } from '../db/client'
import type { WorkerTransaction } from '../db/worker-db'
import { selfManagedAttachments, selfManagedProfiles } from '../db/schema'
import {
  MAX_ACTIVE_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  SELF_MANAGED_SCAN_STATUSES,
  type SelfManagedAttachmentKind,
  type SelfManagedScanStatus,
  type UpsertAttachment,
} from '../self-managed/contracts'

export interface SelfManagedAttachment {
  id: string
  profileId: string
  kind: SelfManagedAttachmentKind
  title: string
  description: string | null
  storageKey: string
  mimeType: string
  /** Null only while `awaiting_upload` — see the scan state machine on the table. */
  sizeBytes: number | null
  durationSeconds: number | null
  /** Null only while `awaiting_upload`. */
  checksumSha256: string | null
  scanStatus: SelfManagedScanStatus
  /**
   * Why a scan rejected, iff it did. Internal: the owner's editor may show it, a public
   * projection must never include it — task 4's DTOs name their fields for exactly this reason.
   */
  rejectionCode: string | null
  uploadedAt: Date
}

const ATTACHMENT_COLUMNS = {
  id: selfManagedAttachments.id,
  profileId: selfManagedAttachments.profileId,
  kind: selfManagedAttachments.kind,
  title: selfManagedAttachments.title,
  description: selfManagedAttachments.description,
  storageKey: selfManagedAttachments.storageKey,
  mimeType: selfManagedAttachments.mimeType,
  sizeBytes: selfManagedAttachments.sizeBytes,
  durationSeconds: selfManagedAttachments.durationSeconds,
  checksumSha256: selfManagedAttachments.checksumSha256,
  scanStatus: selfManagedAttachments.scanStatus,
  rejectionCode: selfManagedAttachments.rejectionCode,
  uploadedAt: selfManagedAttachments.uploadedAt,
} as const

/** Refusals the caller can act on, kept apart from the failures that mean something is broken. */
export class SelfManagedAttachmentError extends Error {
  constructor(
    readonly code: 'no-profile' | 'not-found' | 'too-many' | 'cv-exists' | 'too-large',
    message: string,
  ) {
    super(message)
    this.name = 'SelfManagedAttachmentError'
  }
}

/**
 * The statuses that hold one of the twelve slots (and the single CV slot).
 *
 * An intent holds its slot from the moment it is issued — that is what makes the limit a
 * reservation instead of a race — and a terminal rejection releases it, because a profile with
 * twelve refused uploads and no way to try again would be locked shut by its own failures.
 */
const QUOTA_SCAN_STATUSES = ['awaiting_upload', 'pending', 'scanning', 'clean'] as const

/** Throws the refusal the owner can act on; returns quietly when the upload may proceed. */
async function assertAttachmentQuota(
  transaction: TenantTransaction,
  params: { profileId: string; kind: SelfManagedAttachmentKind; sizeBytes: number },
): Promise<void> {
  if (params.sizeBytes <= 0 || params.sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new SelfManagedAttachmentError(
      'too-large',
      `An attachment is at most ${MAX_ATTACHMENT_BYTES} bytes; this one is ${params.sizeBytes}`,
    )
  }

  const [live] = await transaction
    .select({ total: count() })
    .from(selfManagedAttachments)
    .where(
      and(
        eq(selfManagedAttachments.profileId, params.profileId),
        isNull(selfManagedAttachments.deletedAt),
        inArray(selfManagedAttachments.scanStatus, [...QUOTA_SCAN_STATUSES]),
      ),
    )
  if ((live?.total ?? 0) >= MAX_ACTIVE_ATTACHMENTS) {
    throw new SelfManagedAttachmentError('too-many', `A profile holds at most ${MAX_ACTIVE_ATTACHMENTS} attachments`)
  }

  if (params.kind === 'cv') {
    const [cv] = await transaction
      .select({ total: count() })
      .from(selfManagedAttachments)
      .where(
        and(
          eq(selfManagedAttachments.profileId, params.profileId),
          eq(selfManagedAttachments.kind, 'cv'),
          isNull(selfManagedAttachments.deletedAt),
          inArray(selfManagedAttachments.scanStatus, [...QUOTA_SCAN_STATUSES]),
        ),
      )
    if ((cv?.total ?? 0) > 0) {
      throw new SelfManagedAttachmentError('cv-exists', 'This profile already has a CV; delete it before adding another')
    }
  }
}

function rowToAttachment(
  row: { kind: string; scanStatus: string } & Omit<SelfManagedAttachment, 'kind' | 'scanStatus'>,
): SelfManagedAttachment {
  // A stored kind outside the set would have to have been written around the CHECK constraint.
  // Reading it back as `other` keeps one bad row from throwing on a page that lists twelve.
  const kind = row.kind === 'cv' || row.kind === 'work-sample' || row.kind === 'certificate' ? row.kind : 'other'
  // Same reasoning, opposite direction: a status written around the CHECK reads back as a
  // rejection, because the one coercion that must never happen is toward `clean`.
  const scanStatus = (SELF_MANAGED_SCAN_STATUSES as readonly string[]).includes(row.scanStatus)
    ? (row.scanStatus as SelfManagedScanStatus)
    : 'failed'
  return { ...row, kind, scanStatus }
}

/** The owner's live profile id, or `null` if they have none. */
async function liveProfileIdFor(transaction: TenantTransaction, ownerUserId: string): Promise<string | null> {
  const [row] = await transaction
    .select({ id: selfManagedProfiles.id })
    .from(selfManagedProfiles)
    .where(and(eq(selfManagedProfiles.ownerUserId, ownerUserId), isNull(selfManagedProfiles.deletedAt)))
    .limit(1)
  return row?.id ?? null
}

async function requireLiveProfileId(transaction: TenantTransaction, ownerUserId: string): Promise<string> {
  const profileId = await liveProfileIdFor(transaction, ownerUserId)
  if (!profileId) throw new SelfManagedAttachmentError('no-profile', 'This account has no self-managed profile')
  return profileId
}

/** Everything the owner has attached, newest first. Soft-deleted rows are not the owner's business. */
export async function listOwnAttachments(
  transaction: TenantTransaction,
  ownerUserId: string,
): Promise<SelfManagedAttachment[]> {
  const profileId = await liveProfileIdFor(transaction, ownerUserId)
  if (!profileId) return []

  const rows = await transaction
    .select(ATTACHMENT_COLUMNS)
    .from(selfManagedAttachments)
    .where(and(eq(selfManagedAttachments.profileId, profileId), isNull(selfManagedAttachments.deletedAt)))
    .orderBy(desc(selfManagedAttachments.uploadedAt))
    // Twelve is the quota, but rejected rows stay visible so the owner can read *why* — and they
    // hold no slot, so more than twelve non-deleted rows can exist. Four pages of quota is room
    // for every live row plus a generous backlog of rejections awaiting the owner's cleanup, and
    // it is still one bounded read.
    .limit(MAX_ACTIVE_ATTACHMENTS * 4)

  return rows.map(rowToAttachment)
}

/**
 * What a stranger sees on a profile page.
 *
 * The visibility test is a join against the profile rather than a column on the attachment, matching
 * the row policy in `0175`. Two places to keep in step is how an attachment outlives the decision to
 * hide the profile it belongs to.
 *
 * Only `clean` rows, same as the row policy since `0176`: an attachment the scanner has not cleared
 * is not served to anybody but its owner, whatever the profile's visibility says.
 */
export async function listPublicAttachments(
  transaction: TenantTransaction,
  handle: string,
): Promise<SelfManagedAttachment[]> {
  const rows = await transaction
    .select(ATTACHMENT_COLUMNS)
    .from(selfManagedAttachments)
    .innerJoin(selfManagedProfiles, eq(selfManagedProfiles.id, selfManagedAttachments.profileId))
    .where(
      and(
        eq(selfManagedProfiles.handle, handle),
        isNull(selfManagedProfiles.deletedAt),
        isNull(selfManagedAttachments.deletedAt),
        eq(selfManagedAttachments.scanStatus, 'clean'),
        inArray(selfManagedProfiles.visibility, ['public', 'unlisted']),
      ),
    )
    .orderBy(desc(selfManagedAttachments.uploadedAt))
    // Same ceiling, same reason. A public page is exactly where an unbounded read would be worst:
    // the caller is a stranger, the handle is guessable, and nobody is logged in to notice the cost.
    .limit(MAX_ACTIVE_ATTACHMENTS)

  return rows.map(rowToAttachment)
}

export interface AddAttachmentInput {
  ownerUserId: string
  attachment: UpsertAttachment
  /**
   * Set by the server after the upload lands in quarantine, never accepted from a request body —
   * the key names a real object and a caller-chosen one is a caller-chosen file.
   */
  storageKey: string
  mimeType: string
  sizeBytes: number
  checksumSha256: string
  durationSeconds?: number | null
  now?: Date
}

/**
 * Record an attachment whose bytes are already stored and verified, queued for the scan.
 *
 * The row is written `pending`: the scan worker is what moves it to `clean`, and until it does the
 * attachment is the owner's alone — the public policy and `listPublicAttachments` both say so.
 * (Task 4's upload routes add the earlier `awaiting_upload` intent step; this function is the
 * post-verification write they and today's tests share.)
 *
 * The size check is here as well as in the column's CHECK because the two say different things: the
 * constraint stops a bad row, this stops a bad row *with a message*, and an upload that got past the
 * pipeline's own cap deserves better than a 500 from the driver.
 */
export async function addAttachment(
  transaction: TenantTransaction,
  input: AddAttachmentInput,
): Promise<SelfManagedAttachment> {
  const now = input.now ?? new Date()
  const profileId = await requireLiveProfileId(transaction, input.ownerUserId)

  await assertAttachmentQuota(transaction, {
    profileId,
    kind: input.attachment.kind,
    sizeBytes: input.sizeBytes,
  })

  const [row] = await transaction
    .insert(selfManagedAttachments)
    .values({
      id: randomId(),
      profileId,
      kind: input.attachment.kind,
      title: input.attachment.title,
      description: input.attachment.description ?? null,
      storageKey: input.storageKey,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      durationSeconds: input.durationSeconds ?? null,
      checksumSha256: input.checksumSha256,
      scanStatus: 'pending',
      uploadedAt: now,
      updatedAt: now,
    })
    .returning(ATTACHMENT_COLUMNS)

  // Empty RETURNING means the policy refused the write. Reporting that as success would leave the
  // object in storage with nothing pointing at it and the owner staring at an upload that vanished.
  if (!row) throw new Error(`refused to attach ${input.storageKey} to ${input.ownerUserId}'s profile`)
  return rowToAttachment(row)
}

/**
 * Retitle or re-describe an attachment. Never its bytes.
 *
 * `storageKey`, `mimeType`, `sizeBytes` and `checksumSha256` describe the object that was scanned;
 * letting an update touch them would let a caller point a clean row at a file the scanner never saw.
 * Replacing the file is a delete and a new upload, which is the same work and cannot lie.
 */
export async function updateAttachment(
  transaction: TenantTransaction,
  input: { ownerUserId: string; attachmentId: string; attachment: UpsertAttachment },
): Promise<SelfManagedAttachment> {
  const profileId = await requireLiveProfileId(transaction, input.ownerUserId)

  const [row] = await transaction
    .update(selfManagedAttachments)
    .set({
      kind: input.attachment.kind,
      title: input.attachment.title,
      description: input.attachment.description ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(selfManagedAttachments.id, input.attachmentId),
        // The profile scope is what makes an attachment id from somebody else's page a 404 rather
        // than an edit. Matching on the id alone would be the whole vulnerability.
        eq(selfManagedAttachments.profileId, profileId),
        isNull(selfManagedAttachments.deletedAt),
      ),
    )
    .returning(ATTACHMENT_COLUMNS)

  if (!row) throw new SelfManagedAttachmentError('not-found', 'No such attachment on this profile')
  return rowToAttachment(row)
}

/** Mark it deleted. The bytes go later, in the sweep — see the note at the top of this file. */
export async function softDeleteAttachment(
  transaction: TenantTransaction,
  input: { ownerUserId: string; attachmentId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date()
  const profileId = await requireLiveProfileId(transaction, input.ownerUserId)

  const rows = await transaction
    .update(selfManagedAttachments)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(selfManagedAttachments.id, input.attachmentId),
        eq(selfManagedAttachments.profileId, profileId),
        isNull(selfManagedAttachments.deletedAt),
      ),
    )
    .returning({ id: selfManagedAttachments.id })

  return rows.length > 0
}

// ── Upload intents ────────────────────────────────────────────────────────────────────────────
//
// The route-facing half of the flow `interview-documents.ts` proved: the row exists before the
// bytes do (the quota is a reservation, not a check), completion is single-use and re-checked in
// the UPDATE, and everything here resolves the profile from the authenticated owner.

export interface AttachmentUploadIntent {
  id: string
  storageKey: string
}

/**
 * Reserves an upload slot: an `awaiting_upload` row with the declared size and no hash yet.
 *
 * The id is generated here so the object key — which contains it — can go into the same INSERT,
 * exactly as the candidate flow does. The declared size is written as the reservation; completion
 * overwrites it with what the object store actually measured.
 */
export async function createAttachmentUploadIntent(
  transaction: TenantTransaction,
  input: {
    ownerUserId: string
    attachment: UpsertAttachment
    declaredMediaType: string
    declaredBytes: number
    keyFor: (params: { profileId: string; attachmentId: string }) => string
    now?: Date
  },
): Promise<AttachmentUploadIntent> {
  const now = input.now ?? new Date()
  const profileId = await requireLiveProfileId(transaction, input.ownerUserId)

  await assertAttachmentQuota(transaction, {
    profileId,
    kind: input.attachment.kind,
    sizeBytes: input.declaredBytes,
  })

  const attachmentId = randomId()
  const storageKey = input.keyFor({ profileId, attachmentId })

  const [row] = await transaction
    .insert(selfManagedAttachments)
    .values({
      id: attachmentId,
      profileId,
      kind: input.attachment.kind,
      title: input.attachment.title,
      description: input.attachment.description ?? null,
      storageKey,
      mimeType: input.declaredMediaType,
      sizeBytes: input.declaredBytes,
      checksumSha256: null,
      scanStatus: 'awaiting_upload',
      uploadedAt: now,
      updatedAt: now,
    })
    .returning({ id: selfManagedAttachments.id })

  if (!row) throw new Error(`refused to reserve an upload slot on ${input.ownerUserId}'s profile`)
  return { id: row.id, storageKey }
}

export interface AttachmentForCompletion {
  id: string
  storageKey: string
  declaredMediaType: string
  declaredBytes: number
  title: string
}

/**
 * The row a completion call is allowed to act on: the caller's own, still awaiting its bytes.
 *
 * Restricting to `awaiting_upload` is what makes completion single-use — a replayed call cannot
 * rewrite the hash of an attachment the scanner already judged.
 */
export async function findAwaitingUploadAttachment(
  transaction: TenantTransaction,
  params: { ownerUserId: string; attachmentId: string },
): Promise<AttachmentForCompletion | null> {
  const profileId = await liveProfileIdFor(transaction, params.ownerUserId)
  if (!profileId) return null

  const [row] = await transaction
    .select({
      id: selfManagedAttachments.id,
      storageKey: selfManagedAttachments.storageKey,
      declaredMediaType: selfManagedAttachments.mimeType,
      declaredBytes: selfManagedAttachments.sizeBytes,
      title: selfManagedAttachments.title,
    })
    .from(selfManagedAttachments)
    .where(
      and(
        eq(selfManagedAttachments.id, params.attachmentId),
        eq(selfManagedAttachments.profileId, profileId),
        eq(selfManagedAttachments.scanStatus, 'awaiting_upload'),
        isNull(selfManagedAttachments.deletedAt),
      ),
    )
    .limit(1)
  if (!row) return null
  return { ...row, declaredBytes: row.declaredBytes ?? 0 }
}

/**
 * Hands a verified upload to the scan queue.
 *
 * Size and media type are overwritten with what was measured, never kept as declared, and the
 * status is re-checked in the UPDATE so two racing completions cannot both write.
 */
export async function markAttachmentUploaded(
  transaction: TenantTransaction,
  params: { attachmentId: string; sha256: string; actualBytes: number; detectedMediaType: string },
) {
  return transaction
    .update(selfManagedAttachments)
    .set({
      scanStatus: 'pending',
      checksumSha256: params.sha256,
      sizeBytes: params.actualBytes,
      mimeType: params.detectedMediaType,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(selfManagedAttachments.id, params.attachmentId),
        eq(selfManagedAttachments.scanStatus, 'awaiting_upload'),
      ),
    )
    .returning({ id: selfManagedAttachments.id })
}

/**
 * Records an upload that failed validation, keeping the row so the owner can see *why*.
 *
 * The hash and size stored are computed from the object, not claimed — the claim is what was just
 * rejected. A `failed` row no longer holds a quota slot, so the owner can retry immediately.
 */
export async function rejectAttachmentUploadOnCompletion(
  transaction: TenantTransaction,
  params: { attachmentId: string; rejectionCode: string; computedSha256: string; actualBytes: number },
) {
  return transaction
    .update(selfManagedAttachments)
    .set({
      scanStatus: 'failed',
      rejectionCode: params.rejectionCode.slice(0, 64),
      checksumSha256: params.computedSha256,
      sizeBytes: params.actualBytes,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(selfManagedAttachments.id, params.attachmentId),
        eq(selfManagedAttachments.scanStatus, 'awaiting_upload'),
      ),
    )
    .returning({ id: selfManagedAttachments.id })
}

/**
 * The one row a download may sign: the caller's own, scanned clean, not deleted.
 *
 * The `clean` filter lives in the query, matching the candidate download route: there is no code
 * path that holds an unscanned attachment's key and then decides not to sign it.
 */
export async function findCleanAttachmentForDownload(
  transaction: TenantTransaction,
  params: { ownerUserId: string; attachmentId: string },
): Promise<{ id: string; storageKey: string; mimeType: string; title: string } | null> {
  const profileId = await liveProfileIdFor(transaction, params.ownerUserId)
  if (!profileId) return null

  const [row] = await transaction
    .select({
      id: selfManagedAttachments.id,
      storageKey: selfManagedAttachments.storageKey,
      mimeType: selfManagedAttachments.mimeType,
      title: selfManagedAttachments.title,
    })
    .from(selfManagedAttachments)
    .where(
      and(
        eq(selfManagedAttachments.id, params.attachmentId),
        eq(selfManagedAttachments.profileId, profileId),
        eq(selfManagedAttachments.scanStatus, 'clean'),
        isNull(selfManagedAttachments.deletedAt),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * Expires intents nobody completed, returning their keys so the caller can delete any partial
 * object. Without this an abandoned upload holds one of the twelve slots forever, with nothing on
 * screen explaining why. `uploadedAt` is the intent's creation stamp — bytes never arrived.
 */
export async function expireAbandonedAttachmentIntents(
  transaction: WorkerTransaction,
  params: { olderThan: Date },
): Promise<{ id: string; storageKey: string }[]> {
  return transaction
    .delete(selfManagedAttachments)
    .where(
      and(
        eq(selfManagedAttachments.scanStatus, 'awaiting_upload'),
        lt(selfManagedAttachments.uploadedAt, params.olderThan),
      ),
    )
    .returning({ id: selfManagedAttachments.id, storageKey: selfManagedAttachments.storageKey })
}

/**
 * The next batch of storage keys whose objects may be removed.
 *
 * Returns the keys rather than deleting anything, because the object has to go first and only the
 * caller can do that. Bounded and ordered by deletion time so repeated calls walk forward from the
 * oldest instead of re-reading the same page.
 */
export async function listPurgeableAttachments(
  transaction: TenantTransaction,
  input: { deletedBefore: Date; limit?: number },
): Promise<{ id: string; storageKey: string }[]> {
  return await transaction
    .select({ id: selfManagedAttachments.id, storageKey: selfManagedAttachments.storageKey })
    .from(selfManagedAttachments)
    .where(
      and(
        isNotNull(selfManagedAttachments.deletedAt),
        lt(selfManagedAttachments.deletedAt, input.deletedBefore),
      ),
    )
    .orderBy(asc(selfManagedAttachments.deletedAt))
    .limit(input.limit ?? 200)
}

/**
 * Drop the rows whose objects the caller has already removed.
 *
 * Takes explicit ids rather than repeating the `deletedBefore` query, so the rows deleted here are
 * exactly the ones whose bytes the caller confirmed gone. Re-running the predicate would delete rows
 * that became eligible between the two statements and whose objects are still sitting in the bucket.
 */
export async function purgeDeletedAttachments(
  transaction: TenantTransaction,
  attachmentIds: string[],
): Promise<number> {
  if (attachmentIds.length === 0) return 0

  const rows = await transaction
    .delete(selfManagedAttachments)
    .where(
      and(
        inArray(selfManagedAttachments.id, attachmentIds),
        // Belt and braces: a live attachment must never be purgeable, whatever the caller passes.
        isNotNull(selfManagedAttachments.deletedAt),
      ),
    )
    .returning({ id: selfManagedAttachments.id })

  return rows.length
}

// ── Scan pipeline ─────────────────────────────────────────────────────────────────────────────
//
// The worker-side half of the state machine, mirroring `interview-documents.ts` — same lease shape,
// same "the status is the lease" contract, same injected clock rule. These run as
// `builderhunt_worker`, whose access comes from the per-operation policies `0176` added; there is no
// organization to scope to, because a self-managed profile is account-subject data.

/** What the scan worker leases: enough to fetch, scan and move the object, and nothing more. */
export interface LeasedSelfManagedAttachment {
  id: string
  profileId: string
  storageKey: string
  mimeType: string
  scanAttempts: number
}

const LEASED_ATTACHMENT_COLUMNS = sql`id, profile_id, storage_key, mime_type, scan_attempts`

function toLeasedAttachment(row: Record<string, unknown>): LeasedSelfManagedAttachment {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    storageKey: String(row.storage_key),
    mimeType: String(row.mime_type),
    scanAttempts: Number(row.scan_attempts),
  }
}

/**
 * Claims up to `limit` pending attachments for scanning and marks them `scanning` atomically.
 *
 * `order by uploaded_at` so the owner who has been waiting longest is scanned first. Soft-deleted
 * rows are skipped: their bytes belong to the retention sweep, and scanning a file nobody can ever
 * see again is a ClamAV stream spent on nothing.
 */
export async function leaseAttachmentsForScan(
  transaction: WorkerTransaction,
  options: { limit: number; maxAttempts: number },
): Promise<LeasedSelfManagedAttachment[]> {
  const result = await transaction.execute(sql`
    update self_managed_attachments
    set scan_status = 'scanning', scan_attempts = scan_attempts + 1, updated_at = now()
    where id in (
      select id from self_managed_attachments
      where scan_status = 'pending'
        and scan_attempts < ${options.maxAttempts}
        and deleted_at is null
      order by uploaded_at
      limit ${options.limit}
      for update skip locked
    )
    returning ${LEASED_ATTACHMENT_COLUMNS}
  `)
  return [...(result as unknown as Iterable<Record<string, unknown>>)].map(toLeasedAttachment)
}

/**
 * Records a clean verdict and the key the object now lives under.
 *
 * The key is updated in the same statement as the status because the two must agree: a row marked
 * clean whose key still points at the quarantine prefix would be served from a location the move
 * already emptied.
 */
export async function markAttachmentClean(
  transaction: WorkerTransaction,
  params: { attachmentId: string; cleanObjectKey: string },
) {
  return transaction
    .update(selfManagedAttachments)
    .set({
      scanStatus: 'clean',
      storageKey: params.cleanObjectKey,
      rejectionCode: null,
      updatedAt: new Date(),
    })
    .where(eq(selfManagedAttachments.id, params.attachmentId))
    .returning({ id: selfManagedAttachments.id, scanStatus: selfManagedAttachments.scanStatus })
}

/** Terminal rejection. The code is truncated because it can reach the owner's editor as a status. */
export async function markAttachmentRejected(
  transaction: WorkerTransaction,
  params: { attachmentId: string; scanStatus: 'infected' | 'failed'; rejectionCode: string },
) {
  return transaction
    .update(selfManagedAttachments)
    .set({
      scanStatus: params.scanStatus,
      rejectionCode: params.rejectionCode.slice(0, 64),
      updatedAt: new Date(),
    })
    .where(eq(selfManagedAttachments.id, params.attachmentId))
    .returning({ id: selfManagedAttachments.id, scanStatus: selfManagedAttachments.scanStatus })
}

/** Returns an attachment to the scan queue after a transient failure. The attempt already counted. */
export async function releaseAttachmentForScanRetry(
  transaction: WorkerTransaction,
  params: { attachmentId: string },
) {
  return transaction
    .update(selfManagedAttachments)
    .set({ scanStatus: 'pending', rejectionCode: null, updatedAt: new Date() })
    .where(eq(selfManagedAttachments.id, params.attachmentId))
    .returning({ id: selfManagedAttachments.id })
}

/**
 * Rescues rows a killed process left `scanning` forever.
 *
 * The cutoff comes from the caller's `now`, not from Postgres's `now()`, matching every other worker
 * in this codebase: a clock the worker accepts but some of its queries ignore lets a test set up a
 * scenario the code then evaluates against a different timeline.
 */
export async function reclaimStaleAttachmentScans(
  transaction: WorkerTransaction,
  params: { staleAfterMs: number; now: Date },
): Promise<number> {
  const cutoff = new Date(params.now.getTime() - params.staleAfterMs)

  const rows = await transaction
    .update(selfManagedAttachments)
    .set({ scanStatus: 'pending', updatedAt: new Date() })
    .where(and(eq(selfManagedAttachments.scanStatus, 'scanning'), lt(selfManagedAttachments.updatedAt, cutoff)))
    .returning({ id: selfManagedAttachments.id })

  return rows.length
}
