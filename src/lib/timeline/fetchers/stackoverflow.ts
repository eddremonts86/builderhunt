import { env } from '~/shared/lib/env'
import type { TimelineEvent } from '~/lib/timeline/types'

interface SOAnswer {
  answer_id: number
  question_id: number
  creation_date: number
  title?: string | null
  body?: string | null
}

interface SOResponse {
  items: SOAnswer[]
}

function stripHtml(html: string): string {
  return html.replace(/<\/?[^>]+(>|$)/g, ' ').replace(/\s+/g, ' ').trim()
}

export function mapSOAnswer(answer: SOAnswer): TimelineEvent {
  return {
    id: `stackoverflow:${answer.answer_id}`,
    type: 'answer',
    source: 'stackoverflow',
    title: answer.title ? `Answered: ${answer.title}` : 'Answered a question',
    description: answer.body ? stripHtml(answer.body) : undefined,
    url: `https://stackoverflow.com/a/${answer.answer_id}`,
    timestamp: new Date(answer.creation_date * 1000).toISOString(),
  }
}

export async function fetchStackOverflowEvents({ sourceId }: { sourceId: string }): Promise<TimelineEvent[]> {
  try {
    const url = new URL(`https://api.stackexchange.com/2.3/users/${encodeURIComponent(sourceId)}/answers`)
    url.searchParams.set('order', 'desc')
    url.searchParams.set('sort', 'activity')
    url.searchParams.set('site', 'stackoverflow')
    url.searchParams.set('pagesize', '30')
    if (env.STACKOVERFLOW_API_KEY) url.searchParams.set('key', env.STACKOVERFLOW_API_KEY)

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return []

    const data = (await res.json()) as SOResponse
    if (!Array.isArray(data.items)) return []

    return data.items.map(mapSOAnswer)
  } catch {
    return []
  }
}
