import { randomUUID } from 'node:crypto'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

/**
 * Shared setup for tests that need a real, disposable Postgres database —
 * see `repositories/billing.test.ts` and `billing/seller-profile.test.ts` for
 * why this precedent exists (financial-data correctness is worth proving
 * against a real database) and why it's safe unconditionally
 * (`DATABASE_MIGRATION_URL` is already a hard app-wide requirement, and this
 * repo's CI already runs a live Postgres service for the whole test/build
 * sequence).
 *
 * Several early migrations run cluster-wide `ALTER ROLE` statements
 * (Postgres roles are not per-database), so two disposable-database test
 * files migrating at the same time — vitest runs test files in parallel by
 * default, and this repo now has several billing test files doing this —
 * can race on the same role catalog rows ("tuple concurrently updated").
 * Retrying with backoff alone (an earlier version of this file) got flakier
 * as more billing test files were added and more of them ran in parallel;
 * a Postgres session-level advisory lock fully serializes the
 * migration step across every concurrent caller instead of hoping a retry
 * wins the race, and scales to any number of parallel test files. The retry
 * loop is kept as a defense-in-depth backstop, not the primary mechanism.
 */
const MIGRATION_ADVISORY_LOCK_KEY = 918_273_645_102_938

export async function createDisposableTestDatabase(namePrefix: string) {
  const adminUrl = new URL(process.env.DATABASE_MIGRATION_URL ?? 'postgresql://postgres:***@localhost:5432/builderhunt')
  const databaseName = `builderhunt_security_test_${namePrefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const databaseUrl = new URL(adminUrl.toString())
  databaseUrl.pathname = `/${databaseName}`

  const admin = postgres(adminUrl.toString(), { max: 1, prepare: false })
  await admin.unsafe(`CREATE DATABASE ${databaseName}`)

  // max: 5 (not 1) — some tests legitimately need a second connection borrowed from this same pool
  // while a `db.transaction(...)` callback is still in flight on another (e.g. `billing/checkout.ts`
  // reading the platform-scoped seller profile via its own injected `db` mid-transaction). With
  // max: 1, that inner borrow would deadlock forever waiting for the connection the outer
  // transaction is still holding.
  const client = postgres(databaseUrl.toString(), { max: 5, prepare: false })
  const db = drizzle(client)

  await admin`select pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`
  try {
    await migrateWithRetry(db)
  } finally {
    await admin`select pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`
  }

  return {
    db,
    databaseName,
    databaseUrl: databaseUrl.toString(),
    async drop(): Promise<void> {
      await client.end({ timeout: 5 })
      await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`)
      await admin.end({ timeout: 5 })
    },
  }
}

/**
 * Wave 1 Task 1 — E2E per-worker disposable database.
 *
 * Same shape as `createDisposableTestDatabase`, but pinned to the E2E
 * name prefix (`builderhunt_security_test_e2e_*`) so the harness can
 * reliably distinguish worker databases from vitest disposable databases
 * during cleanup, and the worker is identified by its `workerIndex`
 * (Playwright's `TEST_PARALLEL_INDEX`) rather than a free-form label.
 *
 * The migration advisory lock is reused from the existing helper to
 * preserve the same cluster-wide serialization guarantee — the E2E
 * spec runs two workers concurrently, so the same `ALTER ROLE` race
 * that motivated the lock for vitest applies here too.
 */
/**
 * The four cluster-global application roles the E2E harness needs to
 * impersonate. Postgres roles are cluster-wide, so the harness NEVER
 * mutates these shared roles (that would break every concurrent session
 * on the same local instance — dev servers, RLS runs, other E2E runs).
 * Instead each worker database gets four dedicated login roles that are
 * members of the base roles (privileges and RLS policies apply to
 * members via inheritance) and are dropped with the database.
 */
export const E2E_BASE_ROLES = [
  'builderhunt_app',
  'builderhunt_auth',
  'builderhunt_worker',
  'builderhunt_platform',
] as const

export const E2E_ROLE_PASSWORD = 'builderhunt_e2e'

/**
 * Deterministic per-database role name for a base role, derivable from the
 * database name alone so `e2e/harness/database.ts` can reconstruct the
 * connection URLs without threading extra state.
 * `builderhunt_security_test_e2e_w0_<16hex>` → `builderhunt_app_e2e_w0_<16hex>`.
 */
export function e2eWorkerRoleName(baseRole: string, databaseName: string): string {
  const suffix = databaseName.replace(/^builderhunt_security_test_/, '')
  return `${baseRole}_${suffix}`
}

export async function createE2EWorkerDatabase(workerIndex: number) {
  const adminUrl = new URL(process.env.DATABASE_MIGRATION_URL ?? 'postgresql://postgres:***@localhost:5432/builderhunt')
  const databaseName = `builderhunt_security_test_e2e_w${workerIndex}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const databaseUrl = new URL(adminUrl.toString())
  databaseUrl.pathname = `/${databaseName}`

  const admin = postgres(adminUrl.toString(), { max: 1, prepare: false })
  await admin.unsafe(`CREATE DATABASE ${databaseName}`)

  // max: 5 — same rationale as `createDisposableTestDatabase`. The app
  // server (vite dev) plus the test process both open connections to
  // this database, and transactions in the app may borrow a second
  // connection from the same pool.
  const client = postgres(databaseUrl.toString(), { max: 5, prepare: false })
  const db = drizzle(client)

  try {
    await migrateWithRetry(db)
    // Roles are cluster-wide, while CONNECT is database-specific. Never
    // mutate the shared base roles' passwords — that races every other
    // session on the same local cluster. Create per-database login roles
    // that are members of the base roles instead: table privileges and
    // RLS policies (`TO builderhunt_app` etc.) apply to inheriting
    // members, and the roles die with the database in `drop()`.
    for (const baseRole of E2E_BASE_ROLES) {
      const dedicated = e2eWorkerRoleName(baseRole, databaseName)
      await admin.unsafe(`DROP ROLE IF EXISTS ${dedicated}`)
      await admin.unsafe(
        `CREATE ROLE ${dedicated} LOGIN INHERIT PASSWORD '${E2E_ROLE_PASSWORD}' IN ROLE ${baseRole}`,
      )
      await admin.unsafe(`GRANT CONNECT ON DATABASE ${databaseName} TO ${dedicated}`)
    }
  } catch (error) {
    await client.end({ timeout: 5 }).catch(() => {})
    await admin.end({ timeout: 5 }).catch(() => {})
    throw error
  }

  return {
    db,
    databaseName,
    databaseUrl: databaseUrl.toString(),
    async drop(): Promise<void> {
      await client.end({ timeout: 5 })
      await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`)
      for (const baseRole of E2E_BASE_ROLES) {
        await admin.unsafe(`DROP ROLE IF EXISTS ${e2eWorkerRoleName(baseRole, databaseName)}`)
      }
      await admin.end({ timeout: 5 })
    },
  }
}

async function migrateWithRetry(db: PostgresJsDatabase, attempts = 5): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await migrate(db, { migrationsFolder: './drizzle' })
      return
    } catch (error) {
      if (!isConcurrentDdlConflict(error) || attempt === attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt + Math.random() * 200))
    }
  }
}

function isConcurrentDdlConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const cause = error instanceof Error ? error.cause : undefined
  const causeMessage = cause instanceof Error ? cause.message : undefined
  return message.includes('tuple concurrently updated') || (causeMessage?.includes('tuple concurrently updated') ?? false)
}
