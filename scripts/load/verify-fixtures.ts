/**
 * Proves the load fixture seeds and cleans up, against a real disposable database (plan 55 phase 0).
 *
 * ## Why this is a script and not a unit test
 *
 * The interesting properties are all things a mock cannot have. That a thousand `auth_accounts` rows are
 * actually *login-capable* is a statement about a join and a `not null` password, not about the code that
 * wrote them. That cleanup returns every run-scoped count to zero is a statement about delete order under
 * real foreign keys — the first version of `cleanup.ts` deleted no organizations at all and a unit test with
 * a fake client would have agreed with it.
 *
 * It creates its own database, migrates it, seeds, asserts, cleans up, asserts again, and drops it. Nothing
 * it touches outlives it, which is why it can afford to assert on absolute counts.
 *
 * Usage:
 *   pnpm load:verify-fixtures
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { cleanupLoadFixtures } from './cleanup'
import { FIXTURE_COUNTS, seedLoadFixtures } from './seed'

/** Carries the disposable prefix `safety.ts` demands, so the seed's own guard accepts it. */
const DATABASE_NAME = 'builderhunt_load_test_verify'

function fail(message: string): never {
  console.error(`❌  ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_MIGRATION_URL
  if (!adminUrl) fail('DATABASE_MIGRATION_URL is not set')
  const target = new URL(adminUrl)
  target.pathname = `/${DATABASE_NAME}`

  const root = postgres(adminUrl, { max: 1, prepare: false })
  try {
    await root.unsafe(`drop database if exists ${DATABASE_NAME}`)
    await root.unsafe(`create database ${DATABASE_NAME}`)
  } finally {
    await root.end({ timeout: 5 }).catch(() => undefined)
  }
  console.log(`created ${DATABASE_NAME}`)

  /**
   * The migrator gets a connection of its own and never gets reused.
   *
   * After `migrate()` runs on a postgres.js client, every later `${someDate}` on that same client throws
   * `ERR_INVALID_ARG_TYPE` — and the seed binds dates on nearly every row.
   */
  const migrator = postgres(target.toString(), { max: 1, prepare: false })
  try {
    await migrate(drizzle(migrator), { migrationsFolder: 'drizzle' })
  } finally {
    await migrator.end({ timeout: 5 }).catch(() => undefined)
  }
  console.log('migrations applied')

  const manifest = await seedLoadFixtures({
    databaseUrl: target.toString(),
    runIdSuffix: 'verify',
  })

  const check = postgres(target.toString(), { max: 1, prepare: false })
  let loginCapable: number
  let memberships: number
  try {
    // Login-capable means the account row exists *and* carries a password — a user with no credential row
    // is a user the runner cannot sign in as, and would fail the run 1,000 times at startup instead of once
    // here.
    const [users] = await check.unsafe<Array<{ count: number }>>(
      `select count(*)::int as count
         from auth_users u
         join auth_accounts a
           on a.user_id = u.id and a.provider_id = 'credential' and a.password is not null
        where u.id like $1`,
      [`ld_${manifest.runId}_%`],
    )
    loginCapable = Number(users?.count ?? 0)
    const [orgs] = await check.unsafe<Array<{ count: number }>>(
      `select count(*)::int as count from organization_members where user_id like $1`,
      [`ld_${manifest.runId}_%`],
    )
    memberships = Number(orgs?.count ?? 0)
  } finally {
    await check.end({ timeout: 5 }).catch(() => undefined)
  }

  console.log(`login-capable users: ${loginCapable}`)
  console.log(`owning memberships:  ${memberships}`)
  for (const [table, count] of Object.entries(manifest.counts)) console.log(`  ${table}: ${count}`)

  if (loginCapable !== FIXTURE_COUNTS.users) {
    fail(`expected exactly ${FIXTURE_COUNTS.users} login-capable users, found ${loginCapable}`)
  }
  if (memberships !== FIXTURE_COUNTS.users) {
    fail(`expected one owning membership per user, found ${memberships}`)
  }

  const result = await cleanupLoadFixtures({ databaseUrl: target.toString(), runId: manifest.runId })
  const stuck = Object.entries(result.remaining).filter(([, count]) => count > 0)
  if (stuck.length > 0) {
    fail(`cleanup left rows behind: ${stuck.map(([table, count]) => `${table}=${count}`).join(', ')}`)
  }
  if (result.deleted.organizations !== FIXTURE_COUNTS.users) {
    fail(`cleanup removed ${result.deleted.organizations} organizations, expected ${FIXTURE_COUNTS.users}`)
  }

  const drop = postgres(adminUrl, { max: 1, prepare: false })
  try {
    await drop.unsafe(`drop database if exists ${DATABASE_NAME}`)
  } finally {
    await drop.end({ timeout: 5 }).catch(() => undefined)
  }

  console.log(`✅  ${loginCapable} login-capable users seeded and every run-scoped count returned to zero`)
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : 'unknown error')
})
