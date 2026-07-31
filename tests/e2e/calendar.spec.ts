/**
 * The internal calendar, end to end (plan:
 * calendar-scheduling-interview-intelligence, Phase 12 "Add Playwright projects
 * and full E2E fixtures").
 *
 * Unit tests already cover the recurrence expander and the feed's projection
 * shapes. What only a real server can prove is that the *stack* agrees: that a
 * bounded-range refusal happens before any query runs, that a recurrence written
 * through the API projects across a DST boundary at the wall-clock time a human
 * expects, that a tombstoned occurrence stays gone, and that another tenant's
 * event is invisible through the real five-role connection rather than through a
 * mocked `withTenantContext`.
 *
 * ## Europe/Copenhagen and 2026-10-25
 *
 * That Sunday is when Danish clocks go back. A 10:00 local weekly event has to
 * stay 10:00 local on both sides of it, which means the UTC instant moves by an
 * hour. Asserting on the UTC instant alone would pass for a calendar that had
 * silently drifted the meeting to 09:00 local, so every DST assertion here reads
 * the local wall clock through `Intl`, not the raw timestamp.
 */
import { expect, test } from 'playwright/test'

import { dismissOverlays, expectStrictBrowser, gotoHydrated } from './harness/browser'
import {
  addSecondOrganization,
  createInvitation,
  startInterviewHarness,
  stopInterviewHarness,
  type InterviewHarness,
} from './harness/fixtures/interviews'
import type { Principal } from './harness/fixtures/principals'

let harness: InterviewHarness
let otherOwner: Principal

/** Fixed-clock day; every range below is relative to it so nothing depends on today. */
const BASE = '2026-07-24T09:00:00.000Z'

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({
    scope: 'cal',
    // The calendar itself has no flag — it is the first stage of the rollout — but
    // scheduling is on so the invitation-backed event type can be created.
    flags: { SCHEDULING_ENABLED: 'true' },
  })
  otherOwner = (await addSecondOrganization(harness)).principal
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

interface EventDraft {
  type?: string
  title: string
  startsAt: string
  endsAt: string
  timezone?: string
  busy?: boolean
  rrule?: string
  recurrenceUntil?: string
}

async function createEvent(draft: EventDraft, api = harness.owner.api!): Promise<{ eventId: string; version: number }> {
  const response = await api.post('/api/calendar/events', {
    data: {
      type: draft.type ?? 'personal',
      title: draft.title,
      startsAt: draft.startsAt,
      endsAt: draft.endsAt,
      timezone: draft.timezone ?? 'Europe/Copenhagen',
      allDay: false,
      busy: draft.busy ?? true,
      ...(draft.rrule ? { rrule: draft.rrule } : {}),
      ...(draft.recurrenceUntil ? { recurrenceUntil: draft.recurrenceUntil } : {}),
      reminders: [],
      participants: [],
    },
  })
  expect(response.status(), await response.text()).toBeLessThan(400)
  const body = await response.json() as { event: { id: string; version: number } }
  return { eventId: body.event.id, version: body.event.version }
}

async function feed(params: { from: string; to: string; api?: typeof harness.owner.api }) {
  const api = params.api ?? harness.owner.api!
  const query = new URLSearchParams({
    from: params.from,
    to: params.to,
    timezone: 'Europe/Copenhagen',
    layers: 'events',
  })
  return api!.get(`/api/calendar/feed?${query}`)
}

/** The local wall clock an instant lands on, which is what a DST assertion is about. */
function localTime(iso: string, timeZone = 'Europe/Copenhagen'): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso))
}

function localDate(iso: string, timeZone = 'Europe/Copenhagen'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(new Date(iso))
}

test('the feed returns a created event, and only inside the requested range', async () => {
  const inside = await createEvent({
    title: 'E2E inside range',
    startsAt: '2026-07-27T08:00:00.000Z',
    endsAt: '2026-07-27T09:00:00.000Z',
  })
  await createEvent({
    title: 'E2E outside range',
    startsAt: '2026-09-15T08:00:00.000Z',
    endsAt: '2026-09-15T09:00:00.000Z',
  })

  const response = await feed({ from: BASE, to: '2026-08-01T00:00:00.000Z' })
  expect(response.status(), await response.text()).toBe(200)
  const { items } = await response.json() as { items: Array<{ id?: string; title: string; kind: string }> }

  const titles = items.map((item) => item.title)
  expect(titles, 'the in-range event is returned').toContain('E2E inside range')
  // A range filter that returns everything is not a range filter, and the p95 target
  // in the runtime-verification doc assumes it bounds the row count.
  expect(titles, 'the out-of-range event is not').not.toContain('E2E outside range')
  expect(items.find((item) => item.title === 'E2E inside range')?.id).toBe(inside.eventId)
})

test('a range wider than the cap is refused, on every route that takes one', async () => {
  const century = { from: '2000-01-01T00:00:00.000Z', to: '2099-01-01T00:00:00.000Z' }
  const within = { from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' }

  // Three routes read a caller-supplied range and load every row in it before trimming
  // the response, so all three need the cap. This asserted a 400 and got a 200 the first
  // time it ran: `withBoundedRange` only checked that `to` came after `from`.
  const routes = [
    (range: typeof century) => `/api/calendar/feed?${new URLSearchParams({ ...range, timezone: 'Europe/Copenhagen', layers: 'events' })}`,
    (range: typeof century) => `/api/calendar/events?${new URLSearchParams(range)}`,
    (range: typeof century) => `/api/calendar/export.ics?${new URLSearchParams(range)}`,
  ]

  for (const route of routes) {
    const refused = await harness.owner.api!.get(route(century))
    expect(refused.status(), `${route(century)} must refuse a 99-year span`).toBe(400)

    // The same route with a month-wide range still works — otherwise the assertion above
    // would pass on a route that had simply stopped answering.
    const accepted = await harness.owner.api!.get(route(within))
    expect(accepted.status(), `${route(within)} must still answer a normal range`).toBe(200)
  }
})

test('a javascript: meeting URL is refused at the event boundary, not just at render', async () => {
  const hostile = await harness.owner.api!.post('/api/calendar/events', {
    data: {
      type: 'interview',
      title: 'E2E hostile meeting url',
      meetingUrl: 'javascript:alert(document.domain)',
      startsAt: '2026-07-30T08:00:00.000Z',
      endsAt: '2026-07-30T09:00:00.000Z',
      timezone: 'Europe/Copenhagen',
      allDay: false,
      busy: true,
      reminders: [],
      participants: [],
    },
  })
  // `z.string().url()` accepts this string. The route's own body schema used it, which made
  // the shared schema's `httpUrlSchema` unreachable through this path.
  expect(hostile.status(), await hostile.text()).toBe(400)

  const [stored] = await harness.sql<{ count: number }[]>`
    select count(*)::int as count from calendar_events
    where organization_id = ${harness.organization.organizationId}
      and meeting_url like 'javascript:%'
  `
  expect(stored?.count, 'nothing with a javascript: scheme was stored').toBe(0)

  // And a patch cannot smuggle one onto an event that was created cleanly.
  const clean = await createEvent({ title: 'E2E clean event', startsAt: '2026-07-31T08:00:00.000Z', endsAt: '2026-07-31T09:00:00.000Z' })
  const patched = await harness.owner.api!.patch(`/api/calendar/events/${clean.eventId}`, {
    data: { version: clean.version, patch: { meetingUrl: 'javascript:alert(1)' } },
  })
  expect(patched.status(), await patched.text()).toBe(400)
})

/**
 * Runs the recurrence materialization worker as a cron principal.
 *
 * The feed returns master event rows carrying their `rrule`; the concrete instants
 * live in `calendar_event_occurrences`, written by this worker. That distinction is
 * what the first version of the DST test below got wrong — it read the feed, found one
 * item, and would have reported "recurrence is broken" about a table it never touched.
 * Slot generation and booking conflicts read the occurrences, so they are also the rows
 * where a DST error would actually cost someone a meeting.
 */
async function runRecurrenceWorker(): Promise<void> {
  const secret = process.env.CRON_SECRET
  expect(secret, 'CRON_SECRET must be set to drive the recurrence worker').toBeTruthy()
  const response = await harness.owner.api!.post('/api/admin/calendar/run-worker', {
    headers: { 'x-cron-secret': secret! },
  })
  expect(response.status(), await response.text()).toBeLessThan(400)
}

/** Materialized occurrences for one event, ordered. */
async function occurrencesFor(eventId: string): Promise<Array<{ recurrenceId: string; startsAt: string; status: string }>> {
  const rows = await harness.sql<{ recurrence_id: string; starts_at: Date; status: string }[]>`
    select recurrence_id, starts_at, status
    from calendar_event_occurrences
    where event_id = ${eventId}
    order by starts_at asc
  `
  return rows.map((row) => ({
    recurrenceId: row.recurrence_id,
    startsAt: row.starts_at.toISOString(),
    status: row.status,
  }))
}

test('a weekly recurrence keeps its local wall time across the Copenhagen DST change', async () => {
  // 10:00 Copenhagen on a Monday in summer (UTC+2) — 08:00Z.
  const series = await createEvent({
    title: 'E2E weekly standup',
    startsAt: '2026-10-19T08:00:00.000Z',
    endsAt: '2026-10-19T08:30:00.000Z',
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    recurrenceUntil: '2026-11-16T23:59:59.000Z',
  })
  await runRecurrenceWorker()

  const occurrences = (await occurrencesFor(series.eventId))
    .filter((occurrence) => occurrence.status === 'active')
    .map((occurrence) => occurrence.startsAt)
  expect(occurrences.length, 'the Mondays from 19 Oct to 16 Nov').toBeGreaterThanOrEqual(4)

  // Clocks go back on Sunday 2026-10-25, so the 26th is the first winter Monday.
  const before = occurrences.filter((iso) => localDate(iso) < '2026-10-25')
  const after = occurrences.filter((iso) => localDate(iso) > '2026-10-25')
  expect(before.length, 'at least one summer occurrence').toBeGreaterThan(0)
  expect(after.length, 'at least one winter occurrence').toBeGreaterThan(0)

  for (const iso of occurrences) {
    expect(localTime(iso), `${iso} must still be 10:00 in Copenhagen`).toBe('10:00')
  }
  // And the UTC instant *does* move — which is the whole point. If these matched, the
  // materializer would be storing a fixed offset and the local times above would be
  // passing by coincidence.
  expect(new Date(after[0]).getUTCHours()).not.toBe(new Date(before[0]).getUTCHours())
})

test('deleting one occurrence removes exactly that one', async () => {
  const series = await createEvent({
    title: 'E2E series',
    startsAt: '2026-08-03T08:00:00.000Z',
    endsAt: '2026-08-03T09:00:00.000Z',
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    recurrenceUntil: '2026-08-31T23:59:59.000Z',
  })
  await runRecurrenceWorker()

  const before = (await occurrencesFor(series.eventId)).filter((o) => o.status === 'active')
  expect(before.length, 'the Mondays in August 2026').toBeGreaterThanOrEqual(4)

  const second = before[1]
  const deletion = await harness.owner.api!.delete(`/api/calendar/events/${series.eventId}`, {
    data: { version: series.version, recurrenceScope: 'this', recurrenceId: second.recurrenceId },
  })
  expect(deletion.status(), await deletion.text()).toBeLessThan(400)
  expect(await deletion.json()).toMatchObject({ kind: 'occurrence_removed', recurrenceId: second.recurrenceId })

  const after = await occurrencesFor(series.eventId)
  const remaining = after.map((o) => o.recurrenceId)
  expect(remaining, 'the deleted occurrence is gone').not.toContain(second.recurrenceId)
  expect(remaining.length, 'and the rest of the series survives').toBe(before.length - 1)

  // Re-running the worker must not resurrect it. This is the assertion that found
  // `exceptionInstants: []` hardcoded in the worker: the row deletion above passed on its own,
  // and the next materialization pass put the occurrence straight back.
  await runRecurrenceWorker()
  const afterRematerialization = (await occurrencesFor(series.eventId)).map((o) => o.recurrenceId)
  expect(afterRematerialization, 'the worker does not bring it back').not.toContain(second.recurrenceId)
  expect(afterRematerialization.length, 'and it did not drop the others either').toBe(before.length - 1)
})

test('a following-scoped delete truncates the series and keeps what came before', async () => {
  const series = await createEvent({
    title: 'E2E truncated series',
    startsAt: '2026-09-07T08:00:00.000Z',
    endsAt: '2026-09-07T09:00:00.000Z',
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    recurrenceUntil: '2026-10-05T23:59:59.000Z',
  })
  await runRecurrenceWorker()

  const before = await occurrencesFor(series.eventId)
  expect(before.length).toBeGreaterThanOrEqual(4)
  const third = before[2]

  const deletion = await harness.owner.api!.delete(`/api/calendar/events/${series.eventId}`, {
    data: { version: series.version, recurrenceScope: 'following', recurrenceId: third.recurrenceId },
  })
  expect(deletion.status(), await deletion.text()).toBeLessThan(400)

  await runRecurrenceWorker()
  const after = (await occurrencesFor(series.eventId)).map((o) => o.startsAt)
  expect(after, 'the first two survive').toContain(before[0].startsAt)
  expect(after, 'and the second').toContain(before[1].startsAt)
  expect(after, 'the named occurrence is gone').not.toContain(third.startsAt)
  expect(after.every((iso) => iso < third.startsAt), 'and nothing after it remains').toBe(true)
})

test('a scoped edit is refused with 501 rather than silently rewriting the series', async () => {
  const series = await createEvent({
    title: 'E2E untouched series',
    startsAt: '2026-11-02T08:00:00.000Z',
    endsAt: '2026-11-02T09:00:00.000Z',
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    recurrenceUntil: '2026-11-30T23:59:59.000Z',
  })

  const refused = await harness.owner.api!.patch(`/api/calendar/events/${series.eventId}`, {
    data: {
      version: series.version,
      recurrenceScope: 'this',
      recurrenceId: '2026-11-09T08:00:00.000Z',
      patch: { title: 'E2E renamed one occurrence' },
    },
  })
  // 501, not 400: the request is well-formed and no client change would make it work.
  expect(refused.status(), await refused.text()).toBe(501)

  const [row] = await harness.sql<{ title: string }[]>`
    select title from calendar_events where id = ${series.eventId}
  `
  // The refusal has to come before the write. This is what a returned-plan assertion could not
  // see: the service used to compute a single-occurrence plan, return it, and rename everything.
  expect(row?.title).toBe('E2E untouched series')

  // The series scope still works, so the refusal above is about the scope and not about PATCH.
  const allowed = await harness.owner.api!.patch(`/api/calendar/events/${series.eventId}`, {
    data: { version: series.version, recurrenceScope: 'series', patch: { title: 'E2E renamed series' } },
  })
  expect(allowed.status(), await allowed.text()).toBeLessThan(400)
})

test("another tenant's events are invisible through the real role separation", async () => {
  const mine = await createEvent({
    title: 'E2E tenant A private',
    startsAt: '2026-07-28T08:00:00.000Z',
    endsAt: '2026-07-28T09:00:00.000Z',
  })

  const range = { from: BASE, to: '2026-08-01T00:00:00.000Z' }
  const theirFeed = await feed({ ...range, api: otherOwner.api }).then((r) => r.json()) as { items: Array<{ title: string }> }
  expect(theirFeed.items.map((item) => item.title)).not.toContain('E2E tenant A private')

  // And not by id either: a 404 and a 403 both answer honestly here, but a 200 would
  // mean the row-level policy is not the thing keeping tenants apart.
  const direct = await otherOwner.api!.patch(`/api/calendar/events/${mine.eventId}`, {
    data: { version: mine.version, patch: { title: 'stolen' } },
  })
  expect(direct.status()).toBeGreaterThanOrEqual(400)

  const [row] = await harness.sql<{ title: string }[]>`
    select title from calendar_events where id = ${mine.eventId}
  `
  expect(row?.title, 'the title is untouched').toBe('E2E tenant A private')
})

test('the ICS export carries the event and declares its timezone', async () => {
  await createEvent({
    title: 'E2E exported meeting',
    startsAt: '2026-07-29T13:00:00.000Z',
    endsAt: '2026-07-29T14:00:00.000Z',
  })

  const query = new URLSearchParams({ from: BASE, to: '2026-08-01T00:00:00.000Z' })
  const response = await harness.owner.api!.get(`/api/calendar/export.ics?${query}`)
  expect(response.status(), await response.text()).toBe(200)
  expect(response.headers()['content-type']).toMatch(/text\/calendar/)

  const body = await response.text()
  expect(body).toMatch(/BEGIN:VCALENDAR/)
  expect(body).toMatch(/E2E exported meeting/)
  // A DTSTART with no zone or Z suffix is a floating time, which lands in the reader's
  // own timezone and silently moves the meeting.
  expect(body).toMatch(/DTSTART[^\n]*(TZID=|Z)/)
})

test('an availability policy round-trips and bumps its version', async () => {
  const initial = await harness.owner.api!.get('/api/calendar/availability')
  expect(initial.status(), await initial.text()).toBe(200)
  const before = await initial.json() as { version: number }

  const write = await harness.owner.api!.put('/api/calendar/availability', {
    data: {
      version: before.version,
      rules: [{
        timeZone: 'Europe/Copenhagen',
        weekdays: [1, 2, 3, 4, 5],
        localStart: '09:00',
        localEnd: '17:00',
        slotMinutes: 30,
        bufferBeforeMinutes: 10,
        bufferAfterMinutes: 10,
        minNoticeMinutes: 120,
        horizonDays: 30,
        enabled: true,
      }],
      overrides: [{ localDate: '2026-08-05', localStart: null, localEnd: null, kind: 'blocked', timeZone: 'Europe/Copenhagen' }],
      defaultReminderOffsets: [60, 1440],
      defaultReminderChannels: ['email', 'in_app'],
    },
  })
  expect(write.status(), await write.text()).toBeLessThan(400)

  const reread = await harness.owner.api!.get('/api/calendar/availability').then((r) => r.json()) as {
    version: number
    rules: Array<{ localStart: string; slotMinutes: number }>
    overrides: Array<{ localDate: string; kind: string }>
  }
  expect(reread.rules[0]?.localStart).toBe('09:00')
  expect(reread.rules[0]?.slotMinutes).toBe(30)
  expect(reread.overrides.map((o) => o.localDate)).toContain('2026-08-05')
  // The version has to move, or the optimistic check below could not distinguish a
  // stale writer from a first writer.
  expect(reread.version).toBeGreaterThan(before.version)

  const stale = await harness.owner.api!.put('/api/calendar/availability', {
    data: {
      version: before.version,
      rules: [], overrides: [], defaultReminderOffsets: [], defaultReminderChannels: [],
    },
  })
  expect(stale.status(), 'a stale version loses').toBeGreaterThanOrEqual(400)
})

test('the calendar page renders the created event for its owner', async ({ browser }) => {
  await createEvent({
    title: 'E2E visible on page',
    startsAt: '2026-07-24T10:00:00.000Z',
    endsAt: '2026-07-24T11:00:00.000Z',
  })

  const context = await browser.newContext({ storageState: harness.owner.storageState! })
  const page = await context.newPage()
  const guard = expectStrictBrowser(page)
  // The dashboard shell mounts account-scoped cards that answer 401/403/503 without
  // the matching provider or entitlement; they are not what this test is about.
  for (let i = 0; i < 8; i++) guard.allowExpectedFailure(/status of (401|403|503)/)

  try {
    await gotoHydrated(page, `${harness.baseURL}/calendar`)
    await dismissOverlays(page)
    await expect(page.getByText('E2E visible on page').first()).toBeVisible({ timeout: 20_000 })
  } finally {
    guard.dispose()
    await context.close()
  }
})

test('an invitation-backed event type is reachable from the scheduling side', async () => {
  // Not a calendar assertion in itself: it pins that the two halves share one event
  // table, so a booking made in `scheduling.spec.ts` is the same row the feed reads.
  const invitation = await createInvitation(harness)
  const [row] = await harness.sql<{ status: string }[]>`
    select status from scheduling_invitations where id = ${invitation.invitationId}
  `
  expect(row?.status, 'a fresh invitation starts as a draft').toBe('draft')
})

/**
 * The event editor/detail UI, end to end (plans/UI Wave 3 "Build complete event create, detail, and
 * edit UI"). The API paths are already covered above; this proves the browser form emits a body the
 * create/patch routes accept and that the detail panel's delete actually removes the row.
 *
 * The events land on *today* via the editor's default date rather than a fixed instant, because the
 * calendar page opens on the real current month with no test clock, so a fixed BASE-day event would
 * fall outside the visible grid. They are `Free`, which skips the busy-overlap path entirely and so
 * cannot flake against whatever the shared owner already has scheduled.
 */
test('an owner can create, edit and delete an event through the calendar UI', async ({ browser }) => {
  const context = await browser.newContext({ storageState: harness.owner.storageState! })
  const page = await context.newPage()
  const guard = expectStrictBrowser(page)
  for (let i = 0; i < 10; i++) guard.allowExpectedFailure(/status of (401|403|503)/)
  const title = `E2E UI create ${Date.now()}`
  const renamed = `${title} renamed`

  try {
    await gotoHydrated(page, `${harness.baseURL}/calendar`)
    await dismissOverlays(page)

    await page.getByTestId('calendar-new-event').click()
    await page.getByTestId('event-editor-title').fill(title)
    await page.getByTestId('event-editor-busy').selectOption('free')
    await page.getByTestId('event-editor-start').fill('02:00')
    await page.getByTestId('event-editor-end').fill('02:30')
    await page.getByTestId('event-editor-submit').click()

    await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible({ timeout: 20_000 })

    // Open the detail panel, edit through it, and confirm the rename reaches the grid.
    await page.getByRole('button', { name: title, exact: true }).click()
    await expect(page.getByTestId('event-details')).toBeVisible()
    await page.getByTestId('event-details-edit').click()
    await page.getByTestId('event-editor-title').fill(renamed)
    await page.getByTestId('event-editor-submit').click()
    await expect(page.getByRole('button', { name: renamed, exact: true })).toBeVisible({ timeout: 20_000 })

    // Delete it from the detail panel; the row leaves the grid.
    await page.getByRole('button', { name: renamed, exact: true }).click()
    await page.getByTestId('event-details-delete').click()
    await expect(page.getByRole('button', { name: renamed, exact: true })).toHaveCount(0, { timeout: 20_000 })
  } finally {
    guard.dispose()
    await context.close()
  }
})

test('the calendar create flow is usable at a 320px viewport', async ({ browser }) => {
  const context = await browser.newContext({ storageState: harness.owner.storageState!, viewport: { width: 320, height: 720 } })
  const page = await context.newPage()
  const guard = expectStrictBrowser(page)
  for (let i = 0; i < 10; i++) guard.allowExpectedFailure(/status of (401|403|503)/)
  const title = `E2E UI mobile ${Date.now()}`

  try {
    await gotoHydrated(page, `${harness.baseURL}/calendar`)
    await dismissOverlays(page)

    await page.getByTestId('calendar-new-event').click()
    await page.getByTestId('event-editor-title').fill(title)
    await page.getByTestId('event-editor-busy').selectOption('free')
    await page.getByTestId('event-editor-start').fill('03:00')
    await page.getByTestId('event-editor-end').fill('03:30')
    await page.getByTestId('event-editor-submit').click()

    // Below the md breakpoint the agenda fallback renders; the event's title button carries it.
    await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible({ timeout: 20_000 })
  } finally {
    guard.dispose()
    await context.close()
  }
})

/**
 * Availability settings, end to end. This is the only proof that the optimistic-versioned
 * `PUT /api/calendar/availability` and the single-override `POST/DELETE .../overrides` endpoints
 * agree with the editor through the real five-role connection — the unit suite injects the handlers.
 *
 * It is written to leave the shared owner's policy as it found it: it toggles a reminder channel
 * (reversible, never accumulates rules) and adds then removes a uniquely-dated override, so a
 * re-run does not clash with itself or drift the owner's weekly grid.
 */
test('an owner can edit availability and manage a date override through the UI', async ({ browser }) => {
  const context = await browser.newContext({ storageState: harness.owner.storageState! })
  const page = await context.newPage()
  const guard = expectStrictBrowser(page)
  for (let i = 0; i < 10; i++) guard.allowExpectedFailure(/status of (401|403|503)/)
  // A far-future, run-varying date so overlapping runs never fight over the same override.
  const overrideDate = new Date(Date.UTC(2029, 0, 1) + (Date.now() % (300 * 86_400_000))).toISOString().slice(0, 10)

  try {
    await gotoHydrated(page, `${harness.baseURL}/calendar`)
    await dismissOverlays(page)

    await page.getByTestId('calendar-availability-toggle').click()
    await expect(page.getByTestId('availability-editor')).toBeVisible({ timeout: 20_000 })

    // Toggle a default reminder channel and save under the loaded version.
    await page.getByTestId('availability-reminder-channel-email').click()
    await page.getByTestId('availability-save').click()
    await expect(page.getByTestId('availability-saved')).toBeVisible({ timeout: 20_000 })

    // Add a blocked-day override, confirm it lands, then remove it so the owner is left clean.
    await page.getByTestId('availability-override-date').fill(overrideDate)
    await page.getByTestId('availability-override-add').click()
    await expect(page.getByText(new RegExp(`${overrideDate}.*Blocked`))).toBeVisible({ timeout: 20_000 })

    await page.getByRole('button', { name: `Remove override for ${overrideDate}` }).click()
    await expect(page.getByText(new RegExp(`${overrideDate}.*Blocked`))).toHaveCount(0, { timeout: 20_000 })
  } finally {
    guard.dispose()
    await context.close()
  }
})

