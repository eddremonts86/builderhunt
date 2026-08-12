/**
 * Removes exactly what one load run seeded, and nothing else (plan 55 phase 0).
 *
 * ## Why this is not `truncate`
 *
 * A load database is disposable, so emptying every table looks harmless — and would be, for one operator on
 * one host. It stops being harmless the moment two runs share a disposable host, which is the normal case
 * when a certification is retried while a baseline is still going: `truncate` would take the other run's
 * fixture out from under it, and the failure would surface as unexplained 500s in a report nobody would
 * connect back to a cleanup.
 *
 * Every row `seed.ts` writes carries the run id in its primary key, so every delete here is scoped by that
 * prefix and a second run's rows are invisible to it.
 *
 * ## Why it returns counts instead of logging them
 *
 * The task's verification is that cleanup returns run-scoped counts to zero, which means something has to
 * be able to *check* rather than read. `cleanupLoadFixtures` returns what it deleted and what remains, and
 * the CLI prints that — so the integration check asserts on values and the operator still sees them.
 *
 * Usage:
 *   LOAD_DATABASE_URL=… LOAD_RUN_ID=load-20260811093000-seed pnpm load:cleanup
 */

import postgres from 'postgres'
import { assertDisposableLoadTarget, LoadSafetyError, remoteAllowedFromEnv } from './safety'

/**
 * Child rows before parents.
 *
 * Several of these do cascade from `organizations`, but relying on that would make the delete order a
 * property of the schema rather than of this file — and a future `ON DELETE RESTRICT` would turn a silent
 * dependency into a mystery failure at 02:00. Stated explicitly, it is checkable by reading.
 */
const FIXTURE_TABLES = [
  'sprint_results',
  'sourcing_sprints',
  'alert_triggers',
  'alerts',
  'saved_queries',
  'organization_builders',
  'builder_identities',
  'auth_accounts',
  // Organizations and their members are keyed by a derived id, not by the run prefix — handled below, after
  // this list, because resolving them depends on the membership rows `auth_users` takes with it.
  'auth_users',
] as const

export interface CleanupResult {
  runId: string
  deleted: Record<string, number>
  /** Rows still carrying this run's prefix after the deletes. Every value must be zero. */
  remaining: Record<string, number>
}

/**
 * Rejects a run id that could widen a `LIKE` beyond one run.
 *
 * `%` or `_` in the id would match other runs' rows — `_` matches any single character, which is the one
 * people forget. `loadRunId` cannot produce either, but this function also accepts an id typed by hand into
 * an environment variable at the end of a long night.
 */
export function assertScopedRunId(runId: string | undefined): string {
  if (!runId || !/^load-\d{14}-[a-z0-9-]{1,32}$/.test(runId)) {
    throw new LoadSafetyError(
      'refusing to clean up: LOAD_RUN_ID must look like load-<14 digits>-<suffix> so the delete cannot widen',
    )
  }
  return runId
}

export interface CleanupOptions {
  databaseUrl: string | undefined
  runId: string | undefined
  log?: (message: string) => void
}

export async function cleanupLoadFixtures(options: CleanupOptions): Promise<CleanupResult> {
  const target = assertDisposableLoadTarget(options.databaseUrl, { allowRemote: remoteAllowedFromEnv() })
  const runId = assertScopedRunId(options.runId)
  const log = options.log ?? ((message: string) => console.log(message))
  const prefix = `ld_${runId}_%`

  const sql = postgres(target.url, { max: 2, prepare: false, idle_timeout: 20 })
  const deleted: Record<string, number> = {}
  const remaining: Record<string, number> = {}
  try {
    /**
     * The organization ids, read before anything is deleted.
     *
     * `bootstrap_personal_organization` derives the organization id from the user id, so an organization row
     * carries no run prefix of its own. The first version of this file guessed at a slug pattern —
     * `%ld-<runId>-u%` — and the slug is actually `personal-<opaque hash>`, so it would have matched nothing,
     * deleted no organizations, and still reported a clean run because `remaining` did not check the table it
     * had just failed to touch. Reading the membership rows is not a guess: it is what created them.
     */
    const owned = await sql.unsafe<Array<{ organization_id: string }>>(
      `select distinct organization_id from organization_members where user_id like $1`,
      [prefix],
    )
    const organizationIds = owned.map((row) => row.organization_id)

    for (const table of FIXTURE_TABLES) {
      const rows = await sql.unsafe<Array<{ count: number }>>(
        `with removed as (delete from ${table} where id like $1 returning 1)
         select count(*)::int as count from removed`,
        [prefix],
      )
      deleted[table] = Number(rows[0]?.count ?? 0)
    }

    // Last, and by exact id: the membership rows are gone with their users by now, so nothing else can
    // resolve which organizations this run created.
    const orgs = organizationIds.length === 0
      ? [{ count: 0 }]
      : await sql.unsafe<Array<{ count: number }>>(
          `with removed as (delete from organizations where id = any($1::text[]) returning 1)
           select count(*)::int as count from removed`,
          [organizationIds],
        )
    deleted.organizations = Number(orgs[0]?.count ?? 0)

    for (const table of FIXTURE_TABLES) {
      const rows = await sql.unsafe<Array<{ count: number }>>(
        `select count(*)::int as count from ${table} where id like $1`,
        [prefix],
      )
      remaining[table] = Number(rows[0]?.count ?? 0)
    }
    // Counted the same way it was deleted, so a failure to remove an organization cannot read as zero.
    const orgsLeft = organizationIds.length === 0
      ? [{ count: 0 }]
      : await sql.unsafe<Array<{ count: number }>>(
          `select count(*)::int as count from organizations where id = any($1::text[])`,
          [organizationIds],
        )
    remaining.organizations = Number(orgsLeft[0]?.count ?? 0)

    for (const [table, count] of Object.entries(deleted)) log(`  deleted ${count} from ${table}`)
    const stuck = Object.entries(remaining).filter(([, count]) => count > 0)
    if (stuck.length > 0) {
      log(`  ⚠️  rows still carrying ${runId}: ${stuck.map(([t, c]) => `${t}=${c}`).join(', ')}`)
    }
    return { runId, deleted, remaining }
  } finally {
    await sql.end({ timeout: 10 }).catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  cleanupLoadFixtures({ databaseUrl: process.env.LOAD_DATABASE_URL, runId: process.env.LOAD_RUN_ID })
    .then((result) => {
      const stuck = Object.values(result.remaining).some((count) => count > 0)
      process.exit(stuck ? 1 : 0)
    })
    .catch((error: unknown) => {
      console.error(`load cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`)
      process.exit(1)
    })
}
