/**
 * Transcript segment ingest under a long interview (plan:
 * calendar-scheduling-interview-intelligence, Phase 12; spec.md target: acknowledged segment
 * persistence at or above 99.9%, no unbounded memory growth).
 *
 * ## What "99.9% of acknowledged segments persist" actually requires
 *
 * The capture client posts batches and treats a 2xx as an acknowledgement — it will not send those
 * segments again. So the number to measure is not "did the insert succeed" but "for every batch the
 * server acknowledged, is every segment in it readable afterwards". A partially-applied batch that
 * answers 200 is the failure this exists to catch, and it is invisible from the response.
 *
 * The insert is idempotent on `(session_id, provider_segment_id)`, so this also replays a fraction
 * of the batches the way a reconnecting client does, and counts rows rather than trusting the unique
 * index to be doing what its name suggests.
 *
 * ## Memory
 *
 * A 90-minute interview is roughly 1800 segments. Heap is sampled before and after ingest and the
 * delta is reported per segment: an ingest path that accumulates the whole transcript in process
 * memory looks identical in latency and fails on the longest interview of the month.
 */
import { report, summarise, timeIt, withBenchDatabase } from './_harness.mjs'

const ORGANIZATION = 'bench-seg-org'
const USER = 'bench-seg-user'
/** ~90 minutes of speech at one final result every three seconds. */
const TOTAL_SEGMENTS = 1800
const BATCH_SIZE = 20
/** One batch in eight is redelivered, which is a pessimistic reconnect rate. */
const REPLAY_EVERY = 8

await withBenchDatabase('transcript_segments', async ({ sql, counter }) => {
  await sql`insert into organizations (id, name, slug) values (${ORGANIZATION}, 'Bench', ${ORGANIZATION})`
  await sql`
    insert into auth_users (id, name, email, email_verified, created_at, updated_at)
    values (${USER}, 'Bench', ${`${USER}@bench.invalid`}, true, now(), now())
  `
  const [calendar] = await sql`
    insert into user_calendars (id, organization_id, owner_user_id, name, timezone, is_default)
    values (gen_random_uuid(), ${ORGANIZATION}, ${USER}, 'Bench', 'Europe/Copenhagen', true)
    returning id
  `
  const [event] = await sql`
    insert into calendar_events
      (organization_id, calendar_id, owner_user_id, type, status, title, starts_at, ends_at,
       timezone, all_day, busy)
    values (${ORGANIZATION}, ${calendar.id}, ${USER}, 'interview', 'confirmed', 'Bench interview',
            now(), now() + interval '90 minutes', 'Europe/Copenhagen', false, true)
    returning id
  `
  const [session] = await sql`
    insert into interview_sessions
      (organization_id, event_id, owner_user_id, state, capture_mode, language, provider,
       consent_notice_version, capture_capability, started_at, retention_expires_at, version)
    values (${ORGANIZATION}, ${event.id}, ${USER}, 'live', 'remote_call', 'en', 'deepgram',
            'bench-notice-v1', 'microphone_and_shared_audio_available', now(),
            now() + interval '90 days', 1)
    returning id
  `

  /** One batch, in the shape `submitSegments` receives it. */
  function batchAt(offset) {
    return Array.from({ length: BATCH_SIZE }, (_, i) => {
      const sequence = offset + i
      const startsMs = sequence * 3000
      return {
        organization_id: ORGANIZATION,
        session_id: session.id,
        provider_segment_id: `bench-req:0:${sequence}`,
        sequence,
        speaker_estimate: sequence % 2 === 0 ? 'speaker_a' : 'speaker_b',
        text: `Bench segment ${sequence} carrying a sentence of roughly the length a real final result has.`,
        starts_ms: startsMs,
        ends_ms: startsMs + 2900,
        confidence: 0.9,
        retention_expires_at: new Date(Date.now() + 90 * 24 * 60 * 60_000),
      }
    })
  }

  const heapBefore = process.memoryUsage().heapUsed
  const samples = []
  let acknowledgedSegments = 0
  let replayedBatches = 0
  counter.reset()

  for (let offset = 0; offset < TOTAL_SEGMENTS; offset += BATCH_SIZE) {
    const rows = batchAt(offset)
    const { elapsedMs } = await timeIt(() => sql`
      insert into transcript_segments ${sql(rows)}
      on conflict (organization_id, session_id, provider_segment_id) do nothing
    `)
    samples.push(elapsedMs)
    // Acknowledged: the server returned success, so the client will never resend these.
    acknowledgedSegments += rows.length

    if ((offset / BATCH_SIZE) % REPLAY_EVERY === 0) {
      // The redelivery a reconnecting client performs. Must not duplicate and must not fail.
      await sql`
        insert into transcript_segments ${sql(rows)}
        on conflict (organization_id, session_id, provider_segment_id) do nothing
      `
      replayedBatches += 1
    }
  }

  const heapAfter = process.memoryUsage().heapUsed
  const [{ persisted }] = await sql`
    select count(*)::int as persisted from transcript_segments where session_id = ${session.id}
  `
  const [{ distinctSequences }] = await sql`
    select count(distinct sequence)::int as "distinctSequences"
    from transcript_segments where session_id = ${session.id}
  `

  // The read the transcript panel performs: the whole session, ordered.
  const fullRead = await timeIt(() => sql`
    select sequence, speaker_estimate, text, starts_ms, ends_ms
    from transcript_segments where session_id = ${session.id} order by sequence asc
  `)

  const persistenceRate = persisted / acknowledgedSegments

  report('transcript-segments', {
    ingest: summarise(`${BATCH_SIZE}-segment batch insert`, samples),
    totals: { acknowledgedSegments, persisted, distinctSequences, replayedBatches },
    // The spec's number. `persisted === acknowledged` is the only passing answer at this scale —
    // 99.9% of 1800 would allow two lost segments, and nothing here should lose any.
    persistenceRate: Number(persistenceRate.toFixed(5)),
    meetsPersistenceTarget: persistenceRate >= 0.999,
    // Replays must be absorbed, not accumulated: `persisted` equal to `acknowledged` while
    // `replayedBatches` is non-zero is the proof that the unique index is doing the work.
    replaysAbsorbed: persisted === acknowledgedSegments && replayedBatches > 0,
    fullTranscriptRead: { rows: fullRead.value.length, elapsedMs: Number(fullRead.elapsedMs.toFixed(1)) },
    heapDeltaBytesPerSegment: Math.round((heapAfter - heapBefore) / acknowledgedSegments),
    statementsIssued: counter.value,
    caveats: [
      'Runs as the migration role: RLS policy evaluation is NOT included in these numbers.',
      'Measures the persistence contract, not the Deepgram socket — no provider call is made.',
      'Heap delta is indicative on a single process; it is a shape check, not a budget.',
    ],
  })
})
