#!/usr/bin/env node
/**
 * Insert-locality benchmark: uuidv4 vs uuidv7 on a PK B-tree.
 *
 * Inserts 200k rows into two clones of a parent table — one with
 * `gen_random_uuid()`, one with `uuidv7()` — and reports the index
 * size plus the wall time. The setup lives entirely inside a
 * `builderhunt_security_test_*` disposable database; nothing here
 * touches production state.
 *
 * The shape is `EXPLAIN`-ready: 200k rows is enough to surface the
 * back-of-the-index rewrite cost that motivates uuidv7 on
 * append-heavy tables.
 */
import postgres from 'postgres'

const url = process.argv[2]
if (!url) {
  console.error('usage: node scripts/db/pg18/bench-uuid-defaults.mjs <postgres-url>')
  process.exit(2)
}

const sql = postgres(url, { max: 4, prepare: false })
const N = 200_000
try {
  await sql`create extension if not exists pgcrypto`

  for (const variant of ['v4', 'v7']) {
    const defaultExpr = variant === 'v4' ? sql`gen_random_uuid()` : sql`uuidv7()`
    const tbl = `bench_${variant}`

    await sql.unsafe(`drop table if exists "${tbl}"`)
    await sql.unsafe(
      `create table "${tbl}" (id uuid primary key default ${variant === 'v4' ? 'gen_random_uuid()' : 'uuidv7()'}, n integer not null)`,
    )

    const start = Date.now()
    for (let i = 0; i < N; i += 1000) {
      await sql.unsafe(
        `insert into "${tbl}" (n) select generate_series(1, 1000)`,
      )
    }
    const wallMs = Date.now() - start

    const [{ size }] = await sql.unsafe(
      `select pg_relation_size('${tbl}_pkey') as size`,
    )
    console.log(
      `${variant}\t${N} inserts in ${wallMs} ms\tindex size ${size} bytes (${(size / 1024 / 1024).toFixed(2)} MiB)`,
    )
    // silence the unused-var lint without affecting the run
    void defaultExpr
  }
} finally {
  await sql.end({ timeout: 5 })
}
