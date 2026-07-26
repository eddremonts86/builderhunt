import type { TimelineEvent } from './types'

const MAX_EVENTS = 30
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000
const DESCRIPTION_MAX = 280

/**
 * Sorts desc by timestamp, drops events from the future or older than a
 * year (stale "recent activity" is worse than none), dedupes by id (a
 * fetcher retry or a paginated overlap can otherwise double-list one
 * event), caps at 30, and truncates descriptions to a card-friendly length.
 */
export function normalizeEvents(events: TimelineEvent[]): TimelineEvent[] {
  const now = Date.now()
  const seen = new Set<string>()
  const kept: TimelineEvent[] = []

  for (const event of events) {
    const ts = Date.parse(event.timestamp)
    if (isNaN(ts) || ts > now || now - ts > MAX_AGE_MS) continue
    if (seen.has(event.id)) continue
    seen.add(event.id)
    kept.push(
      event.description && event.description.length > DESCRIPTION_MAX
        ? { ...event, description: `${event.description.slice(0, DESCRIPTION_MAX - 1)}…` }
        : event,
    )
  }

  kept.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
  return kept.slice(0, MAX_EVENTS)
}
