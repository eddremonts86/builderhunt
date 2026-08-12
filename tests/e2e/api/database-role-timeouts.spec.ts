import { test, expect } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from '../harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from '../harness/database'
import { e2eEnv } from '../harness/env'

/**
 * Every role's timeouts, asserted through the role itself against a freshly migrated database
 * (plan 55 phase 3).
 *
 * ## Why this is an e2e spec and not a unit test
 *
 * A unit test connects as the superuser — this repository has three defects on record that hid behind exactly
 * that — and a superuser's session carries the superuser's settings, not `builderhunt_app`'s. The only way to
 * know what a request-serving backend gets is to connect as the identity a request-serving backend uses.
 *
 * The worker harness gives each Playwright worker a disposable database with every migration applied,
 * including `0168`, and a per-database login role per base role. This spec connects through the harness's own
 * URLs — the same ones `db/client.ts` and friends are handed — so what it measures is the bound a
 * request-serving connection in this suite actually gets, not the bound the catalog says a role should have.
 *
 * ## The gap that made this spec worth writing
 *
 * The first version of this comment claimed the member roles "inherit" the base role's settings. They do not:
 * table privileges and RLS policies apply through membership, `ALTER ROLE ... SET` does not. Every base role
 * carried the budget and all fifteen member roles carried `null`, so the whole suite was running unbounded
 * while the migration and `verify-role-timeouts.mjs` both passed. `copyRoleSettings` in
 * `create-disposable-test-database.ts` closes it, and these assertions are what keeps it closed.
 *
 * ## Why the cancellation probe is the point
 *
 * `SHOW statement_timeout` proves a setting is present. It does not prove PostgreSQL acts on it, and that is
 * the only property that matters — a timeout set but not enforced is indistinguishable from a correct one
 * until the day a query hangs and takes the pool with it.
 */
let database: Awaited<ReturnType<typeof acquireWorkerDatabase>>
let workerIndex: number

/**
 * The budget from `drizzle/0168_role_timeouts.sql`, restated here on purpose.
 *
 * Importing it from a shared constant would make this spec agree with the migration by construction and
 * assert nothing. Two independent statements of the same numbers is what makes a drift visible.
 */
const EXPECTED = [
  { role: 'builderhunt_app', urlKey: 'DATABASE_URL', statement: 5, idle: 10 },
  { role: 'builderhunt_auth', urlKey: 'DATABASE_AUTH_URL', statement: 5, idle: 10 },
  { role: 'builderhunt_capability', urlKey: 'DATABASE_CAPABILITY_URL', statement: 5, idle: 10 },
  { role: 'builderhunt_worker', urlKey: 'DATABASE_WORKER_URL', statement: 30, idle: 30 },
  { role: 'builderhunt_platform', urlKey: 'DATABASE_PLATFORM_URL', statement: 15, idle: 10 },
] as const satisfies ReadonlyArray<{
  role: string
  /**
   * The key in `workerDatabaseUrls`, named explicitly rather than derived from `role`.
   *
   * The first version indexed `database.urls` with `expected.role as keyof typeof database.urls` — and that
   * cast is exactly what silenced the error that would have caught it. The harness keys those URLs by env
   * var (`DATABASE_URL`, `DATABASE_AUTH_URL`, …), not by role name, so every lookup returned `undefined` and
   * `tsc` said nothing. `satisfies` keeps the literal types while making the key a checked one.
   */
  urlKey: 'DATABASE_URL' | 'DATABASE_AUTH_URL' | 'DATABASE_CAPABILITY_URL' | 'DATABASE_WORKER_URL' | 'DATABASE_PLATFORM_URL'
  statement: number
  idle: number
}>

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

/** Seconds from PostgreSQL's normalised interval string. `5000ms` and `5s` are the same budget. */
function toSeconds(value: string): number | null {
  const match = /^(\d+)(ms|s|min)?$/.exec(value.trim())
  if (!match) return null
  const amount = Number(match[1])
  return match[2] === 'ms' ? amount / 1000 : match[2] === 'min' ? amount * 60 : amount
}

for (const expected of EXPECTED) {
  test(`${expected.role} carries its own timeouts and enforces them`, async () => {
    /**
     * The probe waits one second past the role's budget, so the worker's 30 s tier needs 31 s — past
     * Playwright's 30 s default. The `test.setTimeout` in `beforeAll` covers the hook only, which is why the
     * worker case failed at exactly 30.0s while the three 5-second roles passed.
     */
    test.setTimeout((expected.statement + 60) * 1_000)

    // `urls` holds the per-database login role for each base role. It carries this budget only because the
    // harness copies the base role's settings onto it — membership alone would leave it at `0`.
    const url = database.urls[expected.urlKey]
    expect(url, `no URL for ${expected.role} (${expected.urlKey})`).toBeTruthy()

    let sql: Sql | undefined
    try {
      sql = postgres(String(url), { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 10 })

      // Which role this URL actually connects as, checked before its timeouts: a URL pointing at the wrong
      // role would otherwise report that role's budget as this one's and read as a pass. Inside the `try`,
      // so the connection is closed by the `finally` — the first version opened a second pool and never
      // ended it, which is how a spec leaks a connection per test.
      const [identity] = await sql.unsafe('select current_user')
      expect(String(identity.current_user)).toContain(expected.role)

      const [statement] = await sql.unsafe('show statement_timeout')
      const [idle] = await sql.unsafe('show idle_in_transaction_session_timeout')
      expect(toSeconds(String(statement.statement_timeout))).toBe(expected.statement)
      expect(toSeconds(String(idle.idle_in_transaction_session_timeout))).toBe(expected.idle)

      /**
       * The probe, one second past the role's own budget.
       *
       * `57014` is `query_canceled`, matched on the SQLSTATE rather than the message: the message is
       * localised, so a `LANG` in the environment would break a string comparison and the failure would look
       * like a missing timeout.
       *
       * The worker's 30 s budget makes this a 31-second wait, which is what the `test.setTimeout` at the top
       * of this test is for — and why the probe runs last, after the cheap assertions have already reported.
       */
      await expect(sql.unsafe(`select pg_sleep(${expected.statement + 1})`)).rejects.toMatchObject({ code: '57014' })
    } finally {
      await sql?.end({ timeout: 5 }).catch(() => undefined)
    }
  })
}

test('the readonly role is deliberately left without a timeout', async () => {
  /**
   * An omission worth asserting, because it looks like a gap.
   *
   * `builderhunt_readonly` is the restore and inspection identity, driven by a human at a psql prompt. A
   * 5-second bound there turns a legitimate long analytical query into a cancellation nobody can explain —
   * so its absence is a decision, and a future sweep that "fixes the missing role" should fail here first.
   */
  const admin = postgres(e2eEnv().DATABASE_MIGRATION_URL, { max: 1, prepare: false })
  try {
    const [row] = await admin`
      select rolconfig from pg_roles where rolname = 'builderhunt_readonly'
    `
    const config = (row?.rolconfig ?? []) as string[]
    expect(config.some((entry) => entry.startsWith('statement_timeout'))).toBe(false)
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined)
  }
})
