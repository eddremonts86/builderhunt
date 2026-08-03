/**
 * Slot generation and concurrent booking (plan:
 * calendar-scheduling-interview-intelligence, Phase 12; spec.md targets: slots under 750 ms p95 and
 * zero double booking).
 *
 * ## The double-booking check is the point of this file
 *
 * The latency half is easy to satisfy and easy to trust. The concurrency half is neither, and it has
 * already been wrong once in a way no unit test could see: `pg_advisory_xact_lock` serialized the two
 * bookings correctly, and both still succeeded, because the slot recomputation ran under a role that
 * could not see the other candidate's event. The lock was never the weak part — the *visibility* the
 * recomputation depended on was.
 *
 * So this fires N genuinely concurrent bookings at one slot and counts the rows that land. Not the
 * responses: a service can answer `409` and still have written a row, and it can answer `200` twice
 * and have written one. The table is the only honest answer.
 *
 * ## Why 8 and not 2
 *
 * Two concurrent requests can both pass a broken lock by accident of timing. Eight makes an
 * unserialized path essentially certain to produce more than one row, and still runs in under a
 * second.
 */
import { pin, report, seedTenant, summarise, timeIt, withBenchDatabase } from './_harness.mjs'

const ORGANIZATION = 'bench-book-org'
const USER = 'bench-book-user'
const WARMUP = 3
const ITERATIONS = 40
const CONCURRENCY = 8

/** The two 32-bit advisory-lock keys `bookSlot` uses: owner hash and organizer-local day. */
function lockKeys(ownerUserId, localDay) {
  let a = 0
  for (let i = 0; i < ownerUserId.length; i++) a = (a * 31 + ownerUserId.charCodeAt(i)) | 0
  let b = 0
  for (let i = 0; i < localDay.length; i++) b = (b * 31 + localDay.charCodeAt(i)) | 0
  return [a, b]
}

await withBenchDatabase('scheduling_booking', async ({ sql, counter }) => {
  const calendarId = await seedTenant(sql, { organizationId: ORGANIZATION, userId: USER })

  await sql`
    insert into availability_rules
      (id, organization_id, owner_user_id, timezone, weekdays, local_start, local_end, slot_minutes,
       buffer_before_minutes, buffer_after_minutes, min_notice_minutes, horizon_days, enabled)
    values (gen_random_uuid(), ${ORGANIZATION}, ${USER}, 'Europe/Copenhagen', '{1,2,3,4,5}',
            '09:00', '17:00', 30, 0, 0, 0, 60, true)
  `

  // A realistically busy calendar: half the working slots already taken across 60 days.
  const start = new Date('2026-08-03T00:00:00.000Z')
  const dayMs = 24 * 60 * 60_000
  const busy = []
  for (let day = 0; day < 60; day++) {
    const weekday = new Date(start.getTime() + day * dayMs).getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    for (let slot = 0; slot < 8; slot++) {
      const startsAt = new Date(start.getTime() + day * dayMs + (7 + slot) * 3600_000)
      busy.push({
        organization_id: ORGANIZATION, calendar_id: calendarId, owner_user_id: USER,
        type: 'interview', status: 'confirmed', title: `Bench busy d${day} s${slot}`,
        starts_at: startsAt, ends_at: new Date(startsAt.getTime() + 30 * 60_000),
        timezone: 'Europe/Copenhagen', all_day: false, busy: true,
      })
    }
  }
  await sql`insert into calendar_events ${sql(busy)}`
  const [{ events }] = await sql`select count(*)::int as events from calendar_events`

  // The read slot generation performs, through the privileged function the capability role uses.
  const from = new Date(start.getTime() + 7 * dayMs)
  const to = new Date(start.getTime() + 21 * dayMs)
  const readBusy = () => sql.begin(async (transaction) => {
    await pin(transaction, { organizationId: ORGANIZATION, userId: USER })
    return transaction`select starts_at, ends_at from scheduling_busy_ranges(${USER}, ${from}, ${to})`
  })

  for (let i = 0; i < WARMUP; i++) await readBusy()

  const samples = []
  let busyRows = 0
  counter.reset()
  for (let i = 0; i < ITERATIONS; i++) {
    const { value, elapsedMs } = await timeIt(readBusy)
    samples.push(elapsedMs)
    busyRows = value.length
  }
  const statementsPerRead = counter.value / ITERATIONS

  /*
   * The race. One free slot, `CONCURRENCY` writers, each taking the same advisory lock and then
   * checking the slot exactly as `bookSlot` does: is anything busy overlapping this instant?
   *
   * The check runs *through* `scheduling_busy_ranges`, which is the correction from 0097 and the
   * thing that makes the serialization mean something. Reverting that function to a bare row read
   * under the capability role is what produced two winners.
   */
  const contested = new Date(start.getTime() + 3 * dayMs + 16 * 3600_000)
  const contestedEnd = new Date(contested.getTime() + 30 * 60_000)
  const [ownerKey, dayKey] = lockKeys(USER, contested.toISOString().slice(0, 10))

  const attempts = Array.from({ length: CONCURRENCY }, (_, index) => sql.begin(async (transaction) => {
    await pin(transaction, { organizationId: ORGANIZATION, userId: USER })
    await transaction`select pg_advisory_xact_lock(${ownerKey}, ${dayKey})`
    const conflicts = await transaction`
      select starts_at from scheduling_busy_ranges(${USER}, ${contested}, ${contestedEnd})
      where starts_at < ${contestedEnd} and ends_at > ${contested}
    `
    if (conflicts.length > 0) return { index, booked: false }
    await transaction`
      insert into calendar_events
        (organization_id, calendar_id, owner_user_id, type, status, title, starts_at, ends_at,
         timezone, all_day, busy)
      values (${ORGANIZATION}, ${calendarId}, ${USER}, 'interview', 'confirmed',
              ${`Bench contested by ${index}`}, ${contested}, ${contestedEnd},
              'Europe/Copenhagen', false, true)
    `
    return { index, booked: true }
  }))

  const raced = await timeIt(() => Promise.all(attempts))
  const claimedWinners = raced.value.filter((attempt) => attempt.booked).length
  const [{ landed }] = await sql`
    select count(*)::int as landed from calendar_events
    where starts_at = ${contested} and organization_id = ${ORGANIZATION} and type = 'interview'
  `

  report('scheduling-booking', {
    seeded: { events, busyRowsInWindow: busyRows },
    busyRangeRead: summarise('14-day busy-range read', samples, 750),
    statementsPerRead,
    race: {
      concurrency: CONCURRENCY,
      claimedWinners,
      // The only number that matters. `claimedWinners` is what the code believed; `rowsLanded` is
      // what a candidate would find on the organizer's calendar.
      rowsLanded: landed,
      zeroDoubleBooking: landed === 1,
      elapsedMs: Number(raced.elapsedMs.toFixed(1)),
    },
    caveats: [
      'Runs as the migration role: RLS policy evaluation is NOT included in these numbers.',
      'The race reproduces bookSlot\'s lock-then-recompute shape in SQL, not the service itself.',
      `${WARMUP} warm-up iterations discarded.`,
    ],
  })
})
