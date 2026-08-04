#!/usr/bin/env node
/**
 * Does the per-(server_day) index on `conversion_events` earn its place?
 *
 * The table has two related indexes:
 *   - `conversion_events_server_day_idx`           on (server_day)
 *   - `conversion_events_name_server_day_idx`     on (name, server_day)
 *
 * A skip scan on the second one answers the same `WHERE server_day
 * BETWEEN $1 AND $2` aggregate the first one was built for — the
 * question this script is built to answer is whether the first
 * index is still load-bearing or if a PG18 skip scan replaces it.
 *
 * Seeds 500k realistic rows, ANALYZEs, then EXPLAINs the same
 * aggregate the production repository runs (`server_day`-range
 * GROUP BY name) with both indexes present, and again with
 * `conversion_events_server_day_idx` dropped. Prints both plans
 * and timings; the conclusion lives in the spec, not in this
 * script.
 *
 * ## Corrected 2026-08-04 — it seeded 28 million rows, not 500k
 *
 * The loop below said "500 batches of 1000" and meant it about the
 * `generate_series(1, 1000)`, forgetting that the series sits inside three
 * CROSS JOINs: 7 names × 4 surfaces × 2 variants = 56 rows per series value.
 * So each batch inserted 56,000 rows and 500 batches produced **28,000,000**
 * — 56× the intended volume. Found by noticing that
 * `builderhunt_security_test_local_pg18_skip` had grown to **9.5 GB**, 94% of
 * all local test-database storage, holding exactly 28,000,376 rows.
 *
 * Two consequences, and the second is the one that matters:
 *
 * 1. It left 9.5 GB on disk after every run, since nothing truncates at the
 *    end (the `truncate` is at the *start*, so the data survives until the
 *    next run).
 * 2. **Any conclusion drawn from a previous run is void.** Plan choice is
 *    volume-dependent — that is the entire reason the spec named a row count.
 *    A skip scan that wins at 28M rows may lose at 500k and vice versa, so
 *    "does this index earn its place" was answered against data 56× too big.
 *    Re-run before trusting the answer.
 *
 * The batch count is now derived from the actual fan-out rather than assumed,
 * and the script prints what it seeded so the number can never silently drift
 * from the number in the comment again.
 */
import postgres from 'postgres'

const url = process.argv[2]
if (!url) {
  console.error('usage: node scripts/db/pg18/explain-skip-scan.mjs <postgres-url>')
  process.exit(2)
}

const NAMES = [
  'landing_view',
  'hero_signup_click',
  'hero_explore_click',
  'explore_search_complete',
  'explore_signup_click',
  'signup_submit',
  'signup_complete',
]
const SURFACES = ['hero', 'final_cta', 'explore', 'signup']
const VARIANTS = ['baseline', 'treatment']

const sql = postgres(url, { max: 4, prepare: false })
try {
  // Empty table; the task spec seeds 500k.
  await sql`truncate table conversion_events`

  // Each series value fans out across all three unnested arrays, so one row of
  // `generate_series` becomes NAMES × SURFACES × VARIANTS rows. Deriving the
  // series length from that product is what keeps the total honest — the
  // previous hardcoded "1000 per batch × 500 batches" ignored the fan-out and
  // produced 28 million rows against a 500k target.
  const TARGET_ROWS = 500_000
  const ROWS_PER_SERIES_VALUE = NAMES.length * SURFACES.length * VARIANTS.length
  const BATCHES = 50
  const SERIES_PER_BATCH = Math.max(1, Math.round(TARGET_ROWS / ROWS_PER_SERIES_VALUE / BATCHES))
  const plannedRows = SERIES_PER_BATCH * ROWS_PER_SERIES_VALUE * BATCHES

  console.log(`seeding ~${plannedRows.toLocaleString('en-US')} rows `
    + `(${BATCHES} batches × ${SERIES_PER_BATCH} series values × ${ROWS_PER_SERIES_VALUE} fan-out)...`)
  const seedStart = Date.now()
  for (let i = 0; i < BATCHES; i++) {
    const offset = i * SERIES_PER_BATCH
    await sql`
      insert into conversion_events (id, name, surface, session_id, variant, occurred_at, server_day)
      select
        gen_random_uuid()::text,
        n.name,
        s.surface,
        ('sess-' || (${offset} + g)::text),
        v.variant,
        now() - (random() * interval '30 days'),
        to_char(now() - (random() * interval '30 days'), 'YYYY-MM-DD')
      from generate_series(1, ${SERIES_PER_BATCH}) g,
           unnest(${sql.array(NAMES)}) as n(name),
           unnest(${sql.array(SURFACES)}) as s(surface),
           unnest(${sql.array(VARIANTS)}) as v(variant)
    `
  }
  // Printed from the table, not from the arithmetic above, so the number in the
  // output is the number that is actually there.
  const [{ seeded }] = await sql`select count(*)::bigint as seeded from conversion_events`
  console.log(`  seeded ${Number(seeded).toLocaleString('en-US')} rows in ${Date.now() - seedStart} ms`)

  await sql`analyze conversion_events`

  /**
   * The window is derived from the data, and that is a fix rather than a
   * refinement.
   *
   * This filtered `server_day between '2026-06-01' and '2026-06-30'` while the
   * seed writes `now() - random() * interval '30 days'`. Run in August, the
   * seeded days are July–August and June matches **nothing** — every plan
   * printed `rows=0.00` and both arms finished in 0.06 ms on an empty result.
   * The comparison the script exists to make was being made over zero rows.
   *
   * Taking the middle two thirds of whatever was actually seeded keeps it a
   * real range scan on any day the script is run.
   */
  const [{ lo, hi }] = await sql`
    select
      to_char(min(occurred_at) + (max(occurred_at) - min(occurred_at)) * 0.40, 'YYYY-MM-DD') as lo,
      to_char(min(occurred_at) + (max(occurred_at) - min(occurred_at)) * 0.50, 'YYYY-MM-DD') as hi
    from conversion_events
  `
  const [{ in_window: inWindow }] = await sql`
    select count(*)::bigint as in_window from conversion_events where server_day between ${lo} and ${hi}
  `
  console.log(`  window ${lo}..${hi} covers ${Number(inWindow).toLocaleString('en-US')} rows`)
  if (Number(inWindow) === 0) throw new Error('derived window matched no rows — the comparison would be meaningless')

  /**
   * The query is the one the repository issues. It was not, and that is the
   * deepest of this script's problems.
   *
   * The header claimed "the aggregate `conversion-events.ts` runs is
   * server_day-range + GROUP BY name", and the EXPLAIN below was written to
   * match that. `countConversionSessions` does something different:
   *
   *   where name = $1 and variant = $2 and server_day between $3 and $4
   *   select count(distinct session_id), count(*)
   *
   * No `GROUP BY name`, and **two equality predicates the benchmark omitted**.
   * That omission is not cosmetic — it is the whole question. With `name = $1`
   * pinned, `conversion_events_name_server_day_idx` on (name, server_day) is an
   * exact prefix match and no skip scan is needed at all. By dropping the
   * predicate, the script forced the one scenario production never runs, so its
   * answer about whether the (server_day) index earns its place could not have
   * applied either way.
   *
   * A tenth of the seeded range, not two thirds: at 73% selectivity the planner
   * seq-scans regardless and every arm ties, which is how the previous window
   * managed to look like a result.
   */
  const explainPlan = async () => {
    const rows = await sql`
      explain (analyze, buffers)
      select count(distinct session_id)::bigint as sessions, count(*)::bigint as events
      from conversion_events
      where name = ${NAMES[0]}
        and variant = ${VARIANTS[0]}
        and server_day >= ${lo}
        and server_day <= ${hi}
    `
    return rows.map((r) => r['QUERY PLAN']).join('\n')
  }

  /**
   * Recreated first, because this script drops it and never puts it back.
   *
   * The second and every later run therefore compared "dropped" against
   * "dropped" — the first EXPLAIN emitted `index ... does not exist, skipping`
   * and both arms were the same plan. A benchmark that silently measures one
   * arm twice is worse than no benchmark.
   */
  await sql`create index if not exists conversion_events_server_day_idx on conversion_events (server_day)`
  await sql`analyze conversion_events`

  console.log('\n=== both indexes present ===')
  console.log(await explainPlan('with'))

  await sql`drop index if exists conversion_events_server_day_idx`
  await sql`analyze conversion_events`

  console.log('\n=== conversion_events_server_day_idx dropped ===')
  console.log(await explainPlan('without'))

  // Put it back, so the next run starts from the same state this one did.
  await sql`create index if not exists conversion_events_server_day_idx on conversion_events (server_day)`
} finally {
  await sql.end({ timeout: 5 })
}
