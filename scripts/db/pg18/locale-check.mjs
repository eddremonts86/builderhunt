#!/usr/bin/env node
/**
 * Print collation/locale-relevant fields of a Postgres database.
 *
 * The 16 → 18 cutover provisions the new cluster fresh (`initdb` inside the
 * image defaults), not `pg_upgrade`'d in place — nothing structurally
 * guarantees the new cluster matches the old one's locale. A mismatch
 * silently changes text `ORDER BY` order and unique-index equality
 * semantics (the text-typed unique indexes on
 * `builder_identities_source_source_id_unique` and
 * `conversion_events_identity_unique` are the load-bearing ones).
 *
 * The output is plain TSV, one `key<TAB>value` per line, so a `diff` of two
 * runs is the verification: identical → safe, different → stop.
 *
 * Note: PG18 renamed `pg_database.daticulocale` to `datlocale` (release
 * notes, "Rename `daticulocale` column of `pg_database` to `datlocale`"),
 * so the script reads the column that exists on each server rather than
 * hard-coding a name. `SHOW lc_collate` is not a GUC on either major —
 * `lc_collate` is a cluster-initdb setting, not a session parameter — so
 * the field comes from `pg_database.datcollate` and the SHOW is dropped.
 */
import postgres from 'postgres'

const url = process.argv[2]
if (!url) {
  console.error('usage: node scripts/db/pg18/locale-check.mjs <postgres-url>')
  process.exit(2)
}

const sql = postgres(url, { max: 1, prepare: false })
try {
  const dbRows = await sql`
    select
      datcollate,
      datctype,
      datlocprovider,
      datcollversion
    from pg_database
    where datname = current_database()
  `
  const db = dbRows[0]

  // `daticulocale` (≤16) was renamed to `datlocale` (≥18). Read whichever
  // exists; the diff will fail loudly if one is empty and the other isn't.
  let localeCol = null
  try {
    const r = await sql`select datlocale as v from pg_database where datname = current_database()`
    if (r.length) localeCol = r[0].v
  } catch {
    try {
      const r = await sql`select daticulocale as v from pg_database where datname = current_database()`
      if (r.length) localeCol = r[0].v
    } catch {
      // neither column exists — print empty rather than crash
    }
  }

  const encRows = await sql`show server_encoding`

  // Deliberately not the `datname`: a source/target diff is supposed to be
  // about locale, not the database's name.
  for (const [key, value] of [
    ['datcollate', db.datcollate],
    ['datctype', db.datctype],
    ['datlocprovider', db.datlocprovider],
    ['datlocale_or_daticulocale', localeCol ?? ''],
    ['datcollversion', db.datcollversion ?? ''],
    ['server_encoding', encRows[0].server_encoding],
  ]) {
    process.stdout.write(`${key}\t${value ?? ''}\n`)
  }
} finally {
  await sql.end({ timeout: 5 })
}
