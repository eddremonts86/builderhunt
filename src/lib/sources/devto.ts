import { env } from '~/shared/lib/env'
import type { RawBuilder } from '~/lib/sources/types'

interface DevToArticle {
  id: number
  title: string
  description?: string
  url: string
  public_reactions_count: number
  positive_reactions_count: number
  tag_list: string[]
  user: {
    name?: string
    username: string
    profile_image?: string
    github_username?: string | null
    twitter_username?: string | null
  }
}

interface DevToAuthorAggregate {
  username: string
  displayName?: string
  avatarUrl?: string
  github?: string | null
  twitter?: string | null
  articles: DevToArticle[]
  totalReactions: number
}

/**
 * dev.to's public API has no user-search endpoint (`/api/search/users` is
 * not real — it 404s). The only query-able surface is `/api/articles?tag=`,
 * which is a single-word tag filter, not free-text search. We treat each
 * keyword as a candidate tag, fetch matching articles, and derive builders
 * from the article authors (deduped, ranked by combined reactions).
 */
export async function searchDevTo(keywords: string[], options: { page?: number; perPage?: number } = {}): Promise<RawBuilder[]> {
  const baseUrl = env.DEVTO_API_URL
  const tags = keywords.map(k => k.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean)
  if (tags.length === 0) return []

  const { page = 1, perPage = 20 } = options

  try {
    const perTagFetch = Math.max(perPage, 20)
    const articleLists = await Promise.all(
      tags.map(async (tag) => {
        try {
          const res = await fetch(
            `${baseUrl}/articles?tag=${encodeURIComponent(tag)}&per_page=${perTagFetch}`,
            { headers: { 'User-Agent': 'BuilderHunt/1.0' } },
          )
          if (!res.ok) return []
          return (await res.json()) as DevToArticle[]
        } catch {
          return []
        }
      }),
    )

    const byAuthor = new Map<string, DevToAuthorAggregate>()
    for (const article of articleLists.flat()) {
      const u = article.user
      if (!u?.username) continue
      const existing = byAuthor.get(u.username) ?? {
        username: u.username,
        displayName: u.name,
        avatarUrl: u.profile_image,
        github: u.github_username,
        twitter: u.twitter_username,
        articles: [],
        totalReactions: 0,
      }
      existing.articles.push(article)
      existing.totalReactions += article.public_reactions_count ?? article.positive_reactions_count ?? 0
      byAuthor.set(u.username, existing)
    }

    const authors = Array.from(byAuthor.values()).sort((a, b) => b.totalReactions - a.totalReactions)
    const start = (page - 1) * perPage

    return authors.slice(start, start + perPage).map(a => ({
      id: `devto-${a.username}`,
      kind: 'person' as const,
      source: 'devto' as const,
      sourceId: a.username,
      username: a.username,
      displayName: a.displayName ?? undefined,
      avatarUrl: a.avatarUrl,
      bio: a.articles.length === 1
        ? a.articles[0].title
        : `${a.articles.length} articles incl. "${a.articles[0].title}"`,
      profileUrl: `https://dev.to/${a.username}`,
      followersCount: a.totalReactions,
      language: undefined,
      country: undefined,
      topics: Array.from(new Set(a.articles.flatMap(art => art.tag_list ?? []))).slice(0, 8),
      metadata: {
        articlesCount: a.articles.length,
        reactions: a.totalReactions,
        github: a.github,
        twitter: a.twitter,
      },
    }))
  } catch {
    return []
  }
}