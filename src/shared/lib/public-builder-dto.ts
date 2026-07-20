export interface PublicBuilderSource {
  id: string
  source: string
  sourceId: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  profileUrl: string
  bio: string | null
  openToStatus: string[]
  publishedAt: Date | null
  [privateField: string]: unknown
}

export interface PublicBuilderDto {
  id: string
  source: string
  sourceId: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  profileUrl: string
  bio: string | null
  openToStatus: string[]
  publishedAt: string
}

export function toPublicBuilderDto(source: PublicBuilderSource): PublicBuilderDto {
  if (!source.publishedAt) throw new Error('Builder profile is not published')

  return {
    id: source.id,
    source: source.source,
    sourceId: source.sourceId,
    username: source.username,
    displayName: source.displayName,
    avatarUrl: source.avatarUrl,
    profileUrl: source.profileUrl,
    bio: source.bio,
    openToStatus: [...source.openToStatus],
    publishedAt: source.publishedAt.toISOString(),
  }
}
