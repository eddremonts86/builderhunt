/**
 * create-db.ts
 *
 * Creates the application database in the shared workspace-postgres server
 * (or standalone db) if it does not already exist.
 *
 * Called automatically by `pnpm db:migrate` before running Drizzle migrations.
 * Safe to run multiple times — idempotent.
 *
 * Usage: tsx scripts/db/create-db.ts
 */

import postgres from 'postgres'

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL

if (!url) {
  console.error('❌  DATABASE_MIGRATION_URL (or local DATABASE_URL fallback) is not set.')
  process.exit(1)
}

const parsed = new URL(url.replace(/^postgres:\/\//, 'postgresql://'))
const dbName = parsed.pathname.replace(/^\//, '')
if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
  throw new Error('Database name may contain only letters, numbers, and underscores')
}
const adminUrl = `postgresql://${parsed.username}:${parsed.password}@${parsed.hostname}:${parsed.port}/postgres`

const sql = postgres(adminUrl, { max: 1, prepare: false })

try {
  await sql.unsafe(`CREATE DATABASE "${dbName}"`)
  console.log(`✅  Database "${dbName}" created`)
} catch (e) {
  const code = e instanceof Error && 'code' in e ? (e as Error & { code: string }).code : null
  if (code === '42P04') {
    console.log(`ℹ️   Database "${dbName}" already exists`)
  } else if (code === '42501') {
    // No CREATEDB privilege — verify the DB was already created (e.g. by db-init)
    const checkSql = postgres(adminUrl, { max: 1, prepare: false })
    try {
      const rows = await checkSql.unsafe(
        `SELECT 1 FROM pg_database WHERE datname = '${dbName}'`
      )
      if (rows.length > 0) {
        console.log(`ℹ️   Database "${dbName}" already exists (no CREATEDB needed)`)
      } else {
        throw new Error(
          `Database "${dbName}" does not exist and the user has no CREATEDB privilege. Grant CREATEDB to the role or run db-init first.`,
          { cause: e }
        )
      }
    } finally {
      await checkSql.end({ timeout: 5 })
    }
  } else {
    throw e
  }
} finally {
  await sql.end({ timeout: 5 })
}
