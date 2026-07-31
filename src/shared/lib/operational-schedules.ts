import { CronExpressionParser } from 'cron-parser'
import { RECURRENCE_JOB_KEY } from '~/lib/calendar/recurrence-worker'
import { REMINDER_JOB_KEY } from '~/lib/calendar/reminder-worker'

/**
 * The registry of every scheduled background job (plan:
 * calendar-scheduling-interview-intelligence, Phase 4 "Implement schedule registry and next-run
 * calculation").
 *
 * Label and source route live here in code rather than in `operational_schedules`, because they
 * are properties of the deployed build, not runtime state: a job renamed in a release should not
 * require a database write to display correctly, and a stale label in a row would be worse than no
 * label. The table stores only what actually changes at runtime — `enabled` and `nextRunAt`.
 *
 * `sourceRoute` is a **platform-admin route**, and the calendar feed shows it as a link. Every
 * entry must point at `/admin/operations?job=<jobKey>` — the one page that authenticates as
 * platform-admin and can render a single job's own registry/run detail; it must never point at a
 * POST-only worker endpoint, which a plain link click cannot invoke. `assertRegistryIsSafe`
 * enforces the shape.
 */

export type ScheduleScope = 'platform' | 'organization'

export interface OperationalScheduleDefinition {
  /** Stable across releases — it is the join key for `job_runs` history. Renaming one orphans its history. */
  jobKey: string
  cronExpression: string
  /** Named IANA zone, not a fixed offset, so a daily job stays at the same *local* hour across DST. */
  timezone: string
  scope: ScheduleScope
  label: string
  sourceRoute: string
}

/**
 * Cadences are expressed in Europe/Copenhagen where a human would notice the hour (daily digests,
 * overnight sweeps) and in UTC where they are purely mechanical (every-N-minutes polling). A
 * frequent job pinned to a local zone gains or loses one interval twice a year for no benefit.
 */
export const OPERATIONAL_SCHEDULES: readonly OperationalScheduleDefinition[] = [
  {
    jobKey: 'alerts.evaluate',
    cronExpression: '*/15 * * * *',
    timezone: 'UTC',
    scope: 'organization',
    label: 'Alert evaluation',
    sourceRoute: '/admin/operations?job=alerts.evaluate',
  },
  {
    jobKey: 'sprints.execute',
    cronExpression: '*/10 * * * *',
    timezone: 'UTC',
    scope: 'organization',
    label: 'Sprint execution',
    sourceRoute: '/admin/operations?job=sprints.execute',
  },
  {
    jobKey: 'enrichment.refresh',
    cronExpression: '0 3 * * *',
    timezone: 'Europe/Copenhagen',
    scope: 'platform',
    label: 'Profile enrichment refresh',
    sourceRoute: '/admin/operations?job=enrichment.refresh',
  },
  {
    jobKey: 'discovery.crawl',
    cronExpression: '0 4 * * *',
    timezone: 'Europe/Copenhagen',
    scope: 'platform',
    label: 'Builder discovery',
    sourceRoute: '/admin/operations?job=discovery.crawl',
  },
  {
    jobKey: 'embeddings.backfill',
    cronExpression: '30 2 * * *',
    timezone: 'Europe/Copenhagen',
    scope: 'platform',
    label: 'Embedding backfill',
    sourceRoute: '/admin/operations?job=embeddings.backfill',
  },
  {
    jobKey: 'legal.retention',
    cronExpression: '0 1 * * *',
    timezone: 'Europe/Copenhagen',
    scope: 'platform',
    label: 'Legal retention sweep',
    sourceRoute: '/admin/operations?job=legal.retention',
  },
  {
    jobKey: 'billing.reconcile',
    cronExpression: '0 5 * * *',
    timezone: 'Europe/Copenhagen',
    scope: 'platform',
    label: 'Billing reconciliation',
    sourceRoute: '/admin/operations?job=billing.reconcile',
  },
  {
    jobKey: RECURRENCE_JOB_KEY,
    cronExpression: '0 * * * *',
    timezone: 'UTC',
    scope: 'organization',
    label: 'Calendar recurrence materialization',
    sourceRoute: `/admin/operations?job=${RECURRENCE_JOB_KEY}`,
  },
  {
    jobKey: REMINDER_JOB_KEY,
    // Every five minutes: the tightest reminder offset the schema allows is 0 minutes, so a coarser
    // sweep would deliver "starting now" notices materially late.
    cronExpression: '*/5 * * * *',
    timezone: 'UTC',
    scope: 'organization',
    label: 'Calendar reminder delivery',
    sourceRoute: `/admin/operations?job=${REMINDER_JOB_KEY}`,
  },
  {
    jobKey: 'status.snapshot',
    cronExpression: '*/30 * * * *',
    timezone: 'UTC',
    scope: 'platform',
    label: 'Status snapshot',
    sourceRoute: '/admin/operations?job=status.snapshot',
  },
]

export class ScheduleRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScheduleRegistryError'
  }
}

/**
 * Structural checks that must hold for the registry to be safe to publish.
 *
 * Run as a test rather than at import time so a bad entry fails the build instead of the first
 * request that happens to touch the calendar feed.
 */
export function assertRegistryIsSafe(schedules: readonly OperationalScheduleDefinition[] = OPERATIONAL_SCHEDULES): void {
  const seen = new Set<string>()
  for (const schedule of schedules) {
    // A duplicate key would make `job_runs` history ambiguous between two different jobs.
    if (seen.has(schedule.jobKey)) throw new ScheduleRegistryError(`Duplicate schedule key: ${schedule.jobKey}`)
    seen.add(schedule.jobKey)

    // The feed renders `sourceRoute` as a link, so it must point at the one platform-admin page that
    // can actually render it — `/admin/operations`, scoped to this job by its own `jobKey` — never a
    // POST-only worker endpoint a plain `<a href>` click would just 405 against.
    const expectedRoute = `/admin/operations?job=${schedule.jobKey}`
    if (schedule.sourceRoute !== expectedRoute) {
      throw new ScheduleRegistryError(`Unsafe source route for ${schedule.jobKey}: expected ${expectedRoute}, got ${schedule.sourceRoute}`)
    }
    if (schedule.sourceRoute.includes('..')) {
      throw new ScheduleRegistryError(`Source route must be a plain path for ${schedule.jobKey}`)
    }
    if (!isValidTimeZone(schedule.timezone)) {
      throw new ScheduleRegistryError(`Unknown time zone for ${schedule.jobKey}: ${schedule.timezone}`)
    }
    // Parsing proves the expression is real; an unparseable cron would otherwise surface as a
    // never-scheduled job that looks healthy because nothing ever errors.
    calculateNextRun(schedule, new Date())
  }
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/**
 * The next fire time strictly after `from`, in the schedule's own timezone.
 *
 * Strictly after, not at-or-after: calling this immediately upon completing a run must return the
 * *following* occurrence, never the one that just ran, or the registry would advertise a next run
 * that is already in the past.
 */
export function calculateNextRun(schedule: OperationalScheduleDefinition, from: Date): Date {
  try {
    const iterator = CronExpressionParser.parse(schedule.cronExpression, {
      currentDate: from,
      tz: schedule.timezone,
    })
    return iterator.next().toDate()
  } catch (error) {
    throw new ScheduleRegistryError(
      `Invalid cron expression for ${schedule.jobKey}: ${error instanceof Error ? error.message : 'unparseable'}`,
    )
  }
}

export function findScheduleDefinition(jobKey: string): OperationalScheduleDefinition | null {
  return OPERATIONAL_SCHEDULES.find((schedule) => schedule.jobKey === jobKey) ?? null
}
