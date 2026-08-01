import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { publicDb } from '../db/client'
import { builderClaims, builderIdentities, publishedBuilderProfiles } from '../db/schema'

export async function findPublishedBuilderProfile(builderIdentityId: string, db: PostgresJsDatabase = publicDb) {
  const [profile] = await db.select({
    id: builderIdentities.id,
    source: builderIdentities.source,
    sourceId: builderIdentities.sourceId,
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
 *
 * Also carries `id`/`metadata` so callers can derive a `portfolioClaimId` —
 * the builder profile ↔ portfolio cross-link (plans/UI/tasks.md Wave 6) —
 * without a second query. A revoked/rejected/expired claim never matches
 * (the `status = 'verified'` filter), so the cross-link disappears the same
 * moment the claim itself would stop backing anything else on this page.
 */
export async function findVerifiedBuilderClaim(builderIdentityId: string, db: PostgresJsDatabase = publicDb) {
  const [claim] = await db.select({
    id: builderClaims.id,
    subjectUserId: builderClaims.subjectUserId,
    verifiedAt: builderClaims.verifiedAt,
    metadata: builderClaims.metadata,
  }).from(builderClaims)
    .where(and(eq(builderClaims.builderIdentityId, builderIdentityId), eq(builderClaims.status, 'verified')))
    .limit(1)
  return claim ?? null
}
