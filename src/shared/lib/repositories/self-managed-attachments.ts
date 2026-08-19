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
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm'

import { randomId } from '~/lib/utils'
import type { TenantTransaction } from '../db/client'
import { selfManagedAttachments, selfManagedProfiles } from '../db/schema'
import {
  MAX_ACTIVE_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  type SelfManagedAttachmentKind,
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
  sizeBytes: number
  durationSeconds: number | null
  checksumSha256: string
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

function rowToAttachment(row: { kind: string } & Omit<SelfManagedAttachment, 'kind'>): SelfManagedAttachment {
  // A stored kind outside the set would have to have been written around the CHECK constraint.
  // Reading it back as `other` keeps one bad row from throwing on a page that lists twelve.
  const kind = row.kind === 'cv' || row.kind === 'work-sample' || row.kind === 'certificate' ? row.kind : 'other'
  return { ...row, kind }
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
    // The ceiling is the model's, not a page size: `addAttachment` counts live rows in the same
    // transaction as the insert and refuses the thirteenth, so twelve is every row there can be.
    .limit(MAX_ACTIVE_ATTACHMENTS)

  return rows.map(rowToAttachment)
}

/**
 * What a stranger sees on a profile page.
 *
 * The visibility test is a join against the profile rather than a column on the attachment, matching
 * the row policy in `0175`. Two places to keep in step is how an attachment outlives the decision to
 * hide the profile it belongs to.
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
   * Set by the server after the upload lands in `clean/`, never accepted from a request body — the
   * key names a real object and a caller-chosen one is a caller-chosen file.
   */
  storageKey: string
  mimeType: string
  sizeBytes: number
  checksumSha256: string
  durationSeconds?: number | null
  now?: Date
}

/**
 * Record an attachment whose bytes are already stored and scanned.
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

  if (input.sizeBytes <= 0 || input.sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new SelfManagedAttachmentError(
      'too-large',
      `An attachment is at most ${MAX_ATTACHMENT_BYTES} bytes; this one is ${input.sizeBytes}`,
    )
  }

  const [live] = await transaction
    .select({ total: count() })
    .from(selfManagedAttachments)
    .where(and(eq(selfManagedAttachments.profileId, profileId), isNull(selfManagedAttachments.deletedAt)))
  if ((live?.total ?? 0) >= MAX_ACTIVE_ATTACHMENTS) {
    throw new SelfManagedAttachmentError('too-many', `A profile holds at most ${MAX_ACTIVE_ATTACHMENTS} attachments`)
  }

  if (input.attachment.kind === 'cv') {
    const [cv] = await transaction
      .select({ total: count() })
      .from(selfManagedAttachments)
      .where(
        and(
          eq(selfManagedAttachments.profileId, profileId),
          eq(selfManagedAttachments.kind, 'cv'),
          isNull(selfManagedAttachments.deletedAt),
        ),
      )
    if ((cv?.total ?? 0) > 0) {
      throw new SelfManagedAttachmentError('cv-exists', 'This profile already has a CV; delete it before adding another')
    }
  }

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
      uploadedAt: now,
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
    .set({ deletedAt: now })
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
