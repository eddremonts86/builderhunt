/**
 * plans/UI/tasks.md Wave 5 "Add allowlisted pause, resume, and manual-run APIs" — repository-level
 * correctness against a real database, mirroring `platform-operations.test.ts`'s existing
 * `withJobRun`/`syncScheduleRegistry` coverage. Route-level auth gating and audit emission are
 * covered separately in `tests/unit/routes/api/admin/operations/`, since neither new route accepts
 * a database override the way `listBuilderClaimsForAdmin` does — exercising them against a real
 * connection would mean sharing `operational_schedules`/`job_runs` state with every other test file
 * that touches the same registry.
 */
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { jobRuns, operationalSchedules } from '~/shared/lib/db/schema'
import { findScheduleDefinition, OPERATIONAL_SCHEDULES, type OperationalScheduleDefinition } from '~/shared/lib/operational-schedules'
import {
  findRunningJobRun,
  listScheduleRegistry,
  setScheduleEnabled,
  syncScheduleRegistry,
} from '~/shared/lib/repositories/platform-operations'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const NOW = new Date('2027-06-01T00:00:00.000Z')

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('admin_operations')
  db = disposable.db
  drop = disposable.drop
}, 60_000)

afterAll(async () => { await drop() })

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
    sourceRoute: '/admin/operations?job=test.job',
    ...overrides,
  }
}

describe('findScheduleDefinition — resolving jobKey never trusts the caller', () => {
  it.each([
    ['a path-traversal attempt', '../../../etc/passwd'],
    ['an empty string', ''],
    ['a SQL-injection-shaped string', "alerts.evaluate'; DROP TABLE operational_schedules;--"],
    ['a case-mismatched real key', 'ALERTS.EVALUATE'],
    ['an unregistered key', 'unknown.job'],
  ])('fails closed (returns null) for %s', (_label, jobKey) => {
    expect(findScheduleDefinition(jobKey)).toBeNull()
  })

  it('resolves every real registered key back to itself', () => {
    for (const schedule of OPERATIONAL_SCHEDULES) {
      expect(findScheduleDefinition(schedule.jobKey)?.jobKey).toBe(schedule.jobKey)
    }
  })
})

describe('setScheduleEnabled — optimistic concurrency', () => {
  it('reports not_found for a job key with no registry row yet', async () => {
    expect(await setScheduleEnabled('never.synced', false, 1, db)).toEqual({ outcome: 'not_found' })
  })

  it('reports version_conflict (distinct from not_found) when the version has moved', async () => {
    await syncScheduleRegistry(NOW, db, [definition()])

    const result = await setScheduleEnabled('test.job', false, 999, db)

    expect(result.outcome).toBe('version_conflict')
    expect(result).toMatchObject({ currentVersion: 1 })
  })

  it('pauses a job and bumps its version on a matching expectedVersion', async () => {
    await syncScheduleRegistry(NOW, db, [definition()])

    const result = await setScheduleEnabled('test.job', false, 1, db)

    expect(result).toEqual({ outcome: 'updated', jobKey: 'test.job', enabled: false, version: 2 })
    const [row] = await listScheduleRegistry(db)
    expect(row).toMatchObject({ enabled: false, version: 2 })
  })

  it('a pause survives a subsequent registry sync', async () => {
    await syncScheduleRegistry(NOW, db, [definition()])
    await setScheduleEnabled('test.job', false, 1, db)

    // `syncScheduleRegistry` runs on every boot — a re-sync must not silently resume a job an
    // operator paused, the same guarantee `platform-operations.test.ts` already proves for a
    // direct SQL pause; this proves it holds when the pause goes through the new mutation path too.
    await syncScheduleRegistry(NOW, db, [definition()])

    const [row] = await listScheduleRegistry(db)
    expect(row.enabled).toBe(false)
  })

  it('resuming after a pause requires the post-pause version, not the original one', async () => {
    await syncScheduleRegistry(NOW, db, [definition()])
    await setScheduleEnabled('test.job', false, 1, db)

    const staleAttempt = await setScheduleEnabled('test.job', true, 1, db)
    expect(staleAttempt.outcome).toBe('version_conflict')

    const correctAttempt = await setScheduleEnabled('test.job', true, 2, db)
    expect(correctAttempt).toMatchObject({ outcome: 'updated', enabled: true, version: 3 })
  })
})

describe('findRunningJobRun — manual-run idempotency', () => {
  it('returns null when nothing is running', async () => {
    expect(await findRunningJobRun('test.job', db)).toBeNull()
  })

  it('finds an in-flight run and stops seeing it once it closes', async () => {
    const [run] = await db.insert(jobRuns).values({
      jobKey: 'test.job', scheduledFor: NOW, startedAt: NOW, state: 'running',
    }).returning({ id: jobRuns.id })

    const found = await findRunningJobRun('test.job', db)
    expect(found?.id).toBe(run.id)

    await db.update(jobRuns).set({ state: 'succeeded', finishedAt: NOW }).where(eq(jobRuns.id, run.id))
    expect(await findRunningJobRun('test.job', db)).toBeNull()
  })

  it('ignores a running row for a different job key', async () => {
    await db.insert(jobRuns).values({ jobKey: 'other.job', scheduledFor: NOW, startedAt: NOW, state: 'running' })
    expect(await findRunningJobRun('test.job', db)).toBeNull()
  })
})
