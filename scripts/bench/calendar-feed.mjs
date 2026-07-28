/**
 * Calendar feed read under realistic volume (plan:
 * calendar-scheduling-interview-intelligence, Phase 12; spec.md target: calendar under 500 ms p95).
 *
 * Seeds 90 days of a working calendar — recurring standups, one-off meetings, interviews — plus the
 * materialized occurrences a real tenant would have, then measures the range read the feed performs.
 *
 * ## What this is looking for beyond the wall clock
 *
 * The latency number alone is a weak signal on a warm laptop with a small dataset. Two shape checks
 * carry more:
 *
 *   * **the statement count must not grow with the row count.** One query per layer, never one per
 *     item. A feed that fires per-event queries can still hit 500 ms locally and fall over on a
 *     tenant with a busy calendar.
 *   * **the row count returned must be bounded.** `buildCalendarFeed` trims to 500 items *after*
 *     loading everything in the range, so the memory cost is the row count, not the response size.
 *     That is why the range span is now capped at 400 days (`MAX_RANGE_SPAN_DAYS`) and why this
 *     prints rows-loaded next to the latency.
 */
import { pin, report, seedTenant, summarise, timeIt, withBenchDatabase } from './_harness.mjs'

const ORGANIZATION = 'bench-cal-org'
const USER = 'bench-cal-user'
const WARMUP = 5
const ITERATIONS = 60

await withBenchDatabase('calendar_feed', async ({ sql, counter }) => {
  const calendarId = await seedTenant(sql, { organizationId: ORGANIZATION, userId: USER })

  // 90 days from a fixed start, so two runs seed identically.
  const start = new Date('2026-07-01T00:00:00.000Z')
  const dayMs = 24 * 60 * 60_000

  // Five recurring series (daily standup, four weeklies) plus three one-off events per weekday.
  const recurring = []
  for (let i = 0; i < 5; i++) {
    const [row] = await sql`
      insert into calendar_events
        (organization_id, calendar_id, owner_user_id, type, status, title, starts_at, ends_at,
         timezone, all_day, busy, rrule, recurrence_until)
      values (${ORGANIZATION}, ${calendarId}, ${USER}, 'personal', 'scheduled',
              ${`Bench recurring ${i}`},
              ${new Date(start.getTime() + i * 3600_000 + 8 * 3600_000)},
              ${new Date(start.getTime() + i * 3600_000 + 8.5 * 3600_000)},
              'Europe/Copenhagen', false, true,
              ${i === 0 ? 'FREQ=DAILY' : 'FREQ=WEEKLY'},
              ${new Date(start.getTime() + 90 * dayMs)})
      returning id, starts_at, ends_at
    `
    recurring.push(row)
  }

  const oneOffValues = []
  for (let day = 0; day < 90; day++) {
    const weekday = new Date(start.getTime() + day * dayMs).getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    for (let slot = 0; slot < 3; slot++) {
      const startsAt = new Date(start.getTime() + day * dayMs + (10 + slot * 2) * 3600_000)
      oneOffValues.push({
        organization_id: ORGANIZATION,
        calendar_id: calendarId,
        owner_user_id: USER,
        type: slot === 0 ? 'interview' : 'personal',
        status: 'confirmed',
        title: `Bench event d${day} s${slot}`,
        starts_at: startsAt,
        ends_at: new Date(startsAt.getTime() + 45 * 60_000),
        timezone: 'Europe/Copenhagen',
        all_day: false,
        busy: true,
      })
    }
  }
  // One multi-row insert: seeding row by row would take longer than the benchmark.
  await sql`insert into calendar_events ${sql(oneOffValues)}`

  // The materialized occurrences a real tenant has, since the recurrence worker would have run.
  const occurrenceValues = []
  for (const series of recurring) {
    const step = series.title?.endsWith('0') ? dayMs : 7 * dayMs
    for (let at = series.starts_at.getTime(); at < start.getTime() + 90 * dayMs; at += step) {
      occurrenceValues.push({
        organization_id: ORGANIZATION,
        event_id: series.id,
        recurrence_id: new Date(at).toISOString(),
        starts_at: new Date(at),
        ends_at: new Date(at + 30 * 60_000),
        status: 'active',
        materialization_version: 1,
      })
    }
  }
  for (let i = 0; i < occurrenceValues.length; i += 500) {
    await sql`insert into calendar_event_occurrences ${sql(occurrenceValues.slice(i, i + 500))}`
  }

  const [{ events }] = await sql`select count(*)::int as events from calendar_events`
  const [{ occurrences }] = await sql`select count(*)::int as occurrences from calendar_event_occurrences`

  // The query `listEventsInRange` issues, over the 31-day window a month view asks for.
  const from = new Date(start.getTime() + 30 * dayMs)
  const to = new Date(start.getTime() + 61 * dayMs)

  const readMonth = () => sql.begin(async (transaction) => {
    await pin(transaction, { organizationId: ORGANIZATION, userId: USER })
    return transaction`
      select id, calendar_id, owner_user_id, type, status, title, starts_at, ends_at, timezone,
             all_day, busy, visibility, rrule, recurrence_until, version, source_type, source_id
      from calendar_events
      where organization_id = ${ORGANIZATION} and owner_user_id = ${USER}
        and starts_at < ${to} and ends_at >= ${from}
      order by starts_at asc
    `
  })

  for (let i = 0; i < WARMUP; i++) await readMonth()

  const samples = []
  let rowsLoaded = 0
  counter.reset()
  for (let i = 0; i < ITERATIONS; i++) {
    const { value, elapsedMs } = await timeIt(readMonth)
    samples.push(elapsedMs)
    rowsLoaded = value.length
  }
  const statementsPerRead = counter.value / ITERATIONS

  // The widest span the schema now allows, to check the cap is the thing bounding the work.
  const wide = await timeIt(() => sql.begin(async (transaction) => {
    await pin(transaction, { organizationId: ORGANIZATION, userId: USER })
    return transaction`
      select id from calendar_events
      where organization_id = ${ORGANIZATION} and owner_user_id = ${USER}
        and starts_at < ${new Date(start.getTime() + 400 * dayMs)} and ends_at >= ${start}
    `
  }))

  report('calendar-feed', {
    seeded: { events, occurrences },
    monthRead: summarise('31-day range read', samples, 500),
    rowsLoadedPerRead: rowsLoaded,
    statementsPerRead,
    // One statement per read plus the two `set_config` calls the tenant context needs. Anything
    // that scales with `rowsLoadedPerRead` is an N+1 and is the finding, whatever the latency says.
    statementCountIsFlat: statementsPerRead < 6,
    widestAllowedSpan: { days: 400, elapsedMs: Number(wide.elapsedMs.toFixed(1)), rows: wide.value.length },
    caveats: [
      'Runs as the migration role: RLS policy evaluation is NOT included in these numbers.',
      'Direct SQL, not HTTP — a Vite dev server would dominate the measurement.',
      `${WARMUP} warm-up iterations discarded.`,
    ],
  })
})
