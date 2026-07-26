import type { TimelineEvent } from '~/lib/timeline/types'

interface AlgoliaHit {
  objectID: string
  author: string
  title?: string | null
  story_title?: string | null
  story_text?: string | null
  comment_text?: string | null
  url?: string | null
  created_at: string
  _tags?: string[]
}

interface AlgoliaSearchByDateResponse {
  hits: AlgoliaHit[]
}

/** Reused verbatim from src/lib/sources/hn.ts — HN comment/bio bodies are raw HTML. */
function htmlToText(html: string): string {
  return html
    .replace(/<p>/gi, ' ')
    .replace(/<\/?[^>]+(>|$)/g, '')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#x27;/gi, '\'')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function mapAlgoliaHit(hit: AlgoliaHit): TimelineEvent | null {
  const isComment = Boolean(hit.comment_text) || hit._tags?.includes('comment')
  const itemUrl = `https://news.ycombinator.com/item?id=${hit.objectID}`

  if (isComment) {
    if (!hit.comment_text) return null
    const text = htmlToText(hit.comment_text)
    if (!text) return null
    return {
      id: `hn:${hit.objectID}`,
      type: 'comment',
      source: 'hn',
      title: hit.story_title ? `Commented on: ${hit.story_title}` : 'Commented on Hacker News',
      description: text,
      url: itemUrl,
      timestamp: hit.created_at,
    }
  }

  const title = hit.title ?? hit.story_title
  if (!title) return null
  return {
    id: `hn:${hit.objectID}`,
    type: 'post',
    source: 'hn',
    title,
    description: hit.story_text ? htmlToText(hit.story_text) : undefined,
    url: hit.url ?? itemUrl,
    timestamp: hit.created_at,
  }
}

export async function fetchHNEvents({ username }: { username: string }): Promise<TimelineEvent[]> {
  try {
    const url = new URL('https://hn.algolia.com/api/v1/search_by_date')
    // URLSearchParams.set percent-encodes the value it's given — encoding
    // `username` again here would double-encode it (e.g. a literal "%20"
    // becomes "%2520"), so it's passed raw.
    url.searchParams.set('tags', `author_${username},(story,comment)`)
    url.searchParams.set('hitsPerPage', '30')

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return []

    const data = (await res.json()) as AlgoliaSearchByDateResponse
    if (!Array.isArray(data.hits)) return []

    const events: TimelineEvent[] = []
    for (const hit of data.hits) {
      const mapped = mapAlgoliaHit(hit)
      if (mapped) events.push(mapped)
    }
    return events
  } catch {
    return []
  }
}
