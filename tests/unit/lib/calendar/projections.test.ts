import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { calendarFeedResponseSchema } from '~/shared/lib/calendar'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { alerts, alertTriggers, authUsers, calendarEvents, jobRuns, operationalSchedules, organizations } from '~/shared/lib/db/schema'
import { insertCalendar, insertEvent } from '~/shared/lib/repositories/calendar'
import { syncScheduleRegistry, withJobRun } from '~/shared/lib/repositories/platform-operations'
import { buildCalendarFeed } from '~/lib/calendar/projections'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'prj-org'
const OTHER_ORG = 'prj-other'
const ALICE = 'prj-alice'
const BOB = 'prj-bob'
const NOW = new Date('2027-07-15T10:00:00.000Z')
const RANGE = { from: new Date('2027-07-01T00:00:00.000Z'), to: new Date('2027-08-01T00:00:00.000Z') }

let calendarId: string

function principal(userId = ALICE, organizationId = ORG): TenantPrincipal {
  return { userId, organizationId, role: 'member', requestId: 'req-test' }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('calendar_projections')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values([
    { id: ORG, name: 'Prj', slug: 'prj-org' },
    { id: OTHER_ORG, name: 'Other', slug: 'prj-other' },
  ])
  await db.insert(authUsers).values([
    { id: ALICE, name: 'Alice', email: 'prj-alice@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: BOB, name: 'Bob', email: 'prj-bob@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
  calendarId = (await db.transaction((tx) => insertCalendar(tx, {
    organizationId: ORG, ownerUserId: ALICE, name: 'Cal', timezone: 'UTC', isDefault: true,
  }))).id
}, 60_000)

afterAll(async () => {
  await drop()
})

beforeEach(async () => {
  await db.delete(alertTriggers)
  await db.delete(alerts)
  await db.delete(jobRuns)
  await db.delete(operationalSchedules)
  // Events too: a leftover event from an earlier case makes the range assertions below pass or fail
  // for the wrong reason. (The first version of this file omitted it and the range test caught it.)
  await db.delete(calendarEvents)
})

async function seedEvent(title = 'Standup', startsAt = new Date('2027-07-20T09:00:00.000Z')) {
  return db.transaction((tx) => insertEvent(tx, {
    organizationId: ORG, calendarId, ownerUserId: ALICE, type: 'personal', status: 'scheduled',
    title, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    timezone: 'UTC', allDay: false, busy: true,
  }))
}

async function seedAlert(options: {
  id?: string
  userId?: string
  nextEvaluationAt?: Date | null
  consecutiveFailures?: number
} = {}) {
  const id = options.id ?? 'prj-alert'
  await db.insert(alerts).values({
    id,
    organizationId: ORG,
    userId: options.userId ?? ALICE,
    name: 'Rust watch',
    keywords: ['rust'],
    frequency: 'daily',
    enabled: true,
    nextEvaluationAt: options.nextEvaluationAt ?? new Date('2027-07-21T06:00:00.000Z'),
    consecutiveFailures: options.consecutiveFailures ?? 0,
  })
  return id
}

function feed(layers: Parameters<typeof buildCalendarFeed>[2]['layers'], overrides: Partial<Parameters<typeof buildCalendarFeed>[2]> = {}) {
  return db.transaction((tx) => buildCalendarFeed(tx, principal(), { ...RANGE, layers, ...overrides }, db))
}

describe('buildCalendarFeed — contract', () => {
  it('returns a response that satisfies the closed feed schema', async () => {
    await seedEvent()
    await seedAlert()
    await syncScheduleRegistry(NOW, db)

    const response = await feed(['events', 'jobs', 'alerts'])

    // The schema is `.strict()`, so this also proves no extra field (notably `organizationId`)
    // reached the wire.
    expect(() => calendarFeedResponseSchema.parse(response)).not.toThrow()
  })

  it('marks every projection non-editable and the event editable', async () => {
    await seedEvent()
    await seedAlert()
    await syncScheduleRegistry(NOW, db)

    const response = await feed(['events', 'jobs', 'alerts'])

    for (const item of response.items) {
      // A draggable projection would edit nothing — the change would vanish on the next fetch.
      expect(item.editable).toBe(item.kind === 'event')
    }
  })

  it('distinguishes an intended run from one that happened', async () => {
    await syncScheduleRegistry(NOW, db)
    await withJobRun({ jobKey: 'calendar.reminder-delivery', now: new Date('2027-07-10T08:00:00.000Z'), db },
      async () => ({ processedCount: 2, failedCount: 0 }))

    const response = await feed(['jobs'])
    const projection = response.items.find((item) => item.kind === 'job_projection')
    const run = response.items.find((item) => item.kind === 'job_run')

    expect(projection).toBeDefined()
    expect(run).toBeDefined()
    // A user planning around a prediction is making a different decision than one reading a record.
    expect(projection && 'estimateOnly' in projection && projection.estimateOnly).toBe(true)
    expect(run && 'estimateOnly' in run && run.estimateOnly).toBe(false)
  })

  it('never labels an alert projection as a promised match', async () => {
    await seedAlert()
    const response = await feed(['alerts'])
    const projection = response.items.find((item) => item.kind === 'alert_projection')

    // "Next check", never "next match" — the estimate says when we will look, not what we will find.
    expect(projection?.title).toContain('Next check')
    expect(projection?.title).not.toMatch(/match/i)
  })

  it('gives every item a non-zero span so a calendar can lay it out', async () => {
    await seedEvent()
    await seedAlert()
    await syncScheduleRegistry(NOW, db)
    await withJobRun({ jobKey: 'sprints.execute', now: new Date('2027-07-11T08:00:00.000Z'), db },
      async () => ({ processedCount: 1, failedCount: 0 }))

    const response = await feed(['events', 'jobs', 'alerts'])

    expect(response.items.length).toBeGreaterThan(0)
    for (const item of response.items) {
      expect(new Date(item.endsAt).getTime()).toBeGreaterThan(new Date(item.startsAt).getTime())
    }
  })
})

describe('buildCalendarFeed — layer filters', () => {
  beforeEach(async () => {
    await seedEvent()
    await seedAlert()
    await syncScheduleRegistry(NOW, db)
    await withJobRun({ jobKey: 'sprints.execute', now: new Date('2027-07-12T08:00:00.000Z'), db },
      async () => ({ processedCount: 1, failedCount: 0 }))
  })

  it.each([
    ['events', ['event']],
    ['jobs', ['job_projection', 'job_run']],
    ['alerts', ['alert_projection']],
  ] as const)('the %s layer returns only its own kinds', async (layer, allowedKinds) => {
    const response = await feed([layer])

    expect(response.items.length).toBeGreaterThan(0)
    for (const item of response.items) {
      expect(allowedKinds).toContain(item.kind)
    }
  })

  it('returns nothing at all for an empty layer list', async () => {
    const response = await feed([])
    expect(response.items).toEqual([])
  })
})

describe('buildCalendarFeed — range and isolation', () => {
  it('excludes an item that falls outside the range', async () => {
    await seedEvent('Inside', new Date('2027-07-20T09:00:00.000Z'))
    await seedEvent('Outside', new Date('2027-09-20T09:00:00.000Z'))

    const response = await feed(['events'])

    expect(response.items.map((item) => item.kind === 'event' && item.title)).toEqual(['Inside'])
  })

  it('treats the range as half-open on both ends', async () => {
    // `from` inclusive, `to` exclusive: an item starting exactly at `to` belongs to the next page.
    await seedEvent('At from', RANGE.from)
    await seedEvent('At to', RANGE.to)

    const titles = (await feed(['events'])).items
      .map((item) => (item.kind === 'event' ? item.title : null))
      .filter(Boolean)

    expect(titles).toContain('At from')
    expect(titles).not.toContain('At to')
  })

  it('never shows another user\'s alerts', async () => {
    await seedAlert({ id: 'bobs-alert', userId: BOB })

    const response = await feed(['alerts'])

    // An alert is a personal watch list; showing a colleague's would leak what they track.
    expect(response.items).toHaveLength(0)
  })

  it('never shows another user\'s alert matches', async () => {
    await seedAlert({ id: 'bobs-alert', userId: BOB })
    await db.insert(alertTriggers).values({
      id: 'bobs-trigger', organizationId: ORG, alertId: 'bobs-alert', userId: BOB,
      eventType: 'any_activity', matchedAt: new Date('2027-07-14T10:00:00.000Z'),
    })

    const response = await feed(['alerts'])
    expect(response.items.filter((item) => item.kind === 'alert_result')).toHaveLength(0)
  })

  it('omits platform-scoped jobs from a tenant feed', async () => {
    await syncScheduleRegistry(NOW, db)

    const response = await feed(['jobs'])

    // "Billing reconciliation" is not the organization's work; showing it would read as
    // "your account is doing this", which is untrue and unactionable for them.
    const titles = response.items.map((item) => item.title)
    expect(titles).not.toContain('Billing reconciliation')
    expect(titles).not.toContain('Builder discovery')
  })
})

describe('buildCalendarFeed — stale sources', () => {
  it('names a schedule whose next run is already in the past instead of drawing it', async () => {
    await syncScheduleRegistry(NOW, db)
    await db.update(operationalSchedules)
      .set({ nextRunAt: new Date('2020-01-01T00:00:00.000Z') })
      .where(eq(operationalSchedules.jobKey, 'calendar.reminder-delivery'))

    const response = await feed(['jobs'])

    // A next run in the past means nothing is executing — a confident future entry would be a lie.
    expect(response.staleSources).toContain('calendar.reminder-delivery')
    expect(response.items.some((item) => item.kind === 'job_projection' && item.sourceId === 'calendar.reminder-delivery')).toBe(false)
  })

  it('names a failing alert but still shows it', async () => {
    await seedAlert({ consecutiveFailures: 3 })

    const response = await feed(['alerts'])

    expect(response.staleSources).toContain('alert:prj-alert')
    // Hiding it would look like the alert was deleted; the user needs to see it exists and is struggling.
    expect(response.items.some((item) => item.kind === 'alert_projection')).toBe(true)
  })

  it('reports one broken worker once, not once per affected item', async () => {
    await syncScheduleRegistry(NOW, db)
    await db.update(operationalSchedules).set({ nextRunAt: new Date('2020-01-01T00:00:00.000Z') })

    const response = await feed(['jobs'])

    expect(new Set(response.staleSources).size).toBe(response.staleSources.length)
  })
})

describe('buildCalendarFeed — cost', () => {
  it('keeps the query count flat as item count grows', async () => {
    await syncScheduleRegistry(NOW, db)
    await seedAlert()
    for (let index = 0; index < 25; index += 1) {
      await seedEvent(`Event ${index}`, new Date(Date.UTC(2027, 6, 2 + (index % 25), 9, 0, 0)))
      await db.insert(alertTriggers).values({
        id: `trigger-${index}`, organizationId: ORG, alertId: 'prj-alert', userId: ALICE,
        eventType: 'any_activity', matchedAt: new Date(Date.UTC(2027, 6, 2 + (index % 20), 10, 0, 0)),
      })
    }

    // Counted by wrapping the transaction's own query methods, so this measures real statements
    // rather than an assumption about how many the code "should" issue.
    let queryCount = 0
    const response = await db.transaction((tx) => {
      const counted = new Proxy(tx, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver)
          if (property === 'select' || property === 'execute') {
            queryCount += 1
            return typeof value === 'function' ? value.bind(target) : value
          }
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as typeof tx
      return buildCalendarFeed(counted, principal(), { ...RANGE, layers: ['events', 'jobs', 'alerts'] }, db)
    })

    expect(response.items.length).toBeGreaterThan(20)
    // Three layers: events (1) + own alerts (1) + alert buckets (1). Jobs read the platform
    // connection, not this transaction. A per-item query would push this into the dozens.
    expect(queryCount).toBeLessThanOrEqual(6)
  })

  it('caps the returned item count', async () => {
    for (let index = 0; index < 12; index += 1) {
      await seedEvent(`Event ${index}`, new Date(Date.UTC(2027, 6, 2 + index, 9, 0, 0)))
    }

    const response = await feed(['events'], { limit: 5 })
    expect(response.items).toHaveLength(5)
  })

  it('returns items in chronological order', async () => {
    await seedEvent('Later', new Date('2027-07-25T09:00:00.000Z'))
    await seedEvent('Earlier', new Date('2027-07-05T09:00:00.000Z'))
    await seedAlert({ nextEvaluationAt: new Date('2027-07-15T09:00:00.000Z') })

    const response = await feed(['events', 'alerts'])
    const starts = response.items.map((item) => item.startsAt)

    expect([...starts].sort()).toEqual(starts)
  })
})
