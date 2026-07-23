import { and, eq } from 'drizzle-orm'
import { publicDb } from '../db/client'
import { builderClaims, builderIdentities, publishedBuilderProfiles } from '../db/schema'

export async function findPublishedBuilderProfile(builderIdentityId: string) {
  const [profile] = await publicDb.select({
    id: builderIdentities.id,
    source: builderIdentities.source,
    username: builderIdentities.username,
    avatarUrl: builderIdentities.avatarUrl,
    profileUrl: builderIdentities.profileUrl,
    followersCount: builderIdentities.followersCount,
    language: builderIdentities.language,
    country: builderIdentities.country,
    displayName: publishedBuilderProfiles.displayName,
    bio: publishedBuilderProfiles.bio,
    openToStatus: publishedBuilderProfiles.openToStatus,
    topics: publishedBuilderProfiles.topics,
    publishedAt: publishedBuilderProfiles.publishedAt,
    updatedAt: publishedBuilderProfiles.updatedAt,
  }).from(publishedBuilderProfiles)
    .innerJoin(builderIdentities, eq(builderIdentities.id, publishedBuilderProfiles.builderIdentityId))
    .where(eq(publishedBuilderProfiles.builderIdentityId, builderIdentityId))
    .limit(1)
  return profile ?? null
}

/**
 * The one verified claim on a builder identity, if any — regardless of who
 * holds it. Used to render the "Claimed"/"is this your profile" state on
 * `/builder/:id`, which (unlike the public/claimed-and-published path above)
 * needs to know claim status even for tracked-but-unpublished builders.
 */
export async function findVerifiedBuilderClaim(builderIdentityId: string) {
  const [claim] = await publicDb.select({
    subjectUserId: builderClaims.subjectUserId,
    verifiedAt: builderClaims.verifiedAt,
  }).from(builderClaims)
    .where(and(eq(builderClaims.builderIdentityId, builderIdentityId), eq(builderClaims.status, 'verified')))
    .limit(1)
  return claim ?? null
}
