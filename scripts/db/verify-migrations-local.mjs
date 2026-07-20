import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const migrationUrl = process.env.TEST_MIGRATION_URL
if (!migrationUrl) throw new Error('TEST_MIGRATION_URL is required')
const databaseName = new URL(migrationUrl).pathname.slice(1)
if (!/^builderhunt_security_test_[A-Za-z0-9_]+$/.test(databaseName)) {
  throw new Error('Migration verifier refuses to run outside a named builderhunt_security_test database')
}

const client = postgres(migrationUrl, { max: 1 })
try {
  const database = drizzle(client)
  await migrate(database, { migrationsFolder: './drizzle' })
  await migrate(database, { migrationsFolder: './drizzle' })
  const [row] = await client`select count(*)::int as count from drizzle.__drizzle_migrations`
  console.log(JSON.stringify({ firstRun: 'ok', secondRun: 'ok', applied: row.count }))
} finally {
  await client.end()
}
