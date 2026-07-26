import { env } from '~/shared/lib/env'
import type { TimelineEvent } from '~/lib/timeline/types'

interface DevToArticle {
  id: number
  title: string
  description?: string | null
  url: string
  published_at?: string | null
  published_timestamp?: string | null
}

export function mapDevToArticle(article: DevToArticle): TimelineEvent | null {
  const timestamp = article.published_at ?? article.published_timestamp
  if (!timestamp) return null
  return {
    id: `devto:${article.id}`,
    type: 'article',
    source: 'devto',
    title: article.title,
    description: article.description ?? undefined,
    url: article.url,
    timestamp,
  }
}

export async function fetchDevToEvents({ username }: { username: string }): Promise<TimelineEvent[]> {
  try {
    const url = new URL(`${env.DEVTO_API_URL}/articles`)
    url.searchParams.set('username', username)
    url.searchParams.set('per_page', '30')

    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'BuilderHunt/1.0' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return []

    const raw = (await res.json()) as DevToArticle[]
    if (!Array.isArray(raw)) return []

    const events: TimelineEvent[] = []
    for (const article of raw) {
      const mapped = mapDevToArticle(article)
      if (mapped) events.push(mapped)
    }
    return events
  } catch {
    return []
  }
}
