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

const url = process.env.DATABASE_URL

if (!url) {
  console.error('❌  DATABASE_URL is not set. Check your .env file.')
  process.exit(1)
}

const parsed = new URL(url.replace(/^postgres:\/\//, 'postgresql://'))
const dbName = parsed.pathname.replace(/^\//, '')
const adminUrl = `postgresql://${parsed.username}:${parsed.password}@${parsed.hostname}:${parsed.port}/postgres`

const sql = postgres(adminUrl, { max: 1, prepare: false })

try {
  await sql.unsafe(`CREATE DATABASE "${dbName}"`)
  console.log(`✅  Database "${dbName}" created`)
} catch (e: any) {
  if (e.code === '42P04') {
    console.log(`ℹ️   Database "${dbName}" already exists`)
  } else {
    throw e
  }
} finally {
  await sql.end({ timeout: 5 })
}
