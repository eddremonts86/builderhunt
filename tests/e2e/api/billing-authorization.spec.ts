/**
 * The authorization floor under every billing route (plan 53, task 3 — first slice).
 *
 * Task 3's body is the scenario matrix: every route driven through `FakeBillingProvider`'s six scenarios
 * (`success`, `sca_required`, `decline`, `timeout`, `delayed`, `out_of_order`), asserting what each does to
 * the ledger. That is five files' worth of work and it is still open.
 *
 * This file is the floor underneath it, and it is worth having first for one reason: **these routes move
 * money.** A scenario test proves a decline does not grant credits; it says nothing about whether a stranger
 * could have reached the endpoint at all. Authorization is the cheaper property and the more catastrophic one
 * to lose, so it is pinned across the whole surface before any of it is exercised in depth.
 *
 * Same table-plus-filesystem technique as `admin.spec.ts`: `ROUTES` is compared against the actual files
 * under `src/routes/api/billing/`, so a new billing endpoint with no authorization probe fails here instead
 * of shipping unprobed.
 */
import { test, expect, request as playwrightRequest, type APIRequestContext } from 'playwright/test'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from '../harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from '../harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from '../harness/cache'
import { startWorkerServer, stopWorkerServer } from '../harness/server'
import { e2eEnv } from '../harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv } from '../harness/clock'
import {
  createOwnerPrincipal,
  disposePrincipal,
  type FixtureContext,
  type Principal,
} from '../harness/fixtures/principals'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  owner: Principal
  anonymous: APIRequestContext
}

let harness: Harness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  ensureFixedTimeEnv()
  expect(e2eEnv().E2E_MODE).toBe('true')

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}billauth` }
    const owner = await createOwnerPrincipal(ctx, {
      tier: 'pro',
      seatLimit: 3,
      clock: fixedClockFromEnv(),
    })

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      owner: owner.principal,
      anonymous: await playwrightRequest.newContext({ baseURL: server.baseURL }),
    }
  } catch (error) {
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    await dropWorkerRedisNamespace(cache.prefix).catch(() => undefined)
    throw error
  }
})

test.afterAll(async () => {
  const h = harness
  if (!h) return
  await h.anonymous.dispose().catch(() => undefined)
  await disposePrincipal(h.owner).catch(() => undefined)
  await h.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(h.workerIndex)
  const admin = postgres(e2eEnv().DATABASE_MIGRATION_URL, { max: 1, prepare: false })
  try {
    await admin`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = ${h.databaseName} and pid <> pg_backend_pid()
    `
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined)
  }
  await dropWorkerDatabase(h.workerIndex, h.databaseName)
  await dropWorkerRedisNamespace(h.redisPrefix)
})

type Method = 'GET' | 'POST' | 'PUT'

/**
 * `anonymous: 'link'` marks a route that is a click-through target from an email rather than an API endpoint.
 *
 * `GET /api/billing/contact/verify` is opened by a person clicking a link in their inbox, usually in a browser
 * with no session for this site. Refusing it with 401 would break the flow it exists to serve — it redirects
 * to sign-in with a callback instead. Asserting 401 there would be asserting against the feature.
 *
 * What it must still do is refuse to act without a valid token, and reveal nothing about the contact behind
 * one, which is what the probe below checks instead.
 */
const ROUTES: Array<{ file: string; method: Method; path: string; anonymous?: 'link' }> = [
  { file: 'auto-recharge.ts', method: 'GET', path: '/api/billing/auto-recharge' },
  { file: 'auto-recharge.ts', method: 'PUT', path: '/api/billing/auto-recharge' },
  { file: 'checkout/credits.ts', method: 'POST', path: '/api/billing/checkout/credits' },
  { file: 'checkout/status.ts', method: 'GET', path: '/api/billing/checkout/status' },
  { file: 'checkout/subscription.ts', method: 'POST', path: '/api/billing/checkout/subscription' },
  { file: 'contact.ts', method: 'GET', path: '/api/billing/contact' },
  { file: 'contact.ts', method: 'PUT', path: '/api/billing/contact' },
  { file: 'contact/verify.ts', method: 'GET', path: '/api/billing/contact/verify', anonymous: 'link' },
  { file: 'disputes.ts', method: 'GET', path: '/api/billing/disputes' },
  { file: 'portal.ts', method: 'POST', path: '/api/billing/portal' },
  { file: 'refunds.ts', method: 'POST', path: '/api/billing/refunds' },
  { file: 'subscription/cancel.ts', method: 'POST', path: '/api/billing/subscription/cancel' },
  { file: 'subscription/change.ts', method: 'POST', path: '/api/billing/subscription/change' },
  { file: 'subscription/preview.ts', method: 'POST', path: '/api/billing/subscription/preview' },
  { file: 'summary.ts', method: 'GET', path: '/api/billing/summary' },
]

const BILLING_ROUTE_DIR = 'src/routes/api/billing'

function listRouteFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return listRouteFiles(full, `${prefix}${entry}/`)
    return entry.endsWith('.ts') ? [`${prefix}${entry}`] : []
  })
}

test('every billing route file appears in the table', () => {
  const onDisk = listRouteFiles(BILLING_ROUTE_DIR).sort()
  const inTable = [...new Set(ROUTES.map((route) => route.file))].sort()
  expect(
    inTable,
    `billing route files with no authorization probe: ${onDisk.filter((f) => !inTable.includes(f)).join(', ')}`,
  ).toEqual(onDisk)
})

test.describe('no session', () => {
  for (const route of ROUTES.filter((candidate) => candidate.anonymous !== 'link')) {
    test(`${route.method} ${route.path} is refused`, async () => {
      /**
       * Every one of these either spends money, changes what will be charged, or reads what has been. There
       * is no read here harmless enough to leave open: `GET /api/billing/summary` is an organization's
       * financial position, and `GET /api/billing/disputes` says which of its charges were contested.
       */
      const response = await harness.anonymous.fetch(route.path, {
        method: route.method,
        ...(route.method === 'GET' ? {} : { data: {} }),
      })
      expect(
        [401, 403],
        `${route.method} ${route.path} answered ${response.status()} to an anonymous caller`,
      ).toContain(response.status())
    })
  }
})

test('the email verification link refuses a missing token without revealing a contact', async () => {
  // Not 401 — see the note on `anonymous: 'link'`. The property is that no token means no action and no
  // information: an error page, not a redirect that implies the link was good.
  const response = await harness.anonymous.get('/api/billing/contact/verify')
  const text = await response.text()
  // Not "contains no @" — that was this test's first version, and any HTML page contains one (`@media`
  // alone). The property is that a tokenless click neither verifies anything nor names anyone.
  expect(response.url(), 'a missing token must not land on the verified page').not.toContain(
    'billingContactVerified=1',
  )
  expect(text).not.toContain(harness.owner.userId!)
})

test.describe('a session with no active organization context', () => {
  for (const route of ROUTES) {
    test(`${route.method} ${route.path} never answers for an organization the caller did not name`, async () => {
      /**
       * Billing is organization-scoped, and the organization always comes from the principal — never from the
       * request. So the assertion is not a status code but an absence: whatever this route answers, it must
       * not be about somebody else's organization.
       *
       * A body naming another organization is included on purpose. It has no effect today; if it ever did,
       * this is where it would show up, and the failure would say so in one line.
       */
      const response = await harness.owner.api!.fetch(route.path, {
        method: route.method,
        ...(route.method === 'GET' ? {} : { data: { organizationId: 'org-not-mine' } }),
      })
      const text = await response.text()
      expect(text, 'a billing route echoed an organization from the request body').not.toContain(
        'org-not-mine',
      )
    })
  }
})
