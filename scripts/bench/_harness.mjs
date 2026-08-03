/**
 * Shared plumbing for the three interview benchmarks (plan:
 * calendar-scheduling-interview-intelligence, Phase 12 "Run performance and concurrency
 * verification").
 *
 * ## Why these measure the database and not HTTP
 *
 * The spec's targets — calendar feed under 500 ms p95, slots under 750 ms p95, zero double booking,
 * acknowledged segment persistence above 99.9% — are about query and lock behaviour. Driving them
 * through a Vite dev server would measure Vite: an unbundled dev build spends more time in module
 * resolution than in Postgres, so a regression in the query would be invisible under the noise and a
 * Vite upgrade would look like a performance change. These connect directly, seed realistic volume,
 * and report the query counts alongside the latencies so a change in *shape* is visible even when
 * the wall clock is not.
 *
 * ## Every run is disposable
 *
 * A benchmark that seeds 90 days of recurring events into a shared database leaves it slower for
 * everything afterwards, and the numbers depend on whatever was already there. Each bench creates
 * its own database and drops it, so two runs are comparable and neither pollutes anything.
 *
 * ## p95 over a fixed iteration count, warm-up excluded
 *
 * The first query of a session pays for plan caching and connection setup; including it makes a
 * fast query look slow and hides a real regression behind the variance. Warm-up runs are executed
 * and discarded, which is stated in the output rather than left implicit.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'

/** Percentile from an unsorted sample, nearest-rank. */
export function percentile(samples, p) {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))]
}

export function summarise(label, samples, targetMs) {
  const p50 = percentile(samples, 50)
  const p95 = percentile(samples, 95)
  const p99 = percentile(samples, 99)
  const max = samples.length > 0 ? Math.max(...samples) : 0
  return {
    label,
    iterations: samples.length,
    p50Ms: Number(p50.toFixed(1)),
    p95Ms: Number(p95.toFixed(1)),
    p99Ms: Number(p99.toFixed(1)),
    maxMs: Number(max.toFixed(1)),
    ...(targetMs === undefined ? {} : { targetMs, withinTarget: p95 <= targetMs }),
  }
}

export async function timeIt(fn) {
  const started = process.hrtime.bigint()
  const value = await fn()
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  return { value, elapsedMs }
}

/**
 * Counts the statements a block issues, so a "faster" query that fires one per row is caught.
 *
 * Uses `pg_stat_statements` when the extension is present and falls back to counting through the
 * client's own debug hook otherwise — reported either way, because a silent absence would let the
 * N+1 assertion pass by never running.
 */
export function statementCounter() {
  let count = 0
  return {
    onQuery: () => { count += 1 },
    reset: () => { count = 0 },
    get value() { return count },
  }
}

/**
 * A disposable database with migrations applied, connected as the migration role.
 *
 * The migration role, not the app role: a benchmark measures query cost, and running under RLS
 * would fold policy evaluation into every number without any of the benches being about policies.
 * That is a deliberate limitation and it is printed with the results.
 */
/**
 * `DATABASE_MIGRATION_URL` from the environment, falling back to `.env`.
 *
 * Without the fallback, `pnpm bench:interviews` fails immediately on a normal checkout: these are plain `node`
 * scripts, so nothing loads `.env` for them the way dotenvx does for vite/vitest/playwright, and the plan
 * documents the command as runnable. A benchmark whose numbers require an undocumented `export` first is a
 * benchmark nobody re-runs, which defeats the point of having a baseline.
 *
 * Read with a line match rather than a dotenv dependency, exactly as `scripts/ci/local-quality.sh` does for the
 * same variable — one convention for one file.
 */
function resolveAdminUrl() {
  if (process.env.DATABASE_MIGRATION_URL) return process.env.DATABASE_MIGRATION_URL
  try {
    const envFile = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    const match = /^DATABASE_MIGRATION_URL=(.*)$/m.exec(envFile)
    return match?.[1]?.trim() || undefined
  } catch {
    return undefined
  }
}

export async function withBenchDatabase(label, fn) {
  const adminUrl = resolveAdminUrl()
  if (!adminUrl) {
    throw new Error('DATABASE_MIGRATION_URL is required — set it in the environment or in .env')
  }

  const databaseName = `builderhunt_bench_${label}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const admin = postgres(adminUrl, { max: 1, prepare: false })
  const counter = statementCounter()

  let sql
  try {
    await admin.unsafe(`CREATE DATABASE ${databaseName}`)
    const url = new URL(adminUrl)
    url.pathname = `/${databaseName}`
    /**
     * The migrator gets its own connection, and that is not tidiness — it is the fix for a real failure.
     *
     * Running drizzle's `migrate()` through the same postgres.js client leaves that client unable to serialize
     * `Date` parameters: every later `${someDate}` arrives at `Buffer.byteLength` as a Date object and throws
     * `ERR_INVALID_ARG_TYPE`. Reproduced in isolation — the identical insert succeeds on a fresh client and
     * fails on a migrated one — which is why all three benchmarks had never actually run to completion.
     *
     * Not worked around by stringifying 22 call sites: that would have left the trap armed for the next
     * benchmark someone adds. `prepare` is left at its default too; flipping it changes nothing here, which
     * was checked before settling on this.
     */
    const migrator = postgres(url.toString(), { max: 1, onnotice: () => {} })
    try {
      // Reuses the app's own migrator so the schema and indexes under test are the deployed ones.
      const { drizzle } = await import('drizzle-orm/postgres-js')
      const { migrate } = await import('drizzle-orm/postgres-js/migrator')
      await migrate(drizzle(migrator), { migrationsFolder: './drizzle' })
    } finally {
      await migrator.end({ timeout: 10 }).catch(() => {})
    }

    sql = postgres(url.toString(), {
      max: 8,
      onnotice: () => {},
      debug: () => counter.onQuery(),
    })

    return await fn({ sql, counter, databaseName })
  } finally {
    await sql?.end({ timeout: 10 }).catch(() => {})
    await admin`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = ${databaseName} and pid <> pg_backend_pid()
    `.catch(() => {})
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`).catch(() => {})
    await admin.end({ timeout: 10 }).catch(() => {})
  }
}

/** One organization, one verified user, one default calendar. */
export async function seedTenant(sql, { organizationId, userId }) {
  await sql`insert into organizations (id, name, slug) values (${organizationId}, 'Bench', ${organizationId})`
  await sql`
    insert into auth_users (id, name, email, email_verified, created_at, updated_at)
    values (${userId}, 'Bench', ${`${userId}@bench.invalid`}, true, now(), now())
  `
  await sql`
    insert into organization_members (id, organization_id, user_id, role, created_at)
    values (${`member-${userId}`}, ${organizationId}, ${userId}, 'owner', now())
  `
  const [calendar] = await sql`
    insert into user_calendars (id, organization_id, owner_user_id, name, timezone, is_default)
    values (gen_random_uuid(), ${organizationId}, ${userId}, 'Bench', 'Europe/Copenhagen', true)
    returning id
  `
  return calendar.id
}

/** Pins the tenant settings the app pins, so a bench that touches an RLS-scoped read behaves. */
export async function pin(transaction, { organizationId, userId }) {
  await transaction`select
    set_config('app.organization_id', ${organizationId}, true),
    set_config('app.user_id', ${userId}, true),
    set_config('app.capability_owner_user_id', ${userId}, true)`
}

export function report(name, payload) {
  // One JSON line, so a runbook can paste the output and a future run can be diffed against it.
  console.log(JSON.stringify({ bench: name, ...payload }))
}
