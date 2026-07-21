import { createHash } from 'node:crypto'
import { and, eq, gt } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import {
  builderClaims,
  builderIdentities,
  publishedBuilderProfiles,
} from '../db/schema'

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
    email: string
    verificationSecretHash: string
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
    evidenceSource: 'email',
    evidenceReference: input.email.toLowerCase(),
    verificationSecretHash: input.verificationSecretHash,
    status: 'pending',
    expiresAt: input.expiresAt,
  }).returning({ id: builderClaims.id })
  return claim ?? null
}

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

  const [identity] = await transaction.select({
    displayName: builderIdentities.displayName,
    bio: builderIdentities.bio,
  }).from(builderIdentities)
    .where(eq(builderIdentities.id, claim.builderIdentityId))
    .limit(1)
  if (!identity) return null

  await transaction.update(builderClaims).set({
    status: 'verified',
    verifiedAt: new Date(),
    verificationSecretHash: null,
  }).where(and(
    eq(builderClaims.id, claim.id),
    eq(builderClaims.subjectUserId, input.subjectUserId),
  ))
  await transaction.insert(publishedBuilderProfiles).values({
    builderIdentityId: claim.builderIdentityId,
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
  return { builderIdentityId: claim.builderIdentityId }
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
