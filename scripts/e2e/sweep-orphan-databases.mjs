#!/usr/bin/env node
/**
 * Drops E2E worker databases that no run owns any more.
 *
 * `tests/e2e/harness/database.ts`'s `dropWorkerDatabase` runs in each spec's `afterAll` and works when a run
 * finishes. A run that is *killed* — Ctrl-C, a `TaskStop`, a crashed worker — never reaches it, and nothing
 * else ever sweeps: `playwright.config.ts` has no `globalSetup` or `globalTeardown`. 28 orphans had
 * accumulated by 2026-08-04, about 450 MB, alongside a separate role leak in `scripts/ci/local-quality.sh`
 * that this one is the database-side twin of.
 *
 * ## Why this is a script and not a Playwright global hook
 *
 * A hook would run inside `pnpm ci:local`'s e2e step, which is the gate everything ships behind. A bug in a
 * cleanup hook there fails the gate for a reason unrelated to the product, and 450 MB of reclaimable disk is
 * not worth putting a new failure mode on that path. Maintenance belongs in a command someone runs.
 *
 * ## What makes a database an orphan, and the one case this deliberately will not touch
 *
 * Zero active backends in `pg_stat_activity`. A live run always holds connections to its worker databases —
 * the harness pool stays open until `record.dispose()`, and the dev server has its own — so a worker database
 * with no connections belongs to nobody.
 *
 * The residual gap, stated rather than papered over: a concurrent run that has just issued `CREATE DATABASE`
 * but not yet connected would look like an orphan for a fraction of a second. The consequence is that run
 * failing loudly on a missing database, not silent corruption, and this is not something to run while a suite
 * is going. Named `sweep` rather than wired into anything for exactly that reason.
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'

const PREFIX = 'builderhunt_security_test_e2e_'

function adminUrl() {
  const fromEnv = process.env.DATABASE_MIGRATION_URL
  if (fromEnv) return fromEnv
  const line = readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith('DATABASE_MIGRATION_URL='))
  if (line) return line.slice('DATABASE_MIGRATION_URL='.length).trim()
  throw new Error('no DATABASE_MIGRATION_URL in the environment or .env — this needs the owner connection')
}

const dryRun = process.argv.includes('--dry-run')
const sql = postgres(adminUrl().replace(/\/[^/]+$/, '/postgres'), { max: 1, onnotice: () => {} })

try {
  const candidates = await sql`
    select d.datname,
           pg_database_size(d.datname) as bytes,
           (select count(*)::int from pg_stat_activity a where a.datname = d.datname) as connections
    from pg_database d
    where d.datname like ${PREFIX + '%'}
    order by d.datname
  `

  const orphans = candidates.filter((c) => c.connections === 0)
  const busy = candidates.filter((c) => c.connections > 0)
  const reclaimable = orphans.reduce((sum, o) => sum + Number(o.bytes), 0)

  console.log(`${candidates.length} e2e worker databases: ${orphans.length} orphaned, ${busy.length} in use`)
  if (busy.length) console.log(`  in use, left alone: ${busy.map((b) => b.datname).join(', ')}`)
  console.log(`  reclaimable: ${(reclaimable / 1024 / 1024).toFixed(0)} MB`)

  if (dryRun) {
    console.log('--dry-run: nothing dropped')
  } else {
    let dropped = 0
    for (const orphan of orphans) {
      try {
        await sql.unsafe(`drop database if exists "${orphan.datname}" with (force)`)
        dropped++
      } catch (error) {
        console.error(`  could not drop ${orphan.datname}: ${error.code} ${error.message}`)
      }
    }
    console.log(`dropped ${dropped} of ${orphans.length}`)
  }
} finally {
  await sql.end({ timeout: 5 })
}
