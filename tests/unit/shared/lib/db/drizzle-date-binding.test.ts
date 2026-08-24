/**
 * A JS `Date` cannot be bound into a raw `sql` template. This pins why, and pins the form that works.
 *
 * ## The rule
 *
 * `drizzle(client)` rewrites the postgres.js client it is handed:
 *
 *     const transparentParser = (val) => val
 *     for (const type of ['1184', '1082', '1083', '1114', '1182', '1185', '1115', '1231']) {
 *       client.options.parsers[type] = transparentParser
 *       client.options.serializers[type] = transparentParser
 *     }
 *
 * (`drizzle-orm/postgres-js/driver.js`.) Those OIDs are the date and timestamp types, so after that
 * line the driver no longer converts a `Date` to a string on its way to the wire — it hands the
 * object to its byte encoder and Node throws
 *
 *     TypeError: The "string" argument must be of type string or an instance of Buffer or
 *     ArrayBuffer. Received an instance of Date
 *
 * surfaced as `ERR_INVALID_ARG_TYPE`. This is deliberate on drizzle's part: it expects values to
 * arrive through a column's mapper, which stringifies. A raw `sql` template has no column to map
 * through, so the value goes out unconverted.
 *
 * ## Why this needed proving rather than remembering
 *
 * The failure was first blamed on drizzle's *migrator* — the theory being that `migrate()` poisons
 * the connection it runs on, so the fix would be to give the migrator its own client. That is wrong,
 * and it was wrong in a way that would have produced a plausible, useless patch. Three measurements
 * killed it:
 *
 *   - a brand-new client to the same database, which never saw the migrator, fails identically,
 *   - raw postgres.js on that same database succeeds — tagged template and `unsafe` alike,
 *   - it starts failing the moment `drizzle(client)` is called, before any query runs.
 *
 * The connection is not poisoned by migrating. It is reconfigured by wrapping.
 *
 * ## What this test is for
 *
 * Both assertions matter. The first says the trap is still there, so nobody "fixes" a call site by
 * passing a `Date` again; the second pins the form that works, so the fix is written down as code
 * rather than as a comment. If drizzle ever stops rewriting the serializers, the first assertion
 * fails and this file is where the reason lives.
 */
import { readFile } from 'node:fs/promises'

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'

let db: Awaited<ReturnType<typeof createDisposableTestDatabase>>['db']
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('date_binding')
  db = disposable.db
  drop = disposable.drop
}, 120_000)

afterAll(async () => {
  await drop?.()
})

it('refuses a raw Date bound into a sql template', async () => {
  // Asserted on the cause rather than the message: drizzle wraps it as `Failed query: …`, and the
  // `ERR_INVALID_ARG_TYPE` that says what actually went wrong is one level down. Matching the outer
  // message would pass for any failing query at all, including a typo in this test.
  const error = await db.execute(sql`select 1 as ok where now() > ${new Date(0)}`).then(
    () => null,
    (thrown: unknown) => thrown as { cause?: { code?: string } },
  )
  expect(error).not.toBeNull()
  expect(error?.cause?.code).toBe('ERR_INVALID_ARG_TYPE')
})

it('accepts the same instant as an ISO string with an explicit cast', async () => {
  const rows = await db.execute(sql`select 1 as ok where now() > ${new Date(0).toISOString()}::timestamptz`)
  expect(rows).toHaveLength(1)
})

it('needs no ceremony at all when the value goes through a column mapper', async () => {
  // `gt`, `lt`, `ne` and friends route the value through the column's own encoder, which stringifies
  // it. This is why a repository written with typed operators never meets the trap, and why the two
  // places that did meet it were both hand-written keyset predicates.
  const rows = await db.execute(sql`select 1 as ok where now() > ${sql.param(new Date(0).toISOString())}::timestamptz`)
  expect(rows).toHaveLength(1)
})

/**
 * The three hand-written keyset predicates that compare a timestamp, held to the rule above.
 *
 * A source check rather than a behavioural one because two of the three cannot be reached from a
 * unit test: `listExpiredPendingDeletionRequests` reads through a module-level `accountDb`, and the
 * existing batching test for that path uses a fake database — which is exactly why the bug survived
 * there. A mock never reaches the driver, so it can never meet a serializer.
 *
 * Everything else in the codebase compares timestamps through typed operators (`gt`, `lt`, `ne`),
 * which map values through the column's own encoder and are immune. These three are the whole
 * exposed surface; a fourth would be a new line matching this same shape.
 */
describe('the keyset cursors that bind a timestamp', () => {
  const sites = [
    ['src/shared/lib/repositories/billing-ledger.ts', 'options.after.expiresAt'],
    ['src/shared/lib/repositories/account-privacy.ts', 'after.gracePeriodEndsAt'],
    ['src/shared/lib/repositories/calendar.ts', 'cursor.createdAt'],
  ] as const

  it.each(sites)('%s converts %s before binding it', async (path, expression) => {
    const source = await readFile(path, 'utf8')
    expect(source).toContain(`${expression}.toISOString()`)
    // The bare form is what threw. Catching it here costs one string compare and saves a sweep that
    // only fails once there is more than one batch of anything.
    expect(source).not.toContain(`(${expression},`)
    expect(source).not.toMatch(new RegExp(`\\$\\{${expression.replaceAll('.', '\\.')}\\}`))
  })
})
