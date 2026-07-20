import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

export interface PublicSearchBuilder {
  id: string
  kind: 'person' | 'repo'
  username: string
  displayName: string | null
  source: string
  avatarUrl: string | null
  bio: string | null
  followersCount: number
  profileUrl: string
  language: string | null
  country: string | null
  topics: string[]
  score: number
}

const publicSearchSchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  sources: z.array(z.string().trim().min(1).max(32)).max(12).optional(),
  language: z.string().trim().min(1).max(64).optional(),
  country: z.string().trim().min(1).max(64).optional(),
  page: z.number().int().min(1).max(100).default(1),
  perPage: z.number().int().min(1).max(50).default(30),
})

const builderIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

export const searchPublicBuilders = createServerFn({ method: 'GET' })
  .validator(publicSearchSchema)
  .handler(async ({ data }) => {
    const { searchBuilders } = await import('~/lib/search')
    const builders = await searchBuilders(data)
    return builders.map((builder): PublicSearchBuilder => ({
      id: builder.id,
      kind: builder.kind,
      username: builder.username,
      displayName: builder.displayName ?? null,
      source: builder.source,
      avatarUrl: builder.avatarUrl ?? null,
      bio: builder.bio ?? null,
      followersCount: builder.followersCount ?? 0,
      profileUrl: builder.profileUrl,
      language: builder.language ?? null,
      country: builder.country ?? null,
      topics: builder.topics,
      score: builder.score,
    }))
  })

export const getPublicBuilder = createServerFn({ method: 'GET' })
  .validator(builderIdSchema)
  .handler(async ({ data: builderId }) => {
    const [{ db }, { builders }, { eq }] = await Promise.all([
      import('~/shared/lib/db/index'),
      import('~/shared/lib/db/schema'),
      import('drizzle-orm'),
    ])
    const [builder] = await db
      .select({
        id: builders.id,
        username: builders.username,
        displayName: builders.displayName,
        bio: builders.bio,
        avatarUrl: builders.avatarUrl,
        source: builders.source,
      })
      .from(builders)
      .where(eq(builders.id, builderId))

    return builder ?? null
  })
