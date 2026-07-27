/**
 * Wave 1 Task 1 — per-worker disposable PostgreSQL database.
 *
 * Each Playwright worker gets:
 *   - exactly one disposable database (`builderhunt_security_test_e2e_wN_*`),
 *   - five connection URLs targeting the same database under the
 *     application's distinct roles (runtime, auth, worker, platform,
 *     migration) — see `workerDatabaseUrls` below.
 *
 * Lifecycle is owned by the worker process, not by the test file:
 *   - `acquireWorkerDatabase` is called once per worker in `test.beforeAll`
 *     (or via the global setup that the harness installs in `playwright.config.ts`),
 *   - `dropWorkerDatabase` is called on `test.afterAll` so a failing
 *     assertion still tears the database down — no orphaned
 *     `builderhunt_security_test_e2e_*` databases survive the run.
 *
 * The implementation delegates to `createE2EWorkerDatabase` in
 * `src/shared/lib/db/create-disposable-test-database.ts` so the existing
 * migration advisory lock, retry strategy, and pooled connection are
 * reused exactly — no migration or schema change is required to support
 * the E2E harness.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import {
  createE2EWorkerDatabase,
  E2E_BASE_ROLES,
  E2E_ROLE_PASSWORD,
  e2eWorkerRoleName,
} from '../../../src/shared/lib/db/create-disposable-test-database'
import { e2eEnv } from './env'

export interface WorkerDatabase {
  workerIndex: number
  databaseName: string
  databaseUrl: string
  /** Opaque Drizzle handle for fixtures that want to bypass the app's pool. */
  db: ReturnType<typeof drizzle>
  /** All five role URLs targeting the same disposable database. */
  urls: ReturnType<typeof workerDatabaseUrls>
}

/**
 * Construct the five role URLs targeting the worker's disposable database.
 *
 * The five roles (`DATABASE_URL`, `DATABASE_AUTH_URL`, `DATABASE_WORKER_URL`,
 * `DATABASE_PLATFORM_URL`, `DATABASE_MIGRATION_URL`) match the role
 * separation the app uses in production (see `.env.example` and
 * `src/shared/lib/env.ts`). They share the *database* but each one
 * points at the role-specific credentials wired through the local
 * development environment — the same credentials the app uses against
 * the real local database, just redirected to the disposable copy.
 *
 * If a role-specific URL is missing from the environment we fall back to
 * the corresponding entry from the admin URL — this preserves the
 * existing behavior of `src/shared/lib/db/{auth-db,worker-db,client}.ts`
 * in tests that do not yet opt into role separation.
 */
export function workerDatabaseUrls(databaseName: string): {
  DATABASE_URL: string
  DATABASE_AUTH_URL: string
  DATABASE_WORKER_URL: string
  DATABASE_PLATFORM_URL: string
  DATABASE_MIGRATION_URL: string
} {
  const env = e2eEnv()
  const adminUrl = new URL(env.DATABASE_MIGRATION_URL)
  // `createE2EWorkerDatabase` never touches the shared cluster roles.
  // It creates per-database dedicated login roles (members of the base
  // roles) with a deterministic test password, so any URL that names a
  // base role is rewritten to that database's dedicated role. URLs using
  // other users (e.g. the local `postgres` superuser) pass through.
  const templateFor = (source: string | undefined, fallback: string): string => {
    const u = new URL(source ?? fallback)
    u.pathname = `/${databaseName}`
    const username = decodeURIComponent(u.username)
    if ((E2E_BASE_ROLES as readonly string[]).includes(username)) {
      u.username = e2eWorkerRoleName(username, databaseName)
      u.password = E2E_ROLE_PASSWORD
    }
    return u.toString()
  }
  return {
    DATABASE_URL: templateFor(env.DATABASE_URL, adminUrl.toString()),
    DATABASE_AUTH_URL: templateFor(env.DATABASE_AUTH_URL, env.DATABASE_URL || adminUrl.toString()),
    DATABASE_WORKER_URL: templateFor(env.DATABASE_WORKER_URL, env.DATABASE_URL || adminUrl.toString()),
    DATABASE_PLATFORM_URL: templateFor(env.DATABASE_PLATFORM_URL, env.DATABASE_URL || adminUrl.toString()),
    DATABASE_MIGRATION_URL: templateFor(env.DATABASE_MIGRATION_URL, adminUrl.toString()),
  }
}

interface WorkerDatabaseRecord {
  workerIndex: number
  databaseName: string
  databaseUrl: string
  dispose: () => Promise<void>
}

// One record per worker process. module-level state is safe because each
// Playwright worker is its own Node process — there is no shared state
// between workers, which is exactly the isolation property the harness
// needs to prove.
const records = new Map<number, WorkerDatabaseRecord>()

export async function acquireWorkerDatabase(workerIndex: number): Promise<WorkerDatabase> {
  const existing = records.get(workerIndex)
  if (existing) {
    return {
      workerIndex: existing.workerIndex,
      databaseName: existing.databaseName,
      databaseUrl: existing.databaseUrl,
      db: drizzle(postgres(existing.databaseUrl, { max: 5, prepare: false })),
      urls: workerDatabaseUrls(existing.databaseName),
    }
  }
  const created = await createE2EWorkerDatabase(workerIndex)
  records.set(workerIndex, {
    workerIndex,
    databaseName: created.databaseName,
    databaseUrl: created.databaseUrl,
    dispose: created.drop,
  })
  return {
    workerIndex,
    databaseName: created.databaseName,
    databaseUrl: created.databaseUrl,
    db: created.db,
    urls: workerDatabaseUrls(created.databaseName),
  }
}

export async function dropWorkerDatabase(workerIndex: number, databaseName?: string): Promise<void> {
  const record = records.get(workerIndex)
  if (record) {
    await record.dispose()
    records.delete(workerIndex)
    return
  }
  // Idempotent fallback: if the worker process restarted or the record
  // was never set (e.g. an assertion failed before `acquireWorkerDatabase`
  // finished), still try to drop the database by name. The failure mode
  // here is a leaked E2E database, which the harness promises to clean
  // up — so we always attempt the drop.
  if (databaseName) {
    const adminUrl = e2eEnv().DATABASE_MIGRATION_URL
    const admin = postgres(adminUrl, { max: 1, prepare: false })
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`)
    } finally {
      await admin.end({ timeout: 5 })
    }
  }
}
