#!/usr/bin/env node
/**
 * Print `count(*)` per public BASE TABLE, sorted.
 *
 * The 16 → 18 cutover is verified by diffing a `pg_dump` against the live
 * source and a restored scratch target. `scripts/db/restore.ts`'s
 * `printRowCounts` is not a substitute: it hardcodes four tables. This
 * script enumerates every BASE TABLE in `public` and emits one line per
 * table, `table<TAB>count`, so a `diff` of two runs is the row-parity check.
 *
 * No writes, no env magic — the URL is positional so a `diff <(node
 * scripts/db/pg18/row-counts.mjs "$SOURCE") <(node scripts/db/pg18/row-counts.mjs "$TARGET")`
 * is the entire verification.
 */
import postgres from 'postgres'

const url = process.argv[2]
if (!url) {
  console.error('usage: node scripts/db/pg18/row-counts.mjs <postgres-url>')
  process.exit(2)
}

const sql = postgres(url, { max: 1, prepare: false })
try {
  const tables = await sql`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_type = 'BASE TABLE'
    order by table_name
  `
  for (const { table_name } of tables) {
    // Quote the identifier — the public schema has a couple of
    // underscore-and-numeric names that would otherwise need doubling, and
    // `sql(table_name)` is an injection path we don't want to leave open.
    const rows = await sql.unsafe(
      `select count(*)::bigint as row_count from "${table_name.replace(/"/g, '""')}"`,
    )
    process.stdout.write(`${table_name}\t${rows[0].row_count}\n`)
  }
} finally {
  await sql.end({ timeout: 5 })
}
