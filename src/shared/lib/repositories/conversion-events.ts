import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { platformDb, publicDb } from '~/shared/lib/db/client'
import { workerDb } from '~/shared/lib/db/worker-db'
import { conversionEvents } from '~/shared/lib/db/schema'
import type { ConversionEvent } from '~/shared/lib/conversion-events'

/** UTC calendar day, e.g. "2026-07-26" — used for date-range aggregate queries. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Insert-if-new. The identity index is
 * `(sessionId, name, surface, variant, coalesce(step_key,''), coalesce(segment_next,''))`, so a
 * client retry (network blip, double-submit) is a silent no-op rather than double-counting a funnel
 * step — this is the idempotency the spec requires, enforced at the database rather than re-derived
 * in app code.
 *
 * ## The dimensions are written, not dropped
 *
 * This used to insert six columns and discard everything else the validated event carried. The
 * segment context plan 02 added passed validation, reached here, and vanished — so the segmentation
 * funnel it was built for could never have been computed from this table. Every field the contract
 * accepts is persisted now, or there is no reason for the contract to accept it.
 *
 * ## Why no `target` on the conflict clause
 *
 * The identity index is an expression index (`coalesce(...)`), which a column list cannot name.
 * A bare `onConflictDoNothing()` covers any unique violation, which is the intent anyway: this is
 * insert-if-new, and the `id` is a fresh UUID per call, so there is no other constraint it could
 * mask.
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
    flowVersion: event.onboarding?.flowVersion ?? null,
    preset: event.onboarding?.preset ?? null,
    stepKey: event.onboarding?.stepKey ?? null,
    segmentPrevious: event.segment?.previous ?? null,
    segmentNext: event.segment?.next ?? null,
    segmentSource: event.segment?.source ?? null,
    activationType: event.activationType ?? null,
  }).onConflictDoNothing()
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
 * Counts distinct sessions for **every** named event in one query (plan 57, Admin track — "Optimize and render
 * Conversion metrics").
 *
 * ## Why one query and not one per event
 *
 * The route used to call `countConversionSessions` twice per funnel metric, so six metrics were twelve
 * sequential round trips — and the number grew with the metric list. That is the shape the task's Verify line
 * is about: "query count stays constant as metric definitions grow". Adding a seventh metric should not add
 * two queries to a platform-admin page.
 *
 * A `group by name` over the same predicate is one scan of the same index and returns at most as many rows as
 * there are distinct event names in the window — which is bounded by the allowlist the caller passes, not by
 * how much data exists.
 *
 * ## Why the event list is passed in rather than read from the table
 *
 * `select distinct name` would let the *data* decide the result's cardinality, and a bug that wrote arbitrary
 * names would turn this into an unbounded read. The caller knows which events its metrics reference; anything
 * else in the table is not part of the answer.
 */
export async function countConversionSessionsByEvent(
  names: readonly string[],
  variant: 'baseline' | 'treatment',
  startDay: string,
  endDay: string,
  db: PostgresJsDatabase = platformDb,
): Promise<Map<string, ConversionCounts>> {
  const counts = new Map<string, ConversionCounts>()
  // Every requested name gets an entry, so a caller never has to distinguish "no sessions" from "not asked
  // for" — an absent key would be indistinguishable from a zero and the rate would silently vanish.
  for (const name of names) counts.set(name, { sessions: 0, events: 0 })
  if (names.length === 0) return counts

  // unbounded-read-ok: grouped by an allowlisted name, so this returns at most `names.length` rows however
  // many events the window holds. A LIMIT would drop a funnel step rather than bound anything.
  const rows = await db.select({
    name: conversionEvents.name,
    sessions: sql<number>`count(distinct ${conversionEvents.sessionId})`,
    events: sql<number>`count(*)`,
  })
    .from(conversionEvents)
    .where(and(
      inArray(conversionEvents.name, [...names]),
      eq(conversionEvents.variant, variant),
      gte(conversionEvents.serverDay, startDay),
      sql`${conversionEvents.serverDay} <= ${endDay}`,
    ))
    .groupBy(conversionEvents.name)

  for (const row of rows) {
    counts.set(row.name, { sessions: Number(row.sessions ?? 0), events: Number(row.events ?? 0) })
  }
  return counts
}

export interface OnboardingFunnelRow {
  name: string
  flowVersion: number | null
  preset: string | null
  stepKey: string | null
  sessions: number
  events: number
}

/**
 * The onboarding funnel, split by flow version, route and step (plan:
 * phase-2/03-onboarding-segmentado).
 *
 * One query, grouped four ways rather than one query per cell. The cell count is bounded by the
 * table's own CHECK constraints, not by how much data exists: three event names, two flow versions,
 * five presets and sixteen step keys is 480 rows at absolute worst, and in practice a fraction of
 * that because a step key only ever appears on the route that contains it.
 *
 * Split by `flowVersion` because that is what a cohort rollout is for. "Completion fell" is not
 * actionable; "completion fell on v2 while v1 held" is the sentence that stops a rollout, and it
 * cannot be written from a stream that does not distinguish the two.
 */
export async function countOnboardingFunnelSessions(
  variant: 'baseline' | 'treatment',
  startDay: string,
  endDay: string,
  db: PostgresJsDatabase = platformDb,
): Promise<OnboardingFunnelRow[]> {
  // unbounded-read-ok: grouped by four enum-constrained columns, so the row count is bounded by the
  // CHECK constraints on `conversion_events` rather than by the size of the window. A LIMIT here
  // would drop a route or a step rather than bound anything.
  const rows = await db.select({
    name: conversionEvents.name,
    flowVersion: conversionEvents.flowVersion,
    preset: conversionEvents.preset,
    stepKey: conversionEvents.stepKey,
    sessions: sql<number>`count(distinct ${conversionEvents.sessionId})`,
    events: sql<number>`count(*)`,
  })
    .from(conversionEvents)
    .where(and(
      inArray(conversionEvents.name, ['onboarding_step_viewed', 'onboarding_step_completed', 'onboarding_flow_exited']),
      eq(conversionEvents.variant, variant),
      gte(conversionEvents.serverDay, startDay),
      sql`${conversionEvents.serverDay} <= ${endDay}`,
    ))
    .groupBy(conversionEvents.name, conversionEvents.flowVersion, conversionEvents.preset, conversionEvents.stepKey)

  return rows.map((row) => ({
    name: row.name,
    flowVersion: row.flowVersion ?? null,
    preset: row.preset ?? null,
    stepKey: row.stepKey ?? null,
    sessions: Number(row.sessions ?? 0),
    events: Number(row.events ?? 0),
  }))
}
