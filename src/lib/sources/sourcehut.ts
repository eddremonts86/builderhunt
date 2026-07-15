import { env } from '~/shared/lib/env'
import type { RawBuilder } from '~/lib/sources/github'

/**
 * SourceHut source — small-but-loyal OSS forge.
 *
 * The SourceHut GraphQL endpoint (meta.sr.ht/query) requires auth.
 * Without a SOURCEHUT_TOKEN, every request returns 401 Unauthorized.
 *
 * v1 strategy: graceful degradation.
 * - Source is fully wired (pill, icon, badge, scoring, env var)
 * - The handler returns [] if no token is configured OR if the API
 *   returns an auth error
 * - When SOURCEHUT_TOKEN is set, search becomes available
 *
 * Spec reference: plans/sourcehut-integration/spec.md
 */
interface SHUser {
  canonicalName: string
  name: string
  description?: string
  location?: string
  url?: string
}

interface SHRepo {
  name: string
  description?: string
  visibility: string
  created?: string
  updated?: string
  owner: { canonicalName: string }
}

const SH_GQL = 'https://meta.sr.ht/query'

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T | null> {
  if (!env.SOURCEHUT_TOKEN) {
    // No token, no data — by design
    return null
  }
  try {
    const res = await fetch(SH_GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.SOURCEHUT_TOKEN}`,
        'User-Agent': 'BuilderHunt/1.0 (sourcehut source)',
      },
      body: JSON.stringify({ query, variables }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
    if (data.errors && data.errors.length > 0) return null
    return data.data ?? null
  } catch {
    return null
  }
}

function userToBuilder(u: SHUser): RawBuilder {
  return {
    id: `sh-${u.canonicalName}`,
    kind: 'person' as const,
    source: 'sourcehut' as const,
    sourceId: u.canonicalName,
    username: u.canonicalName.replace(/^~/, ''),
    displayName: u.name || u.canonicalName,
    avatarUrl: undefined,
    bio: u.description || u.location || undefined,
    profileUrl: u.url || `https://sr.ht/~${u.canonicalName.replace(/^~/, '')}`,
    followersCount: undefined,
    language: undefined,
    country: undefined,
    topics: [],
    metadata: {
      location: u.location ?? null,
    },
  }
}

export interface SearchSourceHutOptions {
  page?: number
  perPage?: number
}

export async function searchSourceHut(
  keywords: string[],
  options: SearchSourceHutOptions = {},
): Promise<RawBuilder[]> {
  const { page = 1, perPage = 30 } = options
  const query = keywords.join(' ')
  if (!query) return []

  const gqlQuery = `query SearchSH($q: String!, $first: Int!) {
    users(search: $q, first: $first) {
      results {
        canonicalName
        name
        description
        location
        url
      }
    }
  }`
  const data = await gql<{ users: { results: SHUser[] } }>(gqlQuery, { q: query, first: 20 })
  if (!data?.users?.results) return []

  const all = data.users.results.map(userToBuilder)
  const start = (page - 1) * perPage
  return all.slice(start, start + perPage)
}
