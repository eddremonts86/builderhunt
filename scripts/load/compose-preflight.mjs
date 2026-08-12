// Proves the pooler is actually usable before a load run starts (plan 55 phase 4).
//
// ## Why a preflight and not "the run will tell us"
//
// A load run against a misconfigured pooler does not fail — it *succeeds* with numbers that mean something
// else. Session mode instead of transaction mode caps concurrency at the pool size and produces a latency
// curve that looks like a slow database. One role missing from `userlist.txt` shifts its share of the mix
// into errors that read as capacity loss. A migration URL pointed at 6432 makes DDL run through a
// transaction-mode pooler, which is how a migration half-applies.
//
// None of those announce themselves in a report. Each is a five-second check here.
//
// Usage:
//   node scripts/load/compose-preflight.mjs
//
// Exits 0 when every check passes, 1 otherwise, and prints one line per check either way — a preflight that
// only spoke up on failure would leave an operator guessing whether it ran.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import postgres from 'postgres'

const run = promisify(execFile)

/** The five application roles, each of which must be able to reach the database through the pooler. */
const ROLES = [
  { role: 'builderhunt_app', env: 'BUILDERHUNT_APP_PASSWORD' },
  { role: 'builderhunt_auth', env: 'BUILDERHUNT_AUTH_PASSWORD' },
  { role: 'builderhunt_worker', env: 'BUILDERHUNT_WORKER_PASSWORD' },
  { role: 'builderhunt_platform', env: 'BUILDERHUNT_PLATFORM_PASSWORD' },
  { role: 'builderhunt_capability', env: 'BUILDERHUNT_CAPABILITY_PASSWORD' },
]

/** The caps `pgbouncer.ini` sets, and the report asserts against. */
const EXPECTED = {
  pool_mode: 'transaction',
  default_pool_size: '12',
  reserve_pool_size: '4',
  max_db_connections: '80',
  max_client_conn: '500',
}

const POOLER_PORT = 6432
const DIRECT_PORT = 5432

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Never prints a URL: it carries a password. */
function poolerUrl(role, password, database) {
  return `postgresql://${role}:${encodeURIComponent(password)}@127.0.0.1:${POOLER_PORT}/${database}`
}

const database = process.env.LOAD_DATABASE_NAME ?? 'builderhunt_load_test_preflight'

// ── 1. Every role can reach the database through 6432 ────────────────────────────────────────────
//
// `SELECT 1` and nothing more. The point is authentication and routing, and a heavier query would make a
// slow database look like a broken pooler.
for (const { role, env } of ROLES) {
  const password = process.env[env]
  if (!password) {
    record(`${role} via ${POOLER_PORT}`, false, `${env} is unset`)
    continue
  }
  let sql
  try {
    sql = postgres(poolerUrl(role, password, database), { max: 1, prepare: false, idle_timeout: 2, connect_timeout: 5 })
    const [row] = await sql`select 1 as ok`
    record(`${role} via ${POOLER_PORT}`, row?.ok === 1)
  } catch (error) {
    // The message, not the error object: postgres.js attaches the connection options, password included.
    record(`${role} via ${POOLER_PORT}`, false, error instanceof Error ? error.message : 'unknown error')
  } finally {
    await sql?.end({ timeout: 2 }).catch(() => undefined)
  }
}

// ── 2. PgBouncer reports the mode and the caps the report will claim ─────────────────────────────
//
// Read from `SHOW CONFIG` through the admin console rather than from the ini file. What matters is what the
// running process believes, and an ini file that was never reloaded says whatever it liked.
{
  const adminPassword = process.env.PGBOUNCER_ADMIN_PASSWORD
  if (!adminPassword) {
    record('pgbouncer SHOW CONFIG', false, 'PGBOUNCER_ADMIN_PASSWORD is unset')
  } else {
    let sql
    try {
      sql = postgres(poolerUrl('pgbouncer', adminPassword, 'pgbouncer'), {
        max: 1,
        prepare: false,
        idle_timeout: 2,
        connect_timeout: 5,
        // The admin console is not PostgreSQL and does not speak the extended protocol.
        fetch_types: false,
      })
      const rows = await sql.unsafe('SHOW CONFIG')
      const actual = new Map(rows.map((r) => [String(r.key), String(r.value)]))
      for (const [key, expected] of Object.entries(EXPECTED)) {
        const value = actual.get(key)
        record(`pgbouncer ${key}`, value === expected, `expected ${expected}, got ${value ?? 'absent'}`)
      }
    } catch (error) {
      record('pgbouncer SHOW CONFIG', false, error instanceof Error ? error.message : 'unknown error')
    } finally {
      await sql?.end({ timeout: 2 }).catch(() => undefined)
    }
  }
}

// ── 3. The migration URL must not go through the pooler ──────────────────────────────────────────
//
// The check that prevents the worst outcome here. DDL through a transaction-mode pooler can land on
// different server connections between statements, and a migration that half-applies is not a load-test
// problem — it is a database somebody has to repair by hand.
{
  const migrationUrl = process.env.DATABASE_MIGRATION_URL
  if (!migrationUrl) {
    record('migration URL uses the direct port', false, 'DATABASE_MIGRATION_URL is unset')
  } else {
    // An IIFE rather than a `let` with two assignments: both branches wrote to it, so the initial value
    // was never read and `no-useless-assignment` said so. Returning from the parse is also the shape that
    // cannot leave `port` in a third state somebody adds later.
    const port = (() => {
      try {
        return new URL(migrationUrl).port || '5432'
      } catch {
        return null
      }
    })()
    record(
      'migration URL uses the direct port',
      port === String(DIRECT_PORT),
      port === null ? 'could not be parsed' : `port ${port}`,
    )
  }
}

// ── 4. PostgreSQL is configured for the budget behind the pooler ─────────────────────────────────
{
  const adminUrl = process.env.DATABASE_MIGRATION_URL
  if (adminUrl) {
    let sql
    try {
      sql = postgres(adminUrl, { max: 1, prepare: false, idle_timeout: 2, connect_timeout: 5 })
      const [row] = await sql`show max_connections`
      const value = Number(row?.max_connections ?? 0)
      // ≥ 120 rather than exactly 120: a developer machine runs 200 for unrelated reasons, and failing that
      // would make this preflight refuse a perfectly good local setup.
      record('postgres max_connections ≥ 120', value >= 120, `${value}`)
    } catch (error) {
      record('postgres max_connections ≥ 120', false, error instanceof Error ? error.message : 'unknown error')
    } finally {
      await sql?.end({ timeout: 2 }).catch(() => undefined)
    }
  }
}

// ── 5. The container is healthy, if compose is what started it ───────────────────────────────────
try {
  const { stdout } = await run('docker', ['inspect', '-f', '{{.State.Health.Status}}', 'builderhunt-pgbouncer'])
  record('pgbouncer container health', stdout.trim() === 'healthy', stdout.trim())
} catch {
  // Not a failure: a remote certification host runs the pooler as a service, not as a local container.
  console.log('skip  pgbouncer container health — no local container (fine on a remote host)')
}

const failed = results.filter((r) => !r.pass)
console.log('')
console.log(`${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  // Every failure named, not just the first: a preflight that stopped at one would send an operator round
  // this loop four times.
  console.error(`\npreflight failed:\n${failed.map((f) => `  - ${f.name}: ${f.detail ?? 'failed'}`).join('\n')}\n`)
  process.exit(1)
}
process.exit(0)
