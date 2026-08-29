/**
 * The self-managed attachment repository (plan: phase-2/07-perfiles-autogestionados, task 2).
 *
 * Superuser connection, so nothing here is evidence about RLS — see the note on the profile
 * repository's tests. What these do prove is the part RLS cannot: the two limits from the spec
 * (twelve live attachments, one live CV), and that every function scopes its `WHERE` to the caller's
 * own profile. An attachment id is guessable and arrives from a URL, so "matches this id" and
 * "matches this id *on your profile*" are the whole difference between an edit and a defacement.
 */
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { TenantTransaction } from '~/shared/lib/db/client'
import type { WorkerTransaction } from '~/shared/lib/db/worker-db'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, selfManagedAttachments, selfManagedProfiles } from '~/shared/lib/db/schema'
import { MAX_ACTIVE_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from '~/shared/lib/self-managed/contracts'
import {
  addAttachment,
  leaseAttachmentsForScan,
  listOwnAttachments,
  listPublicAttachments,
  listPurgeableAttachments,
  markAttachmentClean,
  markAttachmentRejected,
  purgeDeletedAttachments,
  reclaimStaleAttachmentScans,
  releaseAttachmentForScanRetry,
  softDeleteAttachment,
  updateAttachment,
} from '~/shared/lib/repositories/self-managed-attachments'
import { createProfile, setVisibility, softDeleteProfile } from '~/shared/lib/repositories/self-managed-profiles'

let db: PostgresJsDatabase
let drop: () => Promise<void>
const tx = () => db as unknown as TenantTransaction
const wtx = () => db as unknown as WorkerTransaction

/** The worker's half of the flow, for tests about what a stranger sees after a clean verdict. */
async function scanCleanInPlace(attachment: { id: string; storageKey: string }) {
  await markAttachmentClean(wtx(), { attachmentId: attachment.id, cleanObjectKey: attachment.storageKey })
}

const NOW = new Date('2027-03-01T10:00:00Z')

/** One upload's worth of server-set facts. `key` varies because storage keys are unique everywhere. */
function upload(key: string, overrides: Partial<Parameters<typeof addAttachment>[1]> = {}) {
  return {
    ownerUserId: 'owner-a',
    attachment: { kind: 'work-sample' as const, title: key },
    storageKey: `clean/${key}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    checksumSha256: 'a'.repeat(64),
    now: NOW,
    ...overrides,
  }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('repo_self_managed_att')
  db = disposable.db
  drop = disposable.drop

  await db.insert(authUsers).values(
    ['owner-a', 'owner-b'].map((id) => ({
      id,
      name: id,
      email: `${id}@test.invalid`,
      emailVerified: true,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  )
}, 120_000)

afterAll(async () => {
  await drop?.()
})

beforeEach(async () => {
  await db.delete(selfManagedAttachments)
  await db.delete(selfManagedProfiles)

  await createProfile(tx(), {
    ownerUserId: 'owner-a',
    profile: { handle: 'ada', displayName: 'Ada', languages: [], services: [], topics: [], visibility: 'public' },
    now: NOW,
  })
})

describe('addAttachment', () => {
  it('records what the server measured and hangs it off the owner’s own profile', async () => {
    const added = await addAttachment(tx(), upload('one'))

    expect(added.title).toBe('one')
    expect(added.storageKey).toBe('clean/one.pdf')
    expect(await listOwnAttachments(tx(), 'owner-a')).toHaveLength(1)
  })

  it('refuses when the account has no profile to attach to', async () => {
    await expect(
      addAttachment(tx(), upload('orphan', { ownerUserId: 'owner-b' })),
    ).rejects.toMatchObject({ code: 'no-profile' })
  })

  it('stops at twelve live attachments', async () => {
    for (let index = 0; index < MAX_ACTIVE_ATTACHMENTS; index += 1) {
      await addAttachment(tx(), upload(`sample-${index}`))
    }

    await expect(addAttachment(tx(), upload('one-too-many'))).rejects.toMatchObject({ code: 'too-many' })
  })

  it('counts only live ones, so deleting makes room again', async () => {
    for (let index = 0; index < MAX_ACTIVE_ATTACHMENTS; index += 1) {
      await addAttachment(tx(), upload(`sample-${index}`))
    }
    const [first] = await listOwnAttachments(tx(), 'owner-a')
    await softDeleteAttachment(tx(), { ownerUserId: 'owner-a', attachmentId: first!.id, now: NOW })

    const replacement = await addAttachment(tx(), upload('replacement'))
    expect(replacement.title).toBe('replacement')
  })

  it('allows one CV and refuses a second', async () => {
    await addAttachment(tx(), upload('cv', { attachment: { kind: 'cv', title: 'CV' } }))

    await expect(
      addAttachment(tx(), upload('cv-again', { attachment: { kind: 'cv', title: 'CV again' } })),
    ).rejects.toMatchObject({ code: 'cv-exists' })
  })

  it('lets a deleted CV be replaced', async () => {
    const cv = await addAttachment(tx(), upload('cv', { attachment: { kind: 'cv', title: 'CV' } }))
    await softDeleteAttachment(tx(), { ownerUserId: 'owner-a', attachmentId: cv.id, now: NOW })

    const replacement = await addAttachment(tx(), upload('cv-two', { attachment: { kind: 'cv', title: 'CV 2026' } }))
    expect(replacement.kind).toBe('cv')
  })

  it('refuses a file past the cap, with a message rather than a constraint violation', async () => {
    await expect(
      addAttachment(tx(), upload('huge', { sizeBytes: MAX_ATTACHMENT_BYTES + 1 })),
    ).rejects.toMatchObject({ code: 'too-large' })
  })
})

describe('updateAttachment', () => {
  it('changes the words and leaves the bytes alone', async () => {
    const added = await addAttachment(tx(), upload('one'))

    const updated = await updateAttachment(tx(), {
      ownerUserId: 'owner-a',
      attachmentId: added.id,
      attachment: { kind: 'certificate', title: 'Renamed', description: 'Now described' },
    })

    expect(updated.title).toBe('Renamed')
    expect(updated.kind).toBe('certificate')
    // The four fields that describe the scanned object are not in the update's `set` at all, so
    // there is no path from a request to a row pointing at a file the scanner never saw.
    expect(updated.storageKey).toBe(added.storageKey)
    expect(updated.checksumSha256).toBe(added.checksumSha256)
    expect(updated.sizeBytes).toBe(added.sizeBytes)
  })

  it('treats another person’s attachment id as if it did not exist', async () => {
    const added = await addAttachment(tx(), upload('one'))
    await createProfile(tx(), {
      ownerUserId: 'owner-b',
      profile: { handle: 'grace', displayName: 'Grace', languages: [], services: [], topics: [], visibility: 'public' },
      now: NOW,
    })

    await expect(
      updateAttachment(tx(), {
        ownerUserId: 'owner-b',
        attachmentId: added.id,
        attachment: { kind: 'other', title: 'Defaced' },
      }),
    ).rejects.toMatchObject({ code: 'not-found' })

    expect((await listOwnAttachments(tx(), 'owner-a'))[0]?.title).toBe('one')
  })
})

describe('softDeleteAttachment', () => {
  it('hides it from the owner and reports whether anything happened', async () => {
    const added = await addAttachment(tx(), upload('one'))

    expect(await softDeleteAttachment(tx(), { ownerUserId: 'owner-a', attachmentId: added.id, now: NOW })).toBe(true)
    expect(await listOwnAttachments(tx(), 'owner-a')).toHaveLength(0)
    // Idempotent: a second delete is not an error, it is simply nothing to do.
    expect(await softDeleteAttachment(tx(), { ownerUserId: 'owner-a', attachmentId: added.id, now: NOW })).toBe(false)
  })

  it('cannot be aimed at somebody else’s attachment', async () => {
    const added = await addAttachment(tx(), upload('one'))
    await createProfile(tx(), {
      ownerUserId: 'owner-b',
      profile: { handle: 'grace', displayName: 'Grace', languages: [], services: [], topics: [], visibility: 'public' },
      now: NOW,
    })

    expect(await softDeleteAttachment(tx(), { ownerUserId: 'owner-b', attachmentId: added.id, now: NOW })).toBe(false)
    expect(await listOwnAttachments(tx(), 'owner-a')).toHaveLength(1)
  })
})

describe('listPublicAttachments', () => {
  it('serves nothing the scanner has not cleared, whatever the profile’s visibility', async () => {
    const added = await addAttachment(tx(), upload('one'))

    // Born `pending`: stored and verified, but the scan worker has not spoken yet.
    expect(added.scanStatus).toBe('pending')
    expect(await listPublicAttachments(tx(), 'ada')).toHaveLength(0)

    // A rejection is just as invisible — and only the owner's list carries the why.
    await markAttachmentRejected(wtx(), { attachmentId: added.id, scanStatus: 'infected', rejectionCode: 'eicar' })
    expect(await listPublicAttachments(tx(), 'ada')).toHaveLength(0)
    expect((await listOwnAttachments(tx(), 'owner-a'))[0]?.rejectionCode).toBe('eicar')
  })

  it('follows the profile’s visibility rather than a flag of its own', async () => {
    const added = await addAttachment(tx(), upload('one'))
    await scanCleanInPlace(added)
    expect(await listPublicAttachments(tx(), 'ada')).toHaveLength(1)

    await setVisibility(tx(), { ownerUserId: 'owner-a', visibility: 'unlisted', now: NOW })
    expect(await listPublicAttachments(tx(), 'ada')).toHaveLength(1)

    // Back to draft and the attachments go with it, in the same statement rather than a second one.
    await setVisibility(tx(), { ownerUserId: 'owner-a', visibility: 'draft', now: NOW })
    expect(await listPublicAttachments(tx(), 'ada')).toHaveLength(0)
  })

  it('goes silent when the profile is soft-deleted', async () => {
    const added = await addAttachment(tx(), upload('one'))
    await scanCleanInPlace(added)
    await softDeleteProfile(tx(), { ownerUserId: 'owner-a', now: NOW })

    expect(await listPublicAttachments(tx(), 'ada')).toHaveLength(0)
  })
})

describe('the scan pipeline', () => {
  it('leases only pending live rows under the attempt cap, oldest upload first', async () => {
    const oldest = await addAttachment(tx(), upload('oldest', { now: new Date(NOW.getTime() - 2000) }))
    const newer = await addAttachment(tx(), upload('newer', { now: new Date(NOW.getTime() - 1000) }))
    const deleted = await addAttachment(tx(), upload('deleted'))
    await softDeleteAttachment(tx(), { ownerUserId: 'owner-a', attachmentId: deleted.id, now: NOW })
    const exhausted = await addAttachment(tx(), upload('exhausted'))
    await db.update(selfManagedAttachments).set({ scanAttempts: 3 }).where(eq(selfManagedAttachments.id, exhausted.id))
    const alreadyClean = await addAttachment(tx(), upload('already-clean'))
    await scanCleanInPlace(alreadyClean)

    // `RETURNING` order is not the subquery's `ORDER BY` — what the query promises is which rows
    // fall under the limit. A limit of one must claim the owner who has waited longest.
    const first = await leaseAttachmentsForScan(wtx(), { limit: 1, maxAttempts: 3 })
    expect(first.map((row) => row.id)).toEqual([oldest.id])
    expect(first[0]).toMatchObject({ storageKey: oldest.storageKey, mimeType: 'application/pdf', scanAttempts: 1 })

    // The rest of the queue is one row: deleted, exhausted and clean are nobody's work.
    const rest = await leaseAttachmentsForScan(wtx(), { limit: 10, maxAttempts: 3 })
    expect(rest.map((row) => row.id)).toEqual([newer.id])

    const [row] = await db
      .select({ scanStatus: selfManagedAttachments.scanStatus, scanAttempts: selfManagedAttachments.scanAttempts })
      .from(selfManagedAttachments)
      .where(eq(selfManagedAttachments.id, oldest.id))
    expect(row).toMatchObject({ scanStatus: 'scanning', scanAttempts: 1 })
  })

  it('marks clean with the promoted key, in the same statement', async () => {
    const added = await addAttachment(tx(), upload('one', { storageKey: 'quarantine/self-managed/o/p/one' }))
    await leaseAttachmentsForScan(wtx(), { limit: 1, maxAttempts: 3 })

    await markAttachmentClean(wtx(), { attachmentId: added.id, cleanObjectKey: 'clean/self-managed/o/p/one' })

    const [row] = await db
      .select({ scanStatus: selfManagedAttachments.scanStatus, storageKey: selfManagedAttachments.storageKey })
      .from(selfManagedAttachments)
      .where(eq(selfManagedAttachments.id, added.id))
    expect(row).toMatchObject({ scanStatus: 'clean', storageKey: 'clean/self-managed/o/p/one' })
    expect(await listPublicAttachments(tx(), 'ada')).toHaveLength(1)
  })

  it('truncates a rejection code to what a status field may carry', async () => {
    const added = await addAttachment(tx(), upload('one'))

    await markAttachmentRejected(wtx(), { attachmentId: added.id, scanStatus: 'failed', rejectionCode: 'x'.repeat(200) })

    const [row] = await db
      .select({ rejectionCode: selfManagedAttachments.rejectionCode })
      .from(selfManagedAttachments)
      .where(eq(selfManagedAttachments.id, added.id))
    expect(row?.rejectionCode).toBe('x'.repeat(64))
  })

  it('releases a transient failure back to the queue with its attempt kept', async () => {
    const added = await addAttachment(tx(), upload('one'))
    await leaseAttachmentsForScan(wtx(), { limit: 1, maxAttempts: 3 })

    await releaseAttachmentForScanRetry(wtx(), { attachmentId: added.id })

    const [row] = await db
      .select({ scanStatus: selfManagedAttachments.scanStatus, scanAttempts: selfManagedAttachments.scanAttempts })
      .from(selfManagedAttachments)
      .where(eq(selfManagedAttachments.id, added.id))
    expect(row).toMatchObject({ scanStatus: 'pending', scanAttempts: 1 })
  })

  it('reclaims a stale lease and leaves a fresh one alone', async () => {
    const stale = await addAttachment(tx(), upload('stale'))
    const fresh = await addAttachment(tx(), upload('fresh'))
    await db.update(selfManagedAttachments)
      .set({ scanStatus: 'scanning', updatedAt: new Date(NOW.getTime() - 60 * 60_000) })
      .where(eq(selfManagedAttachments.id, stale.id))
    await db.update(selfManagedAttachments)
      .set({ scanStatus: 'scanning', updatedAt: NOW })
      .where(eq(selfManagedAttachments.id, fresh.id))

    expect(await reclaimStaleAttachmentScans(wtx(), { staleAfterMs: 15 * 60_000, now: NOW })).toBe(1)

    const rows = await db
      .select({ id: selfManagedAttachments.id, scanStatus: selfManagedAttachments.scanStatus })
      .from(selfManagedAttachments)
    expect(rows.find((row) => row.id === stale.id)?.scanStatus).toBe('pending')
    expect(rows.find((row) => row.id === fresh.id)?.scanStatus).toBe('scanning')
  })

  it('lets the constraints refuse a rejection without a reason, and a reason without a rejection', async () => {
    const added = await addAttachment(tx(), upload('one'))

    // Straight past the repository, the way only a bug could write: the CHECK is the last line.
    await expect(
      db.update(selfManagedAttachments).set({ scanStatus: 'infected' }).where(eq(selfManagedAttachments.id, added.id)),
    ).rejects.toMatchObject({ cause: { code: '23514' } })
    await expect(
      db.update(selfManagedAttachments).set({ rejectionCode: 'oops' }).where(eq(selfManagedAttachments.id, added.id)),
    ).rejects.toMatchObject({ cause: { code: '23514' } })
  })

  it('keeps the no-bytes window one state wide', async () => {
    const added = await addAttachment(tx(), upload('one'))

    await expect(
      db.update(selfManagedAttachments).set({ checksumSha256: null }).where(eq(selfManagedAttachments.id, added.id)),
    ).rejects.toMatchObject({ cause: { code: '23514' } })
  })
})

describe('the storage sweep', () => {
  it('offers only rows deleted before the cutoff, oldest first and bounded', async () => {
    const ids: string[] = []
    for (const index of [0, 1, 2]) {
      const added = await addAttachment(tx(), upload(`sample-${index}`))
      ids.push(added.id)
      await softDeleteAttachment(tx(), {
        ownerUserId: 'owner-a',
        attachmentId: added.id,
        now: new Date(NOW.getTime() + index * 1000),
      })
    }
    const live = await addAttachment(tx(), upload('still-here'))

    const cutoff = new Date(NOW.getTime() + 10_000)
    const first = await listPurgeableAttachments(tx(), { deletedBefore: cutoff, limit: 2 })
    expect(first.map((row) => row.id)).toEqual([ids[0], ids[1]])
    expect(first.map((row) => row.id)).not.toContain(live.id)
  })

  it('deletes exactly the ids it is handed, and never a live row', async () => {
    const doomed = await addAttachment(tx(), upload('doomed'))
    const live = await addAttachment(tx(), upload('live'))
    await softDeleteAttachment(tx(), { ownerUserId: 'owner-a', attachmentId: doomed.id, now: NOW })

    // Passing the live id alongside is the case that matters: a caller that built its list from a
    // stale read must not be able to delete a row whose bytes are still in use.
    expect(await purgeDeletedAttachments(tx(), [doomed.id, live.id])).toBe(1)

    const left = await db.select({ id: selfManagedAttachments.id }).from(selfManagedAttachments)
    expect(left.map((row) => row.id)).toEqual([live.id])
  })

  it('does nothing when handed an empty list', async () => {
    expect(await purgeDeletedAttachments(tx(), [])).toBe(0)
  })
})
