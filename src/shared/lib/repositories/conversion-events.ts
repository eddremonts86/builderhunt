import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { and, eq, gte, lt, sql } from 'drizzle-orm'
import { platformDb, publicDb } from '~/shared/lib/db/client'
import { workerDb } from '~/shared/lib/db/worker-db'
import { conversionEvents } from '~/shared/lib/db/schema'
import type { ConversionEvent } from '~/shared/lib/conversion-events'

/** UTC calendar day, e.g. "2026-07-26" — used for date-range aggregate queries. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Insert-if-new. `(sessionId, name, surface, variant)` is uniquely indexed,
 * so a client retry (network blip, double-submit) is a silent no-op rather
 * than double-counting a funnel step — this is the idempotency the spec
 * requires, enforced at the database rather than re-derived in app code.
 *
 * `db` defaults to the real `builderhunt_app`-scoped singleton; tests pass a
 * disposable superuser connection instead of monkey-patching module state.
 */
export async function recordConversionEvent(
  event: ConversionEvent,
  now: Date = new Date(),
  db: PostgresJsDatabase = publicDb,
): Promise<void> {
  await db.insert(conversionEvents).values({
    id: randomUUID(),
    name: event.name,
    surface: event.surface,
    sessionId: event.sessionId,
    variant: event.variant,
    occurredAt: new Date(event.occurredAt),
    serverDay: utcDay(now),
  }).onConflictDoNothing({ target: [conversionEvents.sessionId, conversionEvents.name, conversionEvents.surface, conversionEvents.variant] })
}

/** Deletes raw events with `serverDay` older than `retainDays` (default 30). Idempotent — a repeated run against an already-pruned range deletes nothing. */
export async function deleteExpiredConversionEvents(
  retainDays = 30,
  now: Date = new Date(),
  db: PostgresJsDatabase = workerDb,
): Promise<number> {
  const cutoff = utcDay(new Date(now.getTime() - retainDays * 24 * 60 * 60 * 1000))
  const deleted = await db.delete(conversionEvents)
    .where(lt(conversionEvents.serverDay, cutoff))
    .returning({ id: conversionEvents.id })
  return deleted.length
}

export interface ConversionCounts {
  /** Distinct sessions with at least one matching event — the funnel's actual unit, since one session can retry/duplicate a client-side emit. */
  sessions: number
  events: number
}

/**
 * Counts distinct sessions (and raw events) for one `name`/`variant` within
 * `[startDay, endDay]` (inclusive, UTC `serverDay` strings) — the building
 * block `computeConversionRate` (numerator/denominator) is called with.
 * Read-only, `builderhunt_platform`-scoped in production — this is the admin
 * aggregate reporting path, never the app runtime.
 */
export async function countConversionSessions(
  name: string,
  variant: 'baseline' | 'treatment',
  startDay: string,
  endDay: string,
  db: PostgresJsDatabase = platformDb,
): Promise<ConversionCounts> {
  const [row] = await db.select({
    sessions: sql<number>`count(distinct ${conversionEvents.sessionId})`,
    events: sql<number>`count(*)`,
  })
    .from(conversionEvents)
    .where(and(
      eq(conversionEvents.name, name),
      eq(conversionEvents.variant, variant),
      gte(conversionEvents.serverDay, startDay),
      sql`${conversionEvents.serverDay} <= ${endDay}`,
    ))
  return { sessions: Number(row?.sessions ?? 0), events: Number(row?.events ?? 0) }
}
