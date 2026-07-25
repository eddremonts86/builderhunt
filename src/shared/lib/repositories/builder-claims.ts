import { createHash } from 'node:crypto'
import { and, eq, gt } from 'drizzle-orm'
import type { TenantTransaction, publicDb } from '../db/client'
import {
  builderClaims,
  builderIdentities,
  publishedBuilderProfiles,
} from '../db/schema'

/** Builder claims aren't tenant-scoped (no `organizationId` column) — admin routes query them via `publicDb` directly, same as `public-builders.ts`'s reads. */
type ClaimsDb = TenantTransaction | typeof publicDb

export function hashClaimSecret(secret: string) {
  return createHash('sha256').update(`builderhunt:claim:v1:${secret}`).digest('hex')
}

/** Used by the stealth-scraping plan's subject-rights routes (restriction, provenance). */
export async function isVerifiedBuilderClaimant(
  transaction: TenantTransaction,
  subjectUserId: string,
  builderIdentityId: string,
): Promise<boolean> {
  const [claim] = await transaction.select({ id: builderClaims.id }).from(builderClaims)
    .where(and(
      eq(builderClaims.subjectUserId, subjectUserId),
      eq(builderClaims.builderIdentityId, builderIdentityId),
      eq(builderClaims.status, 'verified'),
    )).limit(1)
  return Boolean(claim)
}

export async function createPendingBuilderClaim(
  transaction: TenantTransaction,
  input: {
    id: string
    builderIdentityId: string
    subjectUserId: string
    evidenceSource: string
    evidenceReference: string
    verificationSecretHash: string | null
    expiresAt: Date
  },
) {
  const [identity] = await transaction.select({ id: builderIdentities.id })
    .from(builderIdentities)
    .where(eq(builderIdentities.id, input.builderIdentityId))
    .limit(1)
  if (!identity) return null
  const [claim] = await transaction.insert(builderClaims).values({
    id: input.id,
    builderIdentityId: input.builderIdentityId,
    subjectUserId: input.subjectUserId,
    evidenceSource: input.evidenceSource,
    evidenceReference: input.evidenceReference,
    verificationSecretHash: input.verificationSecretHash,
    status: 'pending',
    expiresAt: input.expiresAt,
  }).returning({ id: builderClaims.id })
  return claim ?? null
}

/** The identity's source + username — needed to pick a claim-source adapter and fetch its public profile. */
export async function getBuilderIdentitySourceInfo(transaction: TenantTransaction, builderIdentityId: string) {
  const [identity] = await transaction.select({
    source: builderIdentities.source,
    username: builderIdentities.username,
  }).from(builderIdentities).where(eq(builderIdentities.id, builderIdentityId)).limit(1)
  return identity ?? null
}

/** The caller's own pending claim on this identity, if any — the verify route reads the stored challenge/source from here rather than trusting client input. */
export async function findPendingBuilderClaim(
  transaction: TenantTransaction,
  input: { subjectUserId: string; builderIdentityId: string },
) {
  const [claim] = await transaction.select({
    id: builderClaims.id,
    evidenceSource: builderClaims.evidenceSource,
    evidenceReference: builderClaims.evidenceReference,
    expiresAt: builderClaims.expiresAt,
  }).from(builderClaims).where(and(
    eq(builderClaims.subjectUserId, input.subjectUserId),
    eq(builderClaims.builderIdentityId, input.builderIdentityId),
    eq(builderClaims.status, 'pending'),
  )).limit(1)
  return claim ?? null
}

async function publishVerifiedProfile(
  transaction: TenantTransaction,
  input: { builderIdentityId: string; subjectUserId: string },
) {
  const [identity] = await transaction.select({
    displayName: builderIdentities.displayName,
    bio: builderIdentities.bio,
  }).from(builderIdentities)
    .where(eq(builderIdentities.id, input.builderIdentityId))
    .limit(1)
  if (!identity) return false
  await transaction.insert(publishedBuilderProfiles).values({
    builderIdentityId: input.builderIdentityId,
    publishedByUserId: input.subjectUserId,
    displayName: identity.displayName,
    bio: identity.bio,
  }).onConflictDoUpdate({
    target: publishedBuilderProfiles.builderIdentityId,
    set: {
      publishedByUserId: input.subjectUserId,
      updatedAt: new Date(),
    },
  })
  return true
}

/**
 * Legacy email-token verification path. New claims never populate
 * `verificationSecretHash` (source-bound claims below use a public,
 * unhashed challenge instead), so this can only ever match a pre-existing
 * legacy claim — it is kept for that transition, not as an active path for
 * new claims.
 */
export async function verifyPendingBuilderClaim(
  transaction: TenantTransaction,
  input: { subjectUserId: string; verificationSecretHash: string },
) {
  const [claim] = await transaction.select({
    id: builderClaims.id,
    builderIdentityId: builderClaims.builderIdentityId,
  }).from(builderClaims).where(and(
    eq(builderClaims.subjectUserId, input.subjectUserId),
    eq(builderClaims.verificationSecretHash, input.verificationSecretHash),
    eq(builderClaims.status, 'pending'),
    gt(builderClaims.expiresAt, new Date()),
  )).limit(1)
  if (!claim) return null

  await transaction.update(builderClaims).set({
    status: 'verified',
    verifiedAt: new Date(),
    verificationSecretHash: null,
  }).where(and(
    eq(builderClaims.id, claim.id),
    eq(builderClaims.subjectUserId, input.subjectUserId),
  ))
  const published = await publishVerifiedProfile(transaction, {
    builderIdentityId: claim.builderIdentityId,
    subjectUserId: input.subjectUserId,
  })
  if (!published) return null
  return { builderIdentityId: claim.builderIdentityId }
}

/**
 * Source-bound verification: the caller already proved control of the
 * external account (the claim-source adapter confirmed the challenge is
 * live in their public bio) — this just needs to record that atomically.
 * A single conditional UPDATE...RETURNING (rather than the legacy
 * select-then-update above) closes the race where two concurrent requests
 * could both read `status = 'pending'` before either write lands: only the
 * request whose UPDATE actually flips the row can proceed to publish.
 */
export async function verifyBuilderClaimBySourceProof(
  transaction: TenantTransaction,
  input: { subjectUserId: string; builderIdentityId: string },
) {
  const [claim] = await transaction.update(builderClaims).set({
    status: 'verified',
    verifiedAt: new Date(),
  }).where(and(
    eq(builderClaims.subjectUserId, input.subjectUserId),
    eq(builderClaims.builderIdentityId, input.builderIdentityId),
    eq(builderClaims.status, 'pending'),
    gt(builderClaims.expiresAt, new Date()),
  )).returning({ id: builderClaims.id, builderIdentityId: builderClaims.builderIdentityId })
  if (!claim) return null

  const published = await publishVerifiedProfile(transaction, {
    builderIdentityId: claim.builderIdentityId,
    subjectUserId: input.subjectUserId,
  })
  if (!published) return null
  return { builderIdentityId: claim.builderIdentityId }
}

/** Admin-only. Recoverable: revoked claims keep their row (evidence intact) but stop counting as active — `findVerifiedBuilderClaim`/`findPublishedBuilderProfile` readers filter on `status = 'verified'`, so a revoked claim disappears from both immediately. */
export async function revokeBuilderClaim(
  transaction: ClaimsDb,
  input: { claimId: string; adminUserId: string; reason: string },
) {
  const [revoked] = await transaction.update(builderClaims).set({
    status: 'revoked',
    revokedAt: new Date(),
    revokedByUserId: input.adminUserId,
    revocationReason: input.reason,
  }).where(and(
    eq(builderClaims.id, input.claimId),
    eq(builderClaims.status, 'verified'),
  )).returning({ id: builderClaims.id, builderIdentityId: builderClaims.builderIdentityId })
  return revoked ?? null
}

export function listVerifiedBuilderProfiles(transaction: TenantTransaction, subjectUserId: string) {
  return transaction.select({
    id: builderIdentities.id,
    username: builderIdentities.username,
    source: builderIdentities.source,
    avatarUrl: builderIdentities.avatarUrl,
    profileUrl: builderIdentities.profileUrl,
    displayName: publishedBuilderProfiles.displayName,
    bio: publishedBuilderProfiles.bio,
    claimedTopics: publishedBuilderProfiles.topics,
    openToStatus: publishedBuilderProfiles.openToStatus,
    publishedAt: publishedBuilderProfiles.publishedAt,
    updatedAt: publishedBuilderProfiles.updatedAt,
  }).from(builderClaims)
    .innerJoin(builderIdentities, eq(builderIdentities.id, builderClaims.builderIdentityId))
    .innerJoin(publishedBuilderProfiles, eq(publishedBuilderProfiles.builderIdentityId, builderClaims.builderIdentityId))
    .where(and(
      eq(builderClaims.subjectUserId, subjectUserId),
      eq(builderClaims.status, 'verified'),
    ))
}

export async function updateVerifiedBuilderProfile(
  transaction: TenantTransaction,
  input: {
    subjectUserId: string
    builderIdentityId: string
    topics?: string[]
    openToStatus?: string[]
    bio?: string
  },
) {
  const [claim] = await transaction.select({ id: builderClaims.id }).from(builderClaims)
    .where(and(
      eq(builderClaims.subjectUserId, input.subjectUserId),
      eq(builderClaims.builderIdentityId, input.builderIdentityId),
      eq(builderClaims.status, 'verified'),
    )).limit(1)
  if (!claim) return null
  const [updated] = await transaction.update(publishedBuilderProfiles).set({
    ...(input.topics === undefined ? {} : { topics: input.topics }),
    ...(input.openToStatus === undefined ? {} : { openToStatus: input.openToStatus }),
    ...(input.bio === undefined ? {} : { bio: input.bio }),
    updatedAt: new Date(),
  }).where(and(
    eq(publishedBuilderProfiles.builderIdentityId, input.builderIdentityId),
    eq(publishedBuilderProfiles.publishedByUserId, input.subjectUserId),
  )).returning()
  return updated ?? null
}
