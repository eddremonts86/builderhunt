import { env } from '~/shared/lib/env'
import type { RawBuilder } from '~/lib/sources/types'

/**
 * Product Hunt source — official GraphQL API v2, auth mandatory.
 *
 * Without a PRODUCTHUNT_TOKEN, every request is skipped entirely (same
 * wired-but-dormant pattern as src/lib/sources/sourcehut.ts).
 *
 * The v2 `posts` query has no free-text search argument — discovery goes
 * through topics: resolve the keyword to a topic slug, then fetch that
 * topic's top posts by votes, then aggregate the makers across those
 * posts (same shape as huggingface.ts's aggregateAuthor). A keyword that
 * resolves to no topic yields `[]` — Product Hunt genuinely cannot answer
 * arbitrary keyword queries, so that's the honest result, not a bug.
 *
 * Spec reference: plans/phase-1/18-producthunt-integration/spec.md
 */
interface PHMaker {
  id: string
  name?: string
  username: string
  headline?: string
  profileImage?: string
  twitterUsername?: string
}

interface PHPost {
  votesCount: number
  createdAt: string
  name: string
  tagline?: string
  url?: string
  topics: { nodes: Array<{ slug: string }> }
  makers: PHMaker[]
}

const PH_GQL = 'https://api.producthunt.com/v2/api/graphql'

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T | null> {
  if (!env.PRODUCTHUNT_TOKEN) {
    // No token, no data — by design
    return null
  }
  try {
    const res = await fetch(PH_GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.PRODUCTHUNT_TOKEN}`,
        'User-Agent': 'BuilderHunt/1.0 (producthunt source)',
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

async function resolveTopicSlug(query: string): Promise<string | null> {
  const data = await gql<{ topics: { nodes: Array<{ slug: string }> } }>(
    `query ResolveTopic($q: String!) { topics(first: 1, query: $q) { nodes { slug } } }`,
    { q: query },
  )
  return data?.topics?.nodes?.[0]?.slug ?? null
}

async function fetchTopicPosts(slug: string): Promise<PHPost[]> {
  const data = await gql<{ posts: { nodes: PHPost[] } }>(
    `query TopicPosts($slug: String!, $first: Int!) {
      posts(first: $first, topic: $slug, order: VOTES) {
        nodes {
          name
          tagline
          url
          votesCount
          createdAt
          topics { nodes { slug } }
          makers { id name username headline profileImage twitterUsername }
        }
      }
    }`,
    { slug, first: 20 },
  )
  return data?.posts?.nodes ?? []
}

interface MakerAggregate {
  maker: PHMaker
  totalVotes: number
  bestVotes: number
  lastSeen: number
  topics: Set<string>
  launches: Array<{ name: string; tagline?: string; votesCount: number; url?: string }>
}

function aggregateMaker(post: PHPost, byId: Map<string, MakerAggregate>): void {
  const created = Date.parse(post.createdAt)
  for (const maker of post.makers) {
    const existing = byId.get(maker.id)
    const entry: MakerAggregate =
      existing ?? {
        maker,
        totalVotes: 0,
        bestVotes: 0,
        lastSeen: 0,
        topics: new Set(),
        launches: [],
      }
    entry.totalVotes += post.votesCount
    if (post.votesCount > entry.bestVotes) entry.bestVotes = post.votesCount
    if (!isNaN(created) && created > entry.lastSeen) entry.lastSeen = created
    for (const t of post.topics?.nodes ?? []) entry.topics.add(t.slug)
    if (entry.launches.length < 5) {
      entry.launches.push({ name: post.name, tagline: post.tagline, votesCount: post.votesCount, url: post.url })
    }
    byId.set(maker.id, entry)
  }
}

function makerToBuilder(a: MakerAggregate): RawBuilder {
  return {
    id: `ph-${a.maker.id}`,
    kind: 'person',
    source: 'producthunt',
    sourceId: a.maker.id,
    username: a.maker.username,
    displayName: a.maker.name ?? a.maker.username,
    avatarUrl: a.maker.profileImage ?? undefined,
    bio: a.maker.headline ?? undefined,
    profileUrl: `https://www.producthunt.com/@${a.maker.username}`,
    followersCount: a.totalVotes,
    language: undefined,
    country: undefined,
    topics: Array.from(a.topics).slice(0, 10),
    metadata: {
      launchedCount: a.launches.length,
      totalVotes: a.totalVotes,
      bestVotes: a.bestVotes,
      lastSeen: a.lastSeen || undefined,
      launches: a.launches,
      twitterUsername: a.maker.twitterUsername ?? null,
    },
  }
}

export interface SearchProductHuntOptions {
  page?: number
  perPage?: number
}

export async function searchProductHunt(
  keywords: string[],
  options: SearchProductHuntOptions = {},
): Promise<RawBuilder[]> {
  const { page = 1, perPage = 30 } = options
  const query = keywords.join(' ').trim()
  if (!query) return []

  const slug = await resolveTopicSlug(query)
  if (!slug) return []

  const posts = await fetchTopicPosts(slug)
  if (posts.length === 0) return []

  const byId = new Map<string, MakerAggregate>()
  for (const post of posts) aggregateMaker(post, byId)

  const makers = Array.from(byId.values()).sort((a, b) => b.totalVotes - a.totalVotes)
  const all = makers.map(makerToBuilder)
  const start = (page - 1) * perPage
  return all.slice(start, start + perPage)
}
