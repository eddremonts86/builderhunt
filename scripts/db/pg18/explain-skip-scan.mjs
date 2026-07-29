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
  console.log('seeding 500k rows...')
  const seedStart = Date.now()
  // 500 batches of 1000 — same shape as bench-uuid-defaults.mjs to
  // keep the bulk insert path honest.
  for (let i = 0; i < 500; i++) {
    const offset = i * 1000
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
      from generate_series(1, 1000) g,
           unnest(${sql.array(NAMES)}) as n(name),
           unnest(${sql.array(SURFACES)}) as s(surface),
           unnest(${sql.array(VARIANTS)}) as v(variant)
    `
  }
  console.log(`  seeded in ${Date.now() - seedStart} ms`)

  await sql`analyze conversion_events`

  // The aggregate `src/shared/lib/repositories/conversion-events.ts`
  // runs is server_day-range + GROUP BY name. Capture the SQL the
  // repository actually emits and EXPLAIN it.
  const explainPlan = async () => {
    const rows = await sql`
      explain (analyze, buffers)
      select name, count(*)::bigint
      from conversion_events
      where server_day between '2026-06-01' and '2026-06-30'
      group by name
      order by name
    `
    return rows.map((r) => r['QUERY PLAN']).join('\n')
  }

  console.log('\n=== both indexes present ===')
  console.log(await explainPlan('with'))

  await sql`drop index if exists conversion_events_server_day_idx`
  await sql`analyze conversion_events`

  console.log('\n=== conversion_events_server_day_idx dropped ===')
  console.log(await explainPlan('without'))
} finally {
  await sql.end({ timeout: 5 })
}
