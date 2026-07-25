/**
 * Pure, client-safe half of the alerts library (plan: smart-alerts).
 *
 * Same split as `billing-shared.ts` / `sprints-shared.ts`: `alerts.ts` itself
 * reaches for `randomId` (`node:crypto`) and the tenant DB repositories, so
 * importing it from a browser component externalizes `crypto` and blows up
 * the page at runtime. Anything both the worker and the inbox UI need lives
 * here instead, with zero I/O imports.
 */

/** What the worker writes into `alert_triggers.payload` for a matched person.
 *
 *  The column is untyped `jsonb`, so this interface is the only contract
 *  between the worker (writer) and the alerts inbox (reader) — keep them in
 *  sync. It is deliberately a *self-contained snapshot* of the person at match
 *  time rather than a foreign key: a keyword match is usually someone the
 *  organization has never tracked, so there is no `builders` row to point at.
 *  Carrying the full snapshot is what lets the inbox render a real person card
 *  and offer a one-click track (`POST /api/builders/track` upserts from exactly
 *  these fields) instead of showing a dead-end username. */
export interface AlertMatchPayload {
  name: string
  description: string
  source: string
  sourceId: string
  username: string
  profileUrl: string
  displayName?: string | null
  avatarUrl?: string | null
  bio?: string | null
  followersCount?: number
  language?: string | null
  country?: string | null
  topics?: string[]
  score?: number
}

/** Narrows a raw `alert_triggers.payload` to the snapshot shape above. Rows
 *  written before the snapshot existed only carry name/description/source/
 *  sourceId/username (and sometimes no `profileUrl`), so the inbox has to
 *  treat the person fields as genuinely optional rather than assume them —
 *  returning `null` tells the caller to fall back to a plain summary row. */
export function readAlertMatchPayload(payload: Record<string, unknown>): AlertMatchPayload | null {
  const str = (key: string): string | undefined =>
    typeof payload[key] === 'string' ? (payload[key] as string) : undefined
  const username = str('username')
  const source = str('source')
  const profileUrl = str('profileUrl')
  if (!username || !source || !profileUrl) return null
  return {
    name: str('name') ?? username,
    description: str('description') ?? '',
    source,
    sourceId: str('sourceId') ?? username,
    username,
    profileUrl,
    displayName: str('displayName') ?? null,
    avatarUrl: str('avatarUrl') ?? null,
    bio: str('bio') ?? null,
    followersCount: typeof payload.followersCount === 'number' ? payload.followersCount : undefined,
    language: str('language') ?? null,
    country: str('country') ?? null,
    topics: Array.isArray(payload.topics)
      ? (payload.topics as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    score: typeof payload.score === 'number' ? payload.score : undefined,
  }
}
