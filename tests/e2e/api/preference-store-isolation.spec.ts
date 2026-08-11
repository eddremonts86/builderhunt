import { test, expect } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from '../harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from '../harness/database'
import { e2eEnv } from '../harness/env'

/**
 * The two preference stores cannot reach each other (plan 57, Admin track — "Persist isolated platform-admin
 * preferences").
 *
 * ## Why this is an e2e spec and not a unit test
 *
 * The Verify line is "platform and tenant preferences cannot overwrite/read each other", and that property lives
 * in GRANTs. A unit test connects as the superuser, which has every privilege — so the assertion would pass with
 * no grants at all, which is the shape of three defects already on record in this repository. The only way to know
 * what a request-serving backend can reach is to connect as the identity a request-serving backend uses.
 *
 * ## Why a table-level refusal rather than an RLS predicate
 *
 * `dashboard_preferences` uses RLS: the row is visible when `organization_id` matches the session's
 * `app.organization_id`. That is right for a tenant preference and cannot express a platform one — a platform
 * admin has no organization in the admin console, so a shared table would need a nullable column the predicate
 * silently drops, or a sentinel organization row any policy bug would expose.
 *
 * So the isolation here is the absence of a grant, which is a stronger statement than a policy: a policy filters
 * rows and can be defeated by a missing `withTenantContext`, while a missing privilege refuses the statement.
 * `builderhunt_app` gets 42501 on `platform_admin_preferences` and `builderhunt_platform` gets 42501 on
 * `dashboard_preferences` — neither one has a predicate to get wrong.
 */
let database: Awaited<ReturnType<typeof acquireWorkerDatabase>>
let workerIndex: number

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  expect(e2eEnv().E2E_MODE).toBe('true')
  workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  database = await acquireWorkerDatabase(workerIndex)
})

test.afterAll(async () => {
  await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
})

/**
 * Runs one statement as one role and reports the SQLSTATE, or `null` when it succeeded.
 *
 * `fetch_types: false` and `prepare: false` because these connections are made and dropped per assertion and there
 * is nothing to gain from a type round trip; `max: 1` because a refused statement should not leave a pool behind.
 */
async function sqlstateFor(url: string, statement: string): Promise<string | null> {
  let sql: Sql | undefined
  try {
    sql = postgres(url, { max: 1, prepare: false, fetch_types: false })
    await sql.unsafe(statement)
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown'
  } finally {
    await sql?.end({ timeout: 5 }).catch(() => undefined)
  }
}

/** `42501` is `insufficient_privilege` — the statement was refused, not filtered to zero rows. */
const INSUFFICIENT_PRIVILEGE = '42501'

test('the app role cannot read a platform admin preference', async () => {
  /**
   * The direction that matters most. A tenant request runs as `builderhunt_app`, and a platform admin's console
   * layout is not tenant data — so a query that reaches it, however it got written, is a query that should not
   * compile at the database.
   */
  const code = await sqlstateFor(database.urls.DATABASE_URL, 'select 1 from platform_admin_preferences limit 1')
  expect(code).toBe(INSUFFICIENT_PRIVILEGE)
})

test('the app role cannot write one either', async () => {
  // Read and write are separate privileges, and a `SELECT`-only refusal would leave the overwrite half of the
  // Verify line unproven.
  const code = await sqlstateFor(
    database.urls.DATABASE_URL,
    "insert into platform_admin_preferences (user_id) values ('nobody')",
  )
  expect(code).toBe(INSUFFICIENT_PRIVILEGE)
})

test('the platform role cannot read a tenant dashboard preference', async () => {
  /**
   * The reverse direction, and it is not symmetric bookkeeping.
   *
   * `builderhunt_platform` is the admin console's role and it reads cross-tenant aggregates by design. A tenant's
   * saved dashboard layout is private workflow content — the Admin track's own rule forbids exactly this kind of
   * per-user visibility — so the absence of the grant is what keeps a future admin query from picking it up
   * because it happened to be reachable.
   */
  const code = await sqlstateFor(database.urls.DATABASE_PLATFORM_URL, 'select 1 from dashboard_preferences limit 1')
  expect(code).toBe(INSUFFICIENT_PRIVILEGE)
})

test('the platform role can use its own store, so the refusals above are about the table and not the role', async () => {
  /**
   * The control. Without it, every assertion above would also pass if the platform role had been misconfigured
   * into having no privileges at all — the isolation would look perfect and the feature would be broken.
   */
  const code = await sqlstateFor(
    database.urls.DATABASE_PLATFORM_URL,
    'select 1 from platform_admin_preferences limit 1',
  )
  expect(code).toBeNull()
})

test('nobody can delete a preference row, because nothing in the product does', async () => {
  /**
   * "Reset my layout" is an update back to the defaults, not a delete — the same decision
   * `dashboard_preferences` records in `0152`. Granting DELETE because it might one day be wanted is how a role
   * ends up able to remove rows no code path needs, and this repository has already paid for the opposite mistake:
   * an enrichment helper ran a delete the grant refused with 42501.
   */
  const code = await sqlstateFor(
    database.urls.DATABASE_PLATFORM_URL,
    "delete from platform_admin_preferences where user_id = 'nobody'",
  )
  expect(code).toBe(INSUFFICIENT_PRIVILEGE)
})
