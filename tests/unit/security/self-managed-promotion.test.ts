/**
 * Promotion to a verified claim (plan: phase-2/07-perfiles-autogestionados).
 *
 * Filed under `tests/unit/security/` because that is what this is: the one place where a page of
 * self-declared content can acquire a *verified* identity. Everything below is a way of getting it
 * wrong — somebody else's claim, an unverified one, a revoked one, a claim already backing another
 * page, and above all a resemblance strong enough that somebody might be tempted to trust it.
 *
 * Against a real disposable Postgres, because the last guarantee is a partial unique index and the
 * others are `WHERE` clauses.
 */
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { TenantTransaction } from '~/shared/lib/db/client'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, builderClaims, builderIdentities, selfManagedAttachments, selfManagedProfiles } from '~/shared/lib/db/schema'
import { decideLink, LINK_METHODS } from '~/shared/lib/human-identity/link-policy'
import {
  createProfile,
  getPublicProfileByHandle,
  promoteToBuilderClaim,
  unlinkBuilderClaim,
} from '~/shared/lib/repositories/self-managed-profiles'
import { addAttachment } from '~/shared/lib/repositories/self-managed-attachments'

let db: PostgresJsDatabase
let drop: () => Promise<void>
const tx = () => db as unknown as TenantTransaction

const NOW = new Date('2027-08-01T10:00:00Z')

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('self_managed_promotion')
  db = disposable.db
  drop = disposable.drop

  await db.insert(authUsers).values(
    ['own-a', 'own-b'].map((id) => ({
      id, name: id, email: `${id}@test.invalid`, emailVerified: true, createdAt: NOW, updatedAt: NOW,
    })),
  )
  await db.insert(builderIdentities).values(
    ['ident-a', 'ident-b', 'ident-c'].map((id) => ({
      id, source: 'github', sourceId: id, kind: 'person' as const, username: id, profileUrl: `https://github.com/${id}`,
    })),
  )
}, 120_000)

afterAll(async () => {
  await drop?.()
})

beforeEach(async () => {
  await db.delete(selfManagedAttachments)
  await db.delete(selfManagedProfiles)
  await db.delete(builderClaims)
})

async function seedProfile(ownerUserId: string, handle: string) {
  return createProfile(tx(), {
    ownerUserId,
    profile: { handle, displayName: handle, languages: [], services: [], topics: [], visibility: 'public' } as never,
    now: NOW,
  })
}

async function seedClaim(id: string, subjectUserId: string, overrides: Record<string, unknown> = {}) {
  await db.insert(builderClaims).values({
    id,
    builderIdentityId: overrides.builderIdentityId as string ?? 'ident-a',
    subjectUserId,
    evidenceSource: 'github',
    evidenceReference: `https://gist.github.com/${id}`,
    status: 'verified',
    verifiedAt: NOW,
    createdAt: NOW,
    ...overrides,
  } as never)
  return id
}

describe('what promotion requires', () => {
  it('links a verified claim the caller owns, and keeps everything the profile had', async () => {
    const profile = await seedProfile('own-a', 'ada')
    await addAttachment(tx(), {
      ownerUserId: 'own-a',
      attachment: { kind: 'work-sample', title: 'A manual' },
      storageKey: 'clean/self-managed/a/p/one',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      checksumSha256: 'a'.repeat(64),
      now: NOW,
    })
    const claimId = await seedClaim('claim-1', 'own-a')

    const promoted = await promoteToBuilderClaim(tx(), { ownerUserId: 'own-a', profileId: profile.id, claimId })

    expect(promoted.promotedToBuilderClaimId).toBe(claimId)
    // Additive: the handle, the words and the attachments are all still the profile's own.
    expect(promoted.handle).toBe('ada')
    expect(promoted.displayName).toBe('ada')
    const attachments = await db.select().from(selfManagedAttachments)
    expect(attachments).toHaveLength(1)
  })

  it('makes the claim authoritative for `verified`, by join rather than by copy', async () => {
    const profile = await seedProfile('own-a', 'ada')
    const claimId = await seedClaim('claim-1', 'own-a')

    expect((await getPublicProfileByHandle(tx(), 'ada'))!.verified).toBe(false)
    await promoteToBuilderClaim(tx(), { ownerUserId: 'own-a', profileId: profile.id, claimId })
    expect((await getPublicProfileByHandle(tx(), 'ada'))!.verified).toBe(true)

    // Revoked at the claim, and the page stops saying verified in the same read — nothing had to be
    // undone here, which is the whole point of deriving it instead of storing it.
    await db.update(builderClaims).set({ status: 'revoked', revokedAt: NOW }).where(eq(builderClaims.id, claimId))
    expect((await getPublicProfileByHandle(tx(), 'ada'))!.verified).toBe(false)
  })

  it('refuses an unverified claim', async () => {
    const profile = await seedProfile('own-a', 'ada')
    await seedClaim('claim-pending', 'own-a', { status: 'pending', verifiedAt: null })

    await expect(
      promoteToBuilderClaim(tx(), { ownerUserId: 'own-a', profileId: profile.id, claimId: 'claim-pending' }),
    ).rejects.toMatchObject({ code: 'claim-not-verified' })
  })

  it('refuses a revoked claim even while its status still says verified', async () => {
    const profile = await seedProfile('own-a', 'ada')
    // The shape a writer being wrong once leaves behind. This is the read that would publish it.
    await seedClaim('claim-revoked', 'own-a', { revokedAt: NOW })

    await expect(
      promoteToBuilderClaim(tx(), { ownerUserId: 'own-a', profileId: profile.id, claimId: 'claim-revoked' }),
    ).rejects.toMatchObject({ code: 'claim-not-verified' })
  })

  it('treats another person’s claim exactly like one that does not exist', async () => {
    const profile = await seedProfile('own-a', 'ada')
    await seedClaim('claim-theirs', 'own-b')

    const foreign = await promoteToBuilderClaim(tx(), { ownerUserId: 'own-a', profileId: profile.id, claimId: 'claim-theirs' })
      .catch((error) => error)
    const absent = await promoteToBuilderClaim(tx(), { ownerUserId: 'own-a', profileId: profile.id, claimId: 'claim-nope' })
      .catch((error) => error)

    // Identical, so this cannot be used to learn that a claim id exists on another account.
    expect(foreign.code).toBe('claim-not-found')
    expect(absent.code).toBe('claim-not-found')
  })

  it('refuses a profile that is not the caller’s own', async () => {
    const mine = await seedProfile('own-a', 'ada')
    await seedProfile('own-b', 'grace')
    await seedClaim('claim-1', 'own-b')

    await expect(
      promoteToBuilderClaim(tx(), { ownerUserId: 'own-b', profileId: mine.id, claimId: 'claim-1' }),
    ).rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('one claim, one page', () => {
  it('is refused by the database when two live profiles reach for one claim', async () => {
    const first = await seedProfile('own-a', 'ada')
    const claimId = await seedClaim('claim-1', 'own-a')
    await promoteToBuilderClaim(tx(), { ownerUserId: 'own-a', profileId: first.id, claimId })

    /*
     * Written straight past the repository, because that is the only way to reach this state.
     *
     * Promotion requires `claim.subject_user_id === ownerUserId`, and
     * `self_managed_profiles_owner_live_unique` allows one live profile per person — so two live
     * profiles pointing at one claim is already unreachable through the API. The index is defence
     * in depth against a writer that is not this repository, and defence in depth is only worth
     * having if somebody checks it holds.
     */
    await expect(
      db.insert(selfManagedProfiles).values({
        id: 'smp-second',
        handle: 'ada-two',
        ownerUserId: 'own-b',
        displayName: 'Ada Two',
        visibility: 'public',
        promotedToBuilderClaimId: claimId,
        declaredAt: NOW,
        updatedAt: NOW,
      } as never),
    ).rejects.toMatchObject({ cause: { code: '23505' } })
  })

  it('lets a soft-deleted profile release its claim rather than holding it for thirty days', async () => {
    const first = await seedProfile('own-a', 'ada')
    const claimId = await seedClaim('claim-1', 'own-a')
    await promoteToBuilderClaim(tx(), { ownerUserId: 'own-a', profileId: first.id, claimId })
    await db.update(selfManagedProfiles).set({ deletedAt: NOW }).where(eq(selfManagedProfiles.id, first.id))

    // Partial on live rows, like the handle and owner indexes beside it: a deleted page must not
    // hold a verified identity hostage, and the error would read "already linked" about a link
    // nobody can see.
    await db.insert(selfManagedProfiles).values({
      id: 'smp-second',
      handle: 'ada-two',
      ownerUserId: 'own-b',
      displayName: 'Ada Two',
      visibility: 'public',
      promotedToBuilderClaimId: claimId,
      declaredAt: NOW,
      updatedAt: NOW,
    } as never)

    const rows = await db.select({ id: selfManagedProfiles.id }).from(selfManagedProfiles)
    expect(rows).toHaveLength(2)
  })

  it('frees the claim once the first link is undone', async () => {
    const profile = await seedProfile('own-a', 'ada')
    const claimId = await seedClaim('claim-1', 'own-a')

    await promoteToBuilderClaim(tx(), { ownerUserId: 'own-a', profileId: profile.id, claimId })
    const unlinked = await unlinkBuilderClaim(tx(), { ownerUserId: 'own-a', profileId: profile.id })
    expect(unlinked.promotedToBuilderClaimId).toBeNull()

    const relinked = await promoteToBuilderClaim(tx(), { ownerUserId: 'own-a', profileId: profile.id, claimId })
    expect(relinked.promotedToBuilderClaimId).toBe(claimId)
  })
})

describe('unlink', () => {
  it('keeps the profile and its attachments, and only drops the link', async () => {
    const profile = await seedProfile('own-a', 'ada')
    await addAttachment(tx(), {
      ownerUserId: 'own-a',
      attachment: { kind: 'cv', title: 'CV' },
      storageKey: 'clean/self-managed/a/p/cv',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      checksumSha256: 'b'.repeat(64),
      now: NOW,
    })
    await promoteToBuilderClaim(tx(), { ownerUserId: 'own-a', profileId: profile.id, claimId: await seedClaim('claim-1', 'own-a') })

    const unlinked = await unlinkBuilderClaim(tx(), { ownerUserId: 'own-a', profileId: profile.id })

    expect(unlinked.promotedToBuilderClaimId).toBeNull()
    expect(unlinked.handle).toBe('ada')
    expect(await db.select().from(selfManagedAttachments)).toHaveLength(1)
    expect((await getPublicProfileByHandle(tx(), 'ada'))!.verified).toBe(false)
  })

  it('is a no-op rather than an error on a profile that was never promoted', async () => {
    const profile = await seedProfile('own-a', 'ada')
    const result = await unlinkBuilderClaim(tx(), { ownerUserId: 'own-a', profileId: profile.id })
    expect(result.promotedToBuilderClaimId).toBeNull()
  })

  it('cannot be aimed at somebody else’s profile', async () => {
    const mine = await seedProfile('own-a', 'ada')
    await expect(
      unlinkBuilderClaim(tx(), { ownerUserId: 'own-b', profileId: mine.id }),
    ).rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('resemblance is never evidence', () => {
  it('has no path from a similarity score to a link, however high', () => {
    // The guarantee is structural rather than a threshold check: `promoteToBuilderClaim` accepts a
    // claim id and nothing else, so a probabilistic signal cannot be constructed from its input at
    // all. What the link policy says about such a signal is asserted here so the two stay aligned.
    const perfect = decideLink({ kind: 'probabilistic', basis: 'display_name', similarityBps: 10_000 })
    expect(perfect.reviewState).toBe('pending_review')
    expect(perfect.method).toBe('probabilistic_candidate')

    const proven = decideLink({ kind: 'verified_claim', claimId: 'claim-1', subjectUserId: 'own-a' })
    expect(proven.reviewState).toBe('auto_approved')
    expect(LINK_METHODS).toContain(proven.method)
  })

  it('does not link a claim just because the handles match', async () => {
    const profile = await seedProfile('own-a', 'ada')
    // A claim on a *different* account whose username is identical to this profile's handle: the
    // single most tempting false positive, and the one `dedup.ts` was once wrong about.
    await db.insert(builderIdentities).values({
      id: 'ident-ada', source: 'github', sourceId: 'ada', kind: 'person' as const, username: 'ada',
      profileUrl: 'https://github.com/ada',
    })
    await seedClaim('claim-lookalike', 'own-b', { builderIdentityId: 'ident-ada' })

    await expect(
      promoteToBuilderClaim(tx(), { ownerUserId: 'own-a', profileId: profile.id, claimId: 'claim-lookalike' }),
    ).rejects.toMatchObject({ code: 'claim-not-found' })

    expect((await getPublicProfileByHandle(tx(), 'ada'))!.verified).toBe(false)
  })
})
