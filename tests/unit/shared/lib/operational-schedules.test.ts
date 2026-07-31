import { describe, expect, it } from 'vitest'
import {
  assertRegistryIsSafe,
  calculateNextRun,
  findScheduleDefinition,
  OPERATIONAL_SCHEDULES,
  ScheduleRegistryError,
  type OperationalScheduleDefinition,
} from '~/shared/lib/operational-schedules'

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

/** What a UTC instant reads as on the schedule's own wall clock — the only view a user cares about. */
function localTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone,
  }).format(instant)
}

describe('the shipped registry', () => {
  it('passes every structural safety check', () => {
    expect(() => assertRegistryIsSafe()).not.toThrow()
  })

  it('registers a schedule for both calendar workers', () => {
    expect(findScheduleDefinition('calendar.recurrence-materialization')).not.toBeNull()
    expect(findScheduleDefinition('calendar.reminder-delivery')).not.toBeNull()
  })

  it('returns null for a key it does not know rather than guessing', () => {
    expect(findScheduleDefinition('nope.not.a.job')).toBeNull()
  })

  it('points every entry at its own job on the operations page', () => {
    for (const schedule of OPERATIONAL_SCHEDULES) {
      // The calendar feed renders this as a link; it must be the platform-admin page that can
      // actually render a GET for it, scoped to this job, never a POST-only worker endpoint.
      expect(schedule.sourceRoute).toBe(`/admin/operations?job=${schedule.jobKey}`)
    }
  })
})

describe('assertRegistryIsSafe', () => {
  it('rejects a duplicate key, which would make job_runs history ambiguous', () => {
    expect(() => assertRegistryIsSafe([definition(), definition({ label: 'Other' })]))
      .toThrow(ScheduleRegistryError)
  })

  it.each([
    ['a leftover worker-endpoint route', '/api/admin/alerts/run-worker'],
    ['a route for a different job', '/admin/operations?job=other.job'],
    ['a traversal attempt', '/admin/operations?job=../public/thing'],
  ])('rejects %s', (_label, sourceRoute) => {
    expect(() => assertRegistryIsSafe([definition({ sourceRoute })])).toThrow(ScheduleRegistryError)
  })

  it('rejects a timezone that does not exist', () => {
    expect(() => assertRegistryIsSafe([definition({ timezone: 'Europe/Atlantis' })])).toThrow(ScheduleRegistryError)
  })

  it('rejects an unparseable cron expression instead of leaving a job silently never scheduled', () => {
    expect(() => assertRegistryIsSafe([definition({ cronExpression: 'every so often' })])).toThrow(ScheduleRegistryError)
  })
})

describe('calculateNextRun', () => {
  it('returns the next occurrence strictly after the given instant', () => {
    const schedule = definition({ cronExpression: '0 * * * *', timezone: 'UTC' })
    // Exactly on the hour: the answer must be the NEXT hour, or a worker calling this on completion
    // would advertise a next run that already happened.
    const onTheHour = new Date('2027-01-01T10:00:00.000Z')
    expect(calculateNextRun(schedule, onTheHour).toISOString()).toBe('2027-01-01T11:00:00.000Z')
  })

  it('keeps a daily job at the same local hour across the spring-forward transition', () => {
    // Europe/Copenhagen moves 02:00 -> 03:00 on 2027-03-28, so 03:00 local is 01:00 UTC after the
    // change and 02:00 UTC before it. A fixed-offset schedule would drift by an hour here.
    const schedule = definition({ cronExpression: '0 3 * * *', timezone: 'Europe/Copenhagen' })
    const before = calculateNextRun(schedule, new Date('2027-03-26T12:00:00.000Z'))
    const after = calculateNextRun(schedule, new Date('2027-03-29T12:00:00.000Z'))

    expect(localTime(before, 'Europe/Copenhagen')).toBe('03:00')
    expect(localTime(after, 'Europe/Copenhagen')).toBe('03:00')
    // Same local hour, different UTC offset — that is the whole point of storing a named zone.
    expect(before.getUTCHours()).not.toBe(after.getUTCHours())
  })

  it('keeps a daily job at the same local hour across the autumn fall-back transition', () => {
    const schedule = definition({ cronExpression: '0 3 * * *', timezone: 'Europe/Copenhagen' })
    const before = calculateNextRun(schedule, new Date('2027-10-29T12:00:00.000Z'))
    const after = calculateNextRun(schedule, new Date('2027-11-01T12:00:00.000Z'))

    expect(localTime(before, 'Europe/Copenhagen')).toBe('03:00')
    expect(localTime(after, 'Europe/Copenhagen')).toBe('03:00')
  })

  it('still fires a job scheduled inside the spring-forward gap', () => {
    // 02:30 local does not exist on 2027-03-28 in Copenhagen. The job must still run that day
    // rather than being silently skipped for 24 hours.
    const schedule = definition({ cronExpression: '30 2 * * *', timezone: 'Europe/Copenhagen' })
    const next = calculateNextRun(schedule, new Date('2027-03-27T12:00:00.000Z'))

    expect(next.toISOString().slice(0, 10)).toBe('2027-03-28')
  })

  it('is deterministic — the same inputs always produce the same answer', () => {
    const schedule = definition({ cronExpression: '*/15 * * * *', timezone: 'UTC' })
    const from = new Date('2027-05-05T08:07:00.000Z')
    expect(calculateNextRun(schedule, from).toISOString()).toBe(calculateNextRun(schedule, from).toISOString())
    expect(calculateNextRun(schedule, from).toISOString()).toBe('2027-05-05T08:15:00.000Z')
  })

  it('throws a typed error for an invalid expression rather than returning a bogus date', () => {
    expect(() => calculateNextRun(definition({ cronExpression: '99 99 * * *' }), new Date()))
      .toThrow(ScheduleRegistryError)
  })
})
