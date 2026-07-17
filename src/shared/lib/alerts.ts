// Server-only smart alerts helpers. Lazy-imports db.

import { db } from '~/shared/lib/db/index'
import { alerts, alertTriggers } from '~/shared/lib/db/schema'
import { eq, and, desc, sql } from 'drizzle-orm'
import { randomId } from '~/lib/utils'
import { log } from './log'

export type TriggerEventType = 'new_repo' | 'new_product' | 'keyword_match' | 'any_activity'
export type DeliveryChannel = 'email' | 'dashboard'

export interface TriggerConditions {
  eventType: TriggerEventType
  minStars?: number
  minFollowers?: number
  keywords?: string[]
  builderId?: string
}

export interface AlertTriggerRecord {
  id: string
  alertId: string
  userId: string
  builderId: string | null
  eventType: string
  payload: Record<string, unknown>
  matchedAt: string
  readAt: string | null
}

/**
 * Record a smart-alert trigger. In dev/test this just writes to the DB and
 * logs to console (no email). In production a separate worker would consume
 * these and send via the configured transport.
 */
export async function recordTrigger(input: {
  alertId: string
  userId: string
  builderId: string | null
  eventType: string
  payload: Record<string, unknown>
}): Promise<AlertTriggerRecord> {
  const id = randomId()
  await db.insert(alertTriggers).values({
    id,
    alertId: input.alertId,
    userId: input.userId,
    builderId: input.builderId,
    eventType: input.eventType,
    payload: input.payload,
  })
  await db
    .update(alerts)
    .set({ lastTriggeredAt: new Date() })
    .where(eq(alerts.id, input.alertId))

  log.info('alert_triggered', {
    alertId: input.alertId,
    userId: input.userId,
    eventType: input.eventType,
    builderId: input.builderId,
  })

  return {
    id,
    alertId: input.alertId,
    userId: input.userId,
    builderId: input.builderId,
    eventType: input.eventType,
    payload: input.payload,
    matchedAt: new Date().toISOString(),
    readAt: null,
  }
}

/**
 * Evaluate if a builder matches an alert's trigger conditions.
 * Pure function — no DB calls. Returns true if the alert should fire.
 */
export function evaluateMatch(
  conditions: TriggerConditions,
  builder: {
    followersCount?: number
    topics?: string[]
    bio?: string | null
    metadata?: Record<string, unknown>
  },
  event: { type: string; payload: Record<string, unknown> },
): boolean {
  // Event type filter
  if (conditions.eventType !== 'any_activity' && conditions.eventType !== event.type) {
    return false
  }

  // Specific builder watch
  if (conditions.builderId) {
    // Caller is expected to pass the right builder
    return true
  }

  // minStars (used as a proxy for minFollowers on most sources)
  if (conditions.minStars != null && (builder.followersCount ?? 0) < conditions.minStars) {
    return false
  }
  if (conditions.minFollowers != null && (builder.followersCount ?? 0) < conditions.minFollowers) {
    return false
  }

  // Keyword filter (case-insensitive match against topics, bio, event payload text)
  if (conditions.keywords && conditions.keywords.length > 0) {
    const haystack = [
      ...(builder.topics ?? []),
      builder.bio ?? '',
      JSON.stringify(event.payload),
    ]
      .join(' ')
      .toLowerCase()
    const matched = conditions.keywords.some((kw) => haystack.includes(kw.toLowerCase()))
    if (!matched) return false
  }

  return true
}

export async function listTriggersForUser(userId: string, limit = 50): Promise<AlertTriggerRecord[]> {
  const rows = await db
    .select()
    .from(alertTriggers)
    .where(eq(alertTriggers.userId, userId))
    .orderBy(desc(alertTriggers.matchedAt))
    .limit(limit)
  return rows.map((r) => ({
    id: r.id,
    alertId: r.alertId,
    userId: r.userId,
    builderId: r.builderId,
    eventType: r.eventType,
    payload: r.payload,
    matchedAt: r.matchedAt?.toISOString() ?? '',
    readAt: r.readAt?.toISOString() ?? null,
  }))
}

export async function markTriggerRead(triggerId: string, userId: string): Promise<boolean> {
  const [updated] = await db
    .update(alertTriggers)
    .set({ readAt: new Date() })
    .where(and(eq(alertTriggers.id, triggerId), eq(alertTriggers.userId, userId)))
    .returning()
  return Boolean(updated)
}

export async function unreadTriggerCount(userId: string): Promise<number> {
  const [r] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(alertTriggers)
    .where(and(eq(alertTriggers.userId, userId), sql`${alertTriggers.readAt} IS NULL`))
  return Number(r?.c ?? 0)
}
