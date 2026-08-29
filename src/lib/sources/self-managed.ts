import type { RawBuilder } from '~/lib/sources/types'

/**
 * The self-managed origin: builders this product holds, not builders it found
 * (plan: phase-2/07-perfiles-autogestionados).
 *
 * ## It looks like a connector and reaches nothing
 *
 * Same signature as `searchGitHub` and friends so `runConnector` can time it, count it and report
 * its health without a special case — an origin that cannot report `failed` is an origin whose
 * outage is invisible. What it does *not* share is the network: there is no host, no token and no
 * rate limit, so a failure here is a database or a bug, never somebody else's downtime.
 *
 * ## Public means listed, and `unlisted` is not that
 *
 * `searchPublicProfiles` filters `visibility = 'public'`. An unlisted profile is reachable by
 * anyone holding its link and is deliberately absent from every listing — including this one. The
 * row policy permits reading it, because a policy cannot tell a direct visit from a search; the
 * predicate is where the difference is kept.
 *
 * ## Identity is the profile id, never the handle
 *
 * `sourceId` is the ULID. A handle is renameable and re-issuable — thirty days after a deletion it
 * can belong to somebody else — so keying on it would let a dedup merge, a suppression entry or a
 * saved search follow the name to a different person. The id survives every rename and belongs to
 * exactly one profile for as long as that profile exists.
 */
export async function searchSelfManaged(
  keywords: string[],
  options: { page?: number; perPage?: number } = {},
): Promise<RawBuilder[]> {
  // Dynamic, for the reason `search.ts` states about its own repository imports: this module is
  // reachable from route files the client bundle pulls in, and the repository reaches `publicDb`,
  // which constructs a real `postgres()` client when the module is evaluated.
  const { publicDb } = await import('~/shared/lib/db/client')
  const { searchPublicProfiles } = await import('~/shared/lib/repositories/self-managed-profiles')

  const perPage = options.perPage ?? 30

  const profiles = await publicDb.transaction((transaction) =>
    searchPublicProfiles(transaction, { keywords, limit: perPage }))

  return profiles.map((profile): RawBuilder => ({
    id: `self-managed-${profile.id}`,
    kind: 'person',
    source: 'self-managed',
    sourceId: profile.id,
    username: profile.handle,
    displayName: profile.displayName,
    // No avatar: this model stores none, and borrowing a gravatar from an email would publish an
    // identifier its owner never put on the page.
    avatarUrl: undefined,
    bio: profile.headline ?? profile.bio ?? undefined,
    profileUrl: `/u/${profile.handle}`,
    // Deliberately absent rather than zero. Nothing here has followers, and a fabricated count is
    // the one number a ranking would happily believe.
    followersCount: undefined,
    language: profile.languages[0],
    country: profile.locationCountryCode ?? undefined,
    topics: profile.topics,
    metadata: {
      // What every surface downstream branches on to render the chip.
      isSelfManaged: true,
      handle: profile.handle,
      services: profile.services,
      languages: profile.languages,
      locationCity: profile.locationCity ?? undefined,
      updatedAt: profile.updatedAt.toISOString(),
      // `lastSeen` is deliberately not set. It is a *recency of public activity* signal and there is
      // no public activity here; setting it from `updatedAt` would let editing a bio outrank a
      // builder who shipped this morning. `scoreBuilders` gives an absent `lastSeen` its neutral
      // default, which is the honest answer.
    },
  }))
}
