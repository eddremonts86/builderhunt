import { and, asc, desc, eq, gte, inArray, lt, notInArray } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { platformDb } from '../db/platform-db'
import { workerDb } from '../db/worker-db'
import { jobRuns, operationalSchedules } from '../db/schema'
import {
  calculateNextRun,
  findScheduleDefinition,
  OPERATIONAL_SCHEDULES,
  type OperationalScheduleDefinition,
} from '../operational-schedules'

/**
 * Platform-owned operational bookkeeping: the schedule registry and job-run history (plan:
 * calendar-scheduling-interview-intelligence, Phase 4).
 *
 * Neither table is tenant-scoped. A job identity belongs to the platform, not to any one
 * organization, so these carry no `organization_id` and no RLS — access is controlled entirely by
 * per-role GRANT, the same pattern as `status_checks` and `conversion_events`. The calendar feed
 * exposes them only as redacted read-only projections.
 */

type Db = PostgresJsDatabase | typeof workerDb | typeof platformDb

/**
 * Reconciles the database registry with the code registry.
 *
 * Code is the source of truth for identity and cadence; the row is the source of truth for
 * `enabled` and `nextRunAt`. So a sync overwrites cron/timezone/scope but deliberately does NOT
 * reset `enabled` — an operator who paused a runaway job must not have it silently re-enabled by
 * the next deploy. `nextRunAt` is recomputed only when the cadence actually changed, so a routine
 * sync does not shove every job's next run forward.
 *
 * Idempotent: running it twice with an unchanged registry produces no observable difference.
 *
 * Runs as the PLATFORM role, not the worker: creating and retiring a schedule identity is an
 * operator action, and 0067 grants the worker only SELECT/UPDATE here. Using `workerDb` fails with
 * `42501 permission denied` — correctly, which is why the fix was to use the right connection
 * rather than to widen the worker's grant.
 */
export async function syncScheduleRegistry(
  now: Date,
  db: Db = platformDb,
  schedules: readonly OperationalScheduleDefinition[] = OPERATIONAL_SCHEDULES,
) {
  const existing = await db
    .select({
      jobKey: operationalSchedules.jobKey,
      cronExpression: operationalSchedules.cronExpression,
      timezone: operationalSchedules.timezone,
      nextRunAt: operationalSchedules.nextRunAt,
    })
    .from(operationalSchedules)
  const byKey = new Map(existing.map((row) => [row.jobKey, row]))

  let created = 0
  let updated = 0
  for (const schedule of schedules) {
    const current = byKey.get(schedule.jobKey)
    const cadenceChanged = !current
      || current.cronExpression !== schedule.cronExpression
      || current.timezone !== schedule.timezone
    // Also recompute when the stored next run has fallen into the past, which happens after a
    // deployment gap — otherwise the feed would keep advertising a run that already should have
    // happened and never self-corrects.
    const nextRunStale = !current?.nextRunAt || current.nextRunAt <= now
    const nextRunAt = cadenceChanged || nextRunStale ? calculateNextRun(schedule, now) : current.nextRunAt

    const [row] = await db
      .insert(operationalSchedules)
      .values({
        jobKey: schedule.jobKey,
        cronExpression: schedule.cronExpression,
        timezone: schedule.timezone,
        scope: schedule.scope,
        nextRunAt,
      })
      .onConflictDoUpdate({
        target: operationalSchedules.jobKey,
        set: {
          cronExpression: schedule.cronExpression,
          timezone: schedule.timezone,
          scope: schedule.scope,
          nextRunAt,
          updatedAt: new Date(),
        },
      })
      .returning({ id: operationalSchedules.id })
    if (current) updated += 1
    else if (row) created += 1
  }

  // A key that vanished from the code registry is disabled rather than deleted: its `job_runs`
  // history stays joinable, and a job that comes back in a later release keeps its identity.
  // `notInArray`, never `<> all(${jsArray})`: drizzle expands a JS array into a parameter tuple
  // rather than binding a real Postgres array, so `all()` is a runtime syntax error. Building the
  // array by string interpolation would work but puts caller-derived text into raw SQL, which is
  // not a trade worth making for a list this helper already has as parameters.
  const registeredKeys = schedules.map((schedule) => schedule.jobKey)
  const retireConditions = [eq(operationalSchedules.enabled, true)]
  if (registeredKeys.length > 0) retireConditions.push(notInArray(operationalSchedules.jobKey, registeredKeys))
  const retired = await db
    .update(operationalSchedules)
    .set({ enabled: false, nextRunAt: null, updatedAt: new Date() })
    .where(and(...retireConditions))
    .returning({ id: operationalSchedules.id })

  return { created, updated, retired: retired.length }
}

export async function listScheduleRegistry(db: Db = workerDb) {
  return db
    .select({
      id: operationalSchedules.id,
      jobKey: operationalSchedules.jobKey,
      cronExpression: operationalSchedules.cronExpression,
      timezone: operationalSchedules.timezone,
      scope: operationalSchedules.scope,
      enabled: operationalSchedules.enabled,
      nextRunAt: operationalSchedules.nextRunAt,
    })
    .from(operationalSchedules)
    .orderBy(asc(operationalSchedules.jobKey))
}

/** Advances a schedule past the run that just happened. A disabled schedule loses its next run entirely. */
export async function advanceScheduleAfterRun(jobKey: string, ranAt: Date, db: Db = workerDb) {
  const definition = findScheduleDefinition(jobKey)
  if (!definition) return null
  const [row] = await db
    .update(operationalSchedules)
    .set({ nextRunAt: calculateNextRun(definition, ranAt), updatedAt: new Date() })
    .where(and(eq(operationalSchedules.jobKey, jobKey), eq(operationalSchedules.enabled, true)))
    .returning({ jobKey: operationalSchedules.jobKey, nextRunAt: operationalSchedules.nextRunAt })
  return row ?? null
}

// ── Job runs ─────────────────────────────────────────────────────────────────────────────────

/**
 * Truncates a run's scheduled time to the minute.
 *
 * `job_runs` has no unique index on `(job_key, scheduled_for)`, so exactly-once is not enforced by
 * the database here the way it is for reminder deliveries. What this does buy is a stable
 * identity per scheduled occurrence: two invocations of the same minute's run record the same
 * `scheduledFor`, which makes duplicates visible in history instead of looking like two distinct
 * legitimate runs a few milliseconds apart.
 */
export function scheduledOccurrenceFor(now: Date): Date {
  const truncated = new Date(now)
  truncated.setSeconds(0, 0)
  return truncated
}

export interface JobRunOutcome {
  processedCount: number
  failedCount: number
  /** Short stable code only. These rows are projected into a user-visible calendar feed. */
  errorCode?: string | null
}

/**
 * Runs `operation` and records exactly one `job_runs` row for it, whatever happens.
 *
 * The recorder is a wrapper rather than a pair of calls the worker makes itself because the
 * failure path is the one that matters: a worker that throws must still close its run row, and
 * relying on every author to remember a try/finally is how half-open "running" rows accumulate
 * until someone notices the dashboard is lying.
 *
 * A thrown error is re-thrown after recording — swallowing it here would turn a crashed worker
 * into an HTTP 200.
 */
export async function withJobRun<TResult extends JobRunOutcome>(
  input: { jobKey: string; now?: Date; db?: Db },
  operation: () => Promise<TResult>,
): Promise<TResult> {
  const db = input.db ?? workerDb
  const now = input.now ?? new Date()
  const startedAt = Date.now()
  const scheduledFor = scheduledOccurrenceFor(now)

  const [schedule] = await db
    .select({ id: operationalSchedules.id })
    .from(operationalSchedules)
    .where(eq(operationalSchedules.jobKey, input.jobKey))
    .limit(1)

  const [run] = await db
    .insert(jobRuns)
    .values({
      jobKey: input.jobKey,
      scheduleId: schedule?.id ?? null,
      scheduledFor,
      startedAt: new Date(),
      state: 'running',
    })
    .returning({ id: jobRuns.id })

  try {
    const result = await operation()
    await closeRun(db, run.id, {
      state: result.failedCount > 0 ? 'failed' : 'succeeded',
      processedCount: result.processedCount,
      failedCount: result.failedCount,
      durationMs: Date.now() - startedAt,
      errorCode: result.errorCode ?? null,
    })
    await advanceScheduleAfterRun(input.jobKey, now, db)
    return result
  } catch (error) {
    // Only a stable code is persisted. A provider message or stack could carry a URL, a token, or
    // candidate data straight into a rendered calendar entry.
    await closeRun(db, run.id, {
      state: 'failed',
      processedCount: 0,
      failedCount: 1,
      durationMs: Date.now() - startedAt,
      errorCode: redactedErrorCode(error),
    })
    await advanceScheduleAfterRun(input.jobKey, now, db)
    throw error
  }
}

/** A short `snake_case` code, never the message. Unrecognized shapes collapse to `worker_failed`. */
export function redactedErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code: unknown }).code)
    if (/^[a-z0-9_]{1,64}$/.test(code)) return code
  }
  return 'worker_failed'
}

async function closeRun(
  db: Db,
  runId: string,
  outcome: { state: 'succeeded' | 'failed'; processedCount: number; failedCount: number; durationMs: number; errorCode: string | null },
) {
  await db
    .update(jobRuns)
    .set({
      state: outcome.state,
      finishedAt: new Date(),
      processedCount: outcome.processedCount,
      failedCount: outcome.failedCount,
      durationMs: outcome.durationMs,
      errorCode: outcome.errorCode,
    })
    .where(eq(jobRuns.id, runId))
}

export async function listJobRuns(
  jobKeys: string[],
  range: { from: Date; to: Date },
  db: Db = workerDb,
) {
  if (jobKeys.length === 0) return []
  return db
    .select({
      id: jobRuns.id,
      jobKey: jobRuns.jobKey,
      scheduledFor: jobRuns.scheduledFor,
      startedAt: jobRuns.startedAt,
      finishedAt: jobRuns.finishedAt,
      state: jobRuns.state,
      processedCount: jobRuns.processedCount,
      failedCount: jobRuns.failedCount,
      durationMs: jobRuns.durationMs,
      errorCode: jobRuns.errorCode,
    })
    .from(jobRuns)
    .where(and(
      inArray(jobRuns.jobKey, jobKeys),
      gte(jobRuns.scheduledFor, range.from),
      lt(jobRuns.scheduledFor, range.to),
    ))
    .orderBy(desc(jobRuns.scheduledFor))
}
