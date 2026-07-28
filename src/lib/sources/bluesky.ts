import type { RawBuilder } from '~/lib/sources/types'

/**
 * Bluesky source — public AppView, no auth, no API key (verified live).
 *
 * `searchActors` gives fuzzy handle/displayName/bio matches but no follower
 * counts; a follow-up `getProfiles` batch call (max 25 DIDs) hydrates those.
 * Two requests per uncached search, both against a generous per-IP rate
 * limit — well under BuilderHunt's 5-minute search cache.
 *
 * Spec reference: plans/phase-1/16-bluesky-integration/spec.md
 */
interface BskyActor {
  did: string
  handle: string
  displayName?: string
  avatar?: string
  description?: string
}

interface BskyProfile extends BskyActor {
  followersCount?: number
  followsCount?: number
  postsCount?: number
}

const BSKY_BASE = 'https://public.api.bsky.app/xrpc'
const USER_AGENT = 'BuilderHunt/1.0 (bluesky source)'

async function searchActors(query: string): Promise<BskyActor[]> {
  try {
    const res = await fetch(
      `${BSKY_BASE}/app.bsky.actor.searchActors?q=${encodeURIComponent(query)}&limit=25`,
      { headers: { 'User-Agent': USER_AGENT } },
    )
    if (!res.ok) return []
    const data = (await res.json()) as { actors?: BskyActor[] }
    return data.actors ?? []
  } catch {
    return []
  }
}

async function hydrateProfiles(dids: string[]): Promise<Map<string, BskyProfile>> {
  const byDid = new Map<string, BskyProfile>()
  if (dids.length === 0) return byDid
  try {
    const params = dids.map((d) => `actors=${encodeURIComponent(d)}`).join('&')
    const res = await fetch(`${BSKY_BASE}/app.bsky.actor.getProfiles?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
    })
    if (!res.ok) return byDid
    const data = (await res.json()) as { profiles?: BskyProfile[] }
    for (const p of data.profiles ?? []) byDid.set(p.did, p)
    return byDid
  } catch {
    // Hydration failure degrades to unhydrated actors, not an empty result.
    return byDid
  }
}

function hashtagsFrom(description: string | undefined): string[] {
  if (!description) return []
  const matches = description.match(/#(\w+)/g) ?? []
  return [...new Set(matches.map((m) => m.slice(1).toLowerCase()))].slice(0, 8)
}

function actorToBuilder(actor: BskyActor, detailed: BskyProfile | undefined): RawBuilder {
  return {
    id: `bsky-${actor.did}`,
    kind: 'person',
    source: 'bluesky',
    sourceId: actor.did,
    username: actor.handle,
    displayName: actor.displayName ?? undefined,
    avatarUrl: actor.avatar ?? undefined,
    bio: actor.description ?? undefined,
    profileUrl: `https://bsky.app/profile/${actor.handle}`,
    followersCount: detailed?.followersCount,
    language: undefined,
    country: undefined,
    topics: hashtagsFrom(actor.description),
    metadata: {
      did: actor.did,
      followsCount: detailed?.followsCount,
      postsCount: detailed?.postsCount,
      customDomainHandle: !actor.handle.endsWith('.bsky.social'),
    },
  }
}

export interface SearchBlueskyOptions {
  page?: number
  perPage?: number
}

export async function searchBluesky(
  keywords: string[],
  options: SearchBlueskyOptions = {},
): Promise<RawBuilder[]> {
  const { page = 1, perPage = 30 } = options
  const query = keywords.join(' ').trim()
  if (!query) return []

  const actors = await searchActors(query)
  if (actors.length === 0) return []

  const profiles = await hydrateProfiles(actors.map((a) => a.did))
  const all = actors
    .map((a) => actorToBuilder(a, profiles.get(a.did)))
    .sort((a, b) => (b.followersCount ?? 0) - (a.followersCount ?? 0))

  const start = (page - 1) * perPage
  return all.slice(start, start + perPage)
}
