import { env } from '~/shared/lib/env'
import type { RawBuilder } from '~/lib/sources/types'

/**
 * Hashnode source — GraphQL API.
 *
 * Status (checked live 2026-07-25, this codebase's own migration task told us to move to
 * `https://gql.hashnode.com` — that endpoint is ALSO dead now): both `api.hashnode.com` (the
 * original endpoint, "Stellate service not found") and `gql.hashnode.com` (the endpoint this
 * file's own migration task instructed moving to) now 301-redirect to
 * `https://hashnode.com/announcements/graphql-api`, whose page title is literally "GraphQL API
 * is moving to a paid offering." Hashnode has closed free public GraphQL access entirely —
 * there is currently no live endpoint this connector could migrate to and still work for free.
 * Left pointed at the dead `api.hashnode.com` (rather than the equally-dead `gql.hashnode.com`)
 * since neither works and the old URL is at least the one already documented as broken.
 *
 * v1 strategy unchanged: try the GraphQL endpoint, return [] gracefully if down. The source
 * stays wired in (pill, icon, badge) so it starts working automatically if Hashnode ever
 * reopens a free tier — this file needs no code change for that, only a working URL swapped in.
 *
 * When a working endpoint existed, the canonical query for a username was:
 *   { user(username: "X") { username name bio followersCount
 *       posts { totalDocuments } tagline } }
 *
 * Spec reference: plans/phase-1/16-hashnode-integration/spec.md
 */
interface HashnodeUser {
  username: string
  name: string
  bio?: string
  tagline?: string
  followersCount: number
  posts: { totalDocuments: number }
}

interface HashnodeSearchUser {
  username: string
  name: string
  bio?: string
  tagline?: string
  followersCount: number
  posts: { totalDocuments: number }
}

const HN_GQL = 'https://api.hashnode.com/'

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(HN_GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.HASHNODE_API_KEY ? { Authorization: env.HASHNODE_API_KEY } : {}),
        'User-Agent': 'BuilderHunt/1.0 (hashnode source)',
      },
      body: JSON.stringify({ query, variables }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
    if (data.errors && data.errors.length > 0) {
      // API is broken / quota / whatever — degrade silently
      return null
    }
    return data.data ?? null
  } catch {
    return null
  }
}

async function searchUsersByQuery(q: string): Promise<HashnodeSearchUser[]> {
  const query = `query SearchUsers($q: String!, $first: Int!) {
    searchUsers(first: $first, query: $q) {
      edges {
        node {
          username
          name
          bio
          tagline
          followersCount
          posts { totalDocuments }
        }
      }
    }
  }`
  const data = await gql<{ searchUsers: { edges: Array<{ node: HashnodeSearchUser }> } }>(query, {
    q,
    first: 20,
  })
  return data?.searchUsers?.edges?.map((e) => e.node) ?? []
}

function userToBuilder(u: HashnodeUser | HashnodeSearchUser): RawBuilder {
  return {
    // NOT `hn-` — that prefix is already taken by src/lib/sources/hn.ts (Hacker News),
    // which would collide two entirely different people under the same builder id.
    id: `hnode-${u.username}`,
    kind: 'person' as const,
    source: 'hashnode' as const,
    sourceId: u.username,
    username: u.username,
    displayName: u.name || u.username,
    avatarUrl: undefined,
    bio: u.bio || u.tagline || undefined,
    profileUrl: `https://hashnode.com/@${u.username}`,
    followersCount: u.followersCount,
    language: undefined,
    country: undefined,
    topics: [],
    metadata: {
      postCount: u.posts?.totalDocuments ?? 0,
    },
  }
}

export interface SearchHashnodeOptions {
  page?: number
  perPage?: number
}

export async function searchHashnode(
  keywords: string[],
  options: SearchHashnodeOptions = {},
): Promise<RawBuilder[]> {
  const { page = 1, perPage = 30 } = options
  const query = keywords.join(' ')
  if (!query) return []

  // Try the search endpoint first (most relevant to query)
  const users = await searchUsersByQuery(query)
  if (users.length === 0) {
    // API down or no results — graceful empty return
    return []
  }

  // Sort by followers desc (search endpoint may not be relevance-sorted)
  users.sort((a, b) => b.followersCount - a.followersCount)

  const all = users.map(userToBuilder)
  const start = (page - 1) * perPage
  return all.slice(start, start + perPage)
}
