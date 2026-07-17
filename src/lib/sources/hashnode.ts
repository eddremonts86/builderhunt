import { env } from '~/shared/lib/env'
import type { RawBuilder } from '~/lib/sources/types'

/**
 * Hashnode source — GraphQL API.
 *
 * Status: as of 2026-07 the public GraphQL endpoint (api.hashnode.com)
 * returns "Stellate service not found" for all queries. The spec itself
 * recommends skip-for-v1 because of this fragility.
 *
 * v1 strategy: try the GraphQL endpoint, return [] gracefully if down.
 * The source is wired in (pill, icon, badge) so we can detect when it
 * comes back. Zero impact on results when the API is unavailable.
 *
 * When the API is healthy, the canonical query for a username is:
 *   { user(username: "X") { username name bio followersCount
 *       posts { totalDocuments } tagline } }
 *
 * Spec reference: plans/hashnode-integration/spec.md
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
    id: `hn-${u.username}`,
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
