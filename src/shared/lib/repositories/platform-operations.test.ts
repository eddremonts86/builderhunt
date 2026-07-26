import { readFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { jobRuns, operationalSchedules } from '../db/schema'
import { OPERATIONAL_SCHEDULES, type OperationalScheduleDefinition } from '../operational-schedules'
import {
  advanceScheduleAfterRun,
  listJobRuns,
  listScheduleRegistry,
  redactedErrorCode,
  scheduledOccurrenceFor,
  syncScheduleRegistry,
  withJobRun,
} from './platform-operations'

describe('platform operations boundary', () => {
  it.each([
    'src/shared/lib/billing.ts',
    'src/routes/api/admin/metrics/index.ts',
    'src/routes/api/admin/plan-requests/index.ts',
  ])('%s does not import the global product database', async (path) => {
    const source = await readFile(path, 'utf8')
    expect(source).not.toContain("~/shared/lib/db/index")
    expect(source).not.toContain("~/shared/lib/db/schema")
  })
})

// ── Schedule registry and job-run recorder (plan Phase 4) ────────────────────────────────────

let db: PostgresJsDatabase
let drop: () => Promise<void>

const NOW = new Date('2027-04-10T09:17:33.412Z')

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('platform_operations')
  db = disposable.db
  drop = disposable.drop
}, 60_000)

afterAll(async () => {
  await drop()
})

beforeEach(async () => {
  await db.delete(jobRuns)
  await db.delete(operationalSchedules)
})

function definition(overrides: Partial<OperationalScheduleDefinition> = {}): OperationalScheduleDefinition {
  return {
    jobKey: 'test.job',
    cronExpression: '0 3 * * *',
    timezone: 'Europe/Copenhagen',
    scope: 'platform',
    label: 'Test job',
    sourceRoute: '/api/admin/alerts/run-worker',
    ...overrides,
  }
}

describe('syncScheduleRegistry', () => {
  it('creates a row for every code-registered schedule', async () => {
    const result = await syncScheduleRegistry(NOW, db)

    expect(result.created).toBe(OPERATIONAL_SCHEDULES.length)
    const rows = await listScheduleRegistry(db)
    expect(rows).toHaveLength(OPERATIONAL_SCHEDULES.length)
    for (const row of rows) {
      expect(row.enabled).toBe(true)
      expect(row.nextRunAt).not.toBeNull()
      expect(row.nextRunAt!.getTime()).toBeGreaterThan(NOW.getTime())
    }
  })

  it('is idempotent — a second sync changes nothing observable', async () => {
    await syncScheduleRegistry(NOW, db)
    const first = await listScheduleRegistry(db)

    const second = await syncScheduleRegistry(NOW, db)
    const after = await listScheduleRegistry(db)

    expect(second.created).toBe(0)
    expect(second.retired).toBe(0)
    expect(after).toEqual(first)
  })

  it('recomputes the next run when a cadence changes', async () => {
    await syncScheduleRegistry(NOW, db, [definition({ cronExpression: '0 3 * * *' })])
    const [before] = await listScheduleRegistry(db)

    await syncScheduleRegistry(NOW, db, [definition({ cronExpression: '0 9 * * *' })])
    const [after] = await listScheduleRegistry(db)

    expect(after.cronExpression).toBe('0 9 * * *')
    expect(after.nextRunAt!.getTime()).not.toBe(before.nextRunAt!.getTime())
  })

  it('never re-enables a schedule an operator paused', async () => {
    await syncScheduleRegistry(NOW, db, [definition()])
    await db.update(operationalSchedules).set({ enabled: false }).where(eq(operationalSchedules.jobKey, 'test.job'))

    await syncScheduleRegistry(NOW, db, [definition()])

    // Re-enabling on deploy would silently undo an operator stopping a runaway job.
    const [row] = await listScheduleRegistry(db)
    expect(row.enabled).toBe(false)
  })

  it('disables a schedule that left the code registry rather than deleting it', async () => {
    await syncScheduleRegistry(NOW, db, [definition({ jobKey: 'retiring.job' }), definition({ jobKey: 'staying.job' })])

    const result = await syncScheduleRegistry(NOW, db, [definition({ jobKey: 'staying.job' })])

    expect(result.retired).toBe(1)
    const rows = await listScheduleRegistry(db)
    // Kept, not deleted: its job_runs history stays joinable and the key keeps its identity if the
    // job returns in a later release.
    expect(rows.map((r) => r.jobKey).sort()).toEqual(['retiring.job', 'staying.job'])
    expect(rows.find((r) => r.jobKey === 'retiring.job')).toMatchObject({ enabled: false, nextRunAt: null })
  })

  it('repairs a next run that has fallen into the past after a deployment gap', async () => {
    await syncScheduleRegistry(NOW, db, [definition()])
    await db.update(operationalSchedules)
      .set({ nextRunAt: new Date('2020-01-01T00:00:00.000Z') })
      .where(eq(operationalSchedules.jobKey, 'test.job'))

    await syncScheduleRegistry(NOW, db, [definition()])

    const [row] = await listScheduleRegistry(db)
    expect(row.nextRunAt!.getTime()).toBeGreaterThan(NOW.getTime())
  })
})

describe('withJobRun', () => {
  it('records one succeeded run and advances the schedule', async () => {
    await syncScheduleRegistry(NOW, db, [definition({ jobKey: 'calendar.reminder-delivery', cronExpression: '*/5 * * * *', timezone: 'UTC' })])

    const result = await withJobRun(
      { jobKey: 'calendar.reminder-delivery', now: NOW, db },
      async () => ({ processedCount: 7, failedCount: 0 }),
    )

    expect(result.processedCount).toBe(7)
    const runs = await db.select().from(jobRuns)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ state: 'succeeded', processedCount: 7, failedCount: 0, errorCode: null })
    expect(runs[0].finishedAt).not.toBeNull()
    expect(runs[0].durationMs).not.toBeNull()
    // Truncated to the minute so two invocations of one scheduled occurrence share an identity.
    expect(runs[0].scheduledFor.toISOString()).toBe('2027-04-10T09:17:00.000Z')

    const [after] = await listScheduleRegistry(db)
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(NOW.getTime())
  })

  it('marks the run failed when the worker reports failures without throwing', async () => {
    await syncScheduleRegistry(NOW, db, [definition({ jobKey: 'test.job' })])

    await withJobRun({ jobKey: 'test.job', now: NOW, db }, async () => ({
      processedCount: 3, failedCount: 2, errorCode: 'partial_tenant_failure',
    }))

    const [run] = await db.select().from(jobRuns)
    expect(run).toMatchObject({ state: 'failed', processedCount: 3, failedCount: 2, errorCode: 'partial_tenant_failure' })
  })

  it('closes the run row and re-throws when the worker crashes', async () => {
    await syncScheduleRegistry(NOW, db, [definition({ jobKey: 'test.job' })])

    await expect(
      withJobRun({ jobKey: 'test.job', now: NOW, db }, async () => { throw new Error('boom') }),
    ).rejects.toThrow('boom')

    // A half-open "running" row is how a dashboard starts lying; and swallowing the error here
    // would turn a crashed worker into an HTTP 200.
    const [run] = await db.select().from(jobRuns)
    expect(run.state).toBe('failed')
    expect(run.finishedAt).not.toBeNull()
  })

  it('never persists a provider message, only a short code', async () => {
    await syncScheduleRegistry(NOW, db, [definition({ jobKey: 'test.job' })])
    const leaky = Object.assign(new Error('postgres://user:hunter2@db.internal refused'), { code: 'ECONNREFUSED extra' })

    await expect(withJobRun({ jobKey: 'test.job', now: NOW, db }, async () => { throw leaky })).rejects.toThrow()

    const [run] = await db.select().from(jobRuns)
    expect(run.errorCode).toBe('worker_failed')
    expect(JSON.stringify(run)).not.toContain('hunter2')
    expect(JSON.stringify(run)).not.toContain('db.internal')
  })

  it('records two runs of the same minute under one scheduled identity', async () => {
    await syncScheduleRegistry(NOW, db, [definition({ jobKey: 'test.job' })])

    await withJobRun({ jobKey: 'test.job', now: NOW, db }, async () => ({ processedCount: 1, failedCount: 0 }))
    await withJobRun({ jobKey: 'test.job', now: new Date(NOW.getTime() + 12_000), db }, async () => ({ processedCount: 1, failedCount: 0 }))

    const runs = await db.select().from(jobRuns)
    // Two rows, one scheduled_for: a duplicate invocation is visible as such rather than looking
    // like two legitimate runs seconds apart.
    expect(runs).toHaveLength(2)
    expect(new Set(runs.map((r) => r.scheduledFor.toISOString())).size).toBe(1)
  })

  it('links the run to its schedule when one is registered', async () => {
    await syncScheduleRegistry(NOW, db, [definition({ jobKey: 'test.job' })])
    await withJobRun({ jobKey: 'test.job', now: NOW, db }, async () => ({ processedCount: 0, failedCount: 0 }))

    const [run] = await db.select().from(jobRuns)
    expect(run.scheduleId).not.toBeNull()
  })

  it('still records a run for a job with no registry row', async () => {
    // An unregistered worker must not be invisible in history just because nobody added it to the
    // registry yet.
    await withJobRun({ jobKey: 'unregistered.job', now: NOW, db }, async () => ({ processedCount: 1, failedCount: 0 }))

    const [run] = await db.select().from(jobRuns)
    expect(run).toMatchObject({ jobKey: 'unregistered.job', scheduleId: null, state: 'succeeded' })
  })
})

describe('redactedErrorCode', () => {
  it.each([
    ['a clean snake_case code', { code: 'overlap_warning' }, 'overlap_warning'],
    ['a code with spaces', { code: 'ECONNREFUSED extra' }, 'worker_failed'],
    ['an uppercase code', { code: 'ECONNREFUSED' }, 'worker_failed'],
    ['no code at all', {}, 'worker_failed'],
  ])('maps %s correctly', (_label, error, expected) => {
    expect(redactedErrorCode(error)).toBe(expected)
  })

  it('never returns the message', () => {
    expect(redactedErrorCode(new Error('secret token abc123'))).toBe('worker_failed')
  })
})

describe('advanceScheduleAfterRun', () => {
  it('does nothing for a job the code registry does not know', async () => {
    expect(await advanceScheduleAfterRun('nope.not.a.job', NOW, db)).toBeNull()
  })

  it('leaves a disabled schedule without a next run', async () => {
    await syncScheduleRegistry(NOW, db, [definition({ jobKey: 'calendar.reminder-delivery' })])
    await db.update(operationalSchedules).set({ enabled: false, nextRunAt: null })

    expect(await advanceScheduleAfterRun('calendar.reminder-delivery', NOW, db)).toBeNull()
    const [row] = await listScheduleRegistry(db)
    expect(row.nextRunAt).toBeNull()
  })
})

describe('listJobRuns', () => {
  it('returns only the requested keys inside the requested range', async () => {
    await withJobRun({ jobKey: 'a.job', now: NOW, db }, async () => ({ processedCount: 1, failedCount: 0 }))
    await withJobRun({ jobKey: 'b.job', now: NOW, db }, async () => ({ processedCount: 1, failedCount: 0 }))
    await withJobRun({ jobKey: 'a.job', now: new Date('2020-01-01T00:00:00.000Z'), db }, async () => ({ processedCount: 1, failedCount: 0 }))

    const rows = await listJobRuns(['a.job'], { from: new Date('2027-04-01T00:00:00.000Z'), to: new Date('2027-05-01T00:00:00.000Z') }, db)

    expect(rows).toHaveLength(1)
    expect(rows[0].jobKey).toBe('a.job')
  })

  it('returns nothing for an empty key list instead of everything', async () => {
    await withJobRun({ jobKey: 'a.job', now: NOW, db }, async () => ({ processedCount: 1, failedCount: 0 }))
    expect(await listJobRuns([], { from: new Date(0), to: new Date('2099-01-01') }, db)).toEqual([])
  })
})

describe('scheduledOccurrenceFor', () => {
  it('truncates to the minute without mutating its argument', () => {
    const input = new Date('2027-04-10T09:17:33.412Z')
    expect(scheduledOccurrenceFor(input).toISOString()).toBe('2027-04-10T09:17:00.000Z')
    expect(input.toISOString()).toBe('2027-04-10T09:17:33.412Z')
  })
})
