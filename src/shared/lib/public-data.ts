import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { decideSelfManagedInclusion, withSelfManagedOrigin } from '~/shared/lib/self-managed/inclusion-policy'

export interface PublicSearchBuilder {
  id: string
  kind: 'person' | 'repo' | 'organization'
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
    const { searchBuilders, DEFAULT_SEARCH_SOURCES } = await import('~/lib/search')
    // Anonymous by construction — a public radar has no signed-in subject — so the default applies.
    // Resolved through the policy rather than hard-coded: a public page showing a narrower set than
    // the search behind it is a difference nobody would think to look for.
    const builders = await searchBuilders({
      ...data,
      // `DEFAULT_SEARCH_SOURCES` and not `[]` when the caller named none. An absent list means
      // "the defaults" to `searchBuilders`, but an *empty* one means "no sources at all" — so
      // appending the origin to `[]` would have produced a search of nothing but self-managed
      // profiles, which is the opposite of adding one origin to the usual set.
      sources: withSelfManagedOrigin(data.sources ?? DEFAULT_SEARCH_SOURCES, decideSelfManagedInclusion()),
    })
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

export interface PublicRadar {
  queryName: string
  ownerName: string
  keywords: string[]
  sources: string[] | null
  language: string | null
  country: string | null
}

const radarSlugSchema = z.string().regex(/^[a-z0-9-]{1,128}$/)

// Plan: public-landing-pages Phase 2. `~/shared/lib/repositories/public-radars`
// imports `publicDb`, which eagerly opens a real `postgres()` client at
// module scope — dynamically importing it here (not at this file's top
// level) keeps that whole chain, and the Node-only `Buffer` reference deep
// inside the `postgres` package, out of the client bundle that this route's
// own `component` ships to the browser. Same convention as
// `searchPublicBuilders` above and `getPublicBuilder` below.
export const resolvePublicRadar = createServerFn({ method: 'GET' })
  .validator(radarSlugSchema)
  .handler(async ({ data: slug }): Promise<PublicRadar | null> => {
    const { findPublicRadarBySlug, getPublicRadarQuery } = await import('~/shared/lib/repositories/public-radars')
    const radar = await findPublicRadarBySlug(slug)
    if (!radar) return null
    const resolved = await getPublicRadarQuery(radar.organizationId, radar.savedQueryId)
    if (!resolved) return null
    return {
      queryName: resolved.query.name,
      ownerName: resolved.organizationName,
      keywords: resolved.query.keywords,
      sources: resolved.query.sources,
      language: resolved.query.language,
      country: resolved.query.country,
    }
  })

/**
 * Feeds the SSR head of `/builders/$builderId`, which anonymous visitors and crawlers reach with no
 * tenant context at all.
 *
 * It reads the published projection, not `builders`. `builders` is tenant-scoped and RLS-protected:
 * as `builderhunt_app` with no `app.organization_id` set, every row is invisible, so this returned
 * `null` for every builder and the route fell through to its "Builder not found" meta — no title, no
 * `og:type`, no description, on every public profile page. It went unnoticed because the local
 * `DATABASE_URL` was a superuser, which bypasses RLS; the e2e harness, running as the real role, is
 * where it finally showed. `published_builder_profiles` is the surface a profile is deliberately
 * published to, and it is what `/api/builders/$builderId` already serves anonymously — one source
 * for the page and its meta rather than two that disagree.
 */
export const getPublicBuilder = createServerFn({ method: 'GET' })
  .validator(builderIdSchema)
  .handler(async ({ data: builderId }) => {
    const { findPublishedBuilderProfile } = await import('~/shared/lib/repositories/public-builders')
    const profile = await findPublishedBuilderProfile(builderId)
    if (!profile) return null
    return {
      id: profile.id,
      username: profile.username,
      displayName: profile.displayName,
      bio: profile.bio,
      avatarUrl: profile.avatarUrl,
      source: profile.source,
    }
  })
