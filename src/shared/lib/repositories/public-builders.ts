import { eq } from 'drizzle-orm'
import { publicDb } from '../db/client'
import { builderIdentities, publishedBuilderProfiles } from '../db/schema'

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
