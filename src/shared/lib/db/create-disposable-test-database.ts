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
  const adminUrl = new URL(process.env.DATABASE_MIGRATION_URL ?? 'postgresql://postgres:postgres@localhost:5432/builderhunt')
  const databaseName = `builderhunt_security_test_${namePrefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const databaseUrl = new URL(adminUrl.toString())
  databaseUrl.pathname = `/${databaseName}`

  const admin = postgres(adminUrl.toString(), { max: 1, prepare: false })
  await admin.unsafe(`CREATE DATABASE ${databaseName}`)

  const client = postgres(databaseUrl.toString(), { max: 1, prepare: false })
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
    async drop(): Promise<void> {
      await client.end({ timeout: 5 })
      await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`)
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
