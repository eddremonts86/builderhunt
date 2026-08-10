import { test, expect, request as playwrightRequest, type APIRequestContext } from 'playwright/test'
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
import {
  createPlatformAdminPrincipal,
  registerPlatformAdminEnv,
  reservePlatformAdminSeed,
} from '../harness/fixtures/platform-admin'

/**
 * Plan 58, task 10 — enable, disable, re-enable and rollback, over real HTTP against a real database.
 *
 * The unit suites cover the resolver as a table and the window as arithmetic. What only a full round trip
 * can prove is the part that is about *state over time*: that the revision moves once per real
 * transition, that a stale screen is refused rather than allowed to overwrite, and that disabling is a
 * reversal rather than a deletion.
 */
interface Harness {
  workerIndex: number
  databaseName: string
  sql: Sql
  admin: Principal
  member: Principal
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

  // Reserved and registered before the server spawns: the allowlist is read from the environment by the
  // app process, so minting the principal afterwards is too late.
  const adminSeed = reservePlatformAdminSeed(`w${workerIndex}-betalifecycle`)
  registerPlatformAdminEnv(adminSeed)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}betalife` }
    const admin = await createPlatformAdminPrincipal(ctx, adminSeed)
    const owner = await createOwnerPrincipal(ctx, { tier: 'free', seatLimit: 1, clock: fixedClockFromEnv() })

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      sql,
      admin,
      member: owner.principal,
      anonymous: await playwrightRequest.newContext({ baseURL: server.baseURL }),
    }
  } catch (error) {
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerRedisNamespace(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    throw error
  }
})

test.afterAll(async () => {
  const h = harness
  if (!h) return
  await h.anonymous.dispose().catch(() => undefined)
  await disposePrincipal(h.admin).catch(() => undefined)
  await disposePrincipal(h.member).catch(() => undefined)
  await h.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(h.workerIndex)
  await dropWorkerRedisNamespace(h.workerIndex).catch(() => undefined)
  await dropWorkerDatabase(h.workerIndex, h.databaseName).catch(() => undefined)
})

async function readState() {
  const response = await harness.admin.api!.get('/api/admin/billing/beta-mode')
  expect(response.status(), await response.text()).toBe(200)
  return await response.json() as { enabled: boolean; revision: number; updatedBy: string | null }
}

async function write(enabled: boolean, expectedRevision: number) {
  return harness.admin.api!.put('/api/admin/billing/beta-mode', { data: { enabled, expectedRevision } })
}

test.describe('beta mode lifecycle', () => {
  test('ships seeded disabled at revision 0', async () => {
    // The rollout depends on this: schema and code land with the switch off, so raw and effective
    // entitlements can be compared in production before anything changes.
    const state = await readState()
    expect(state.enabled).toBe(false)
    expect(state.revision).toBe(0)
    expect(state.updatedBy).toBeNull()
  })

  test('a member is not told who changed it, or when', async () => {
    const response = await harness.member.api!.get('/api/beta-mode')
    expect(response.status()).toBe(200)
    expect(Object.keys(await response.json() as object).sort()).toEqual(['enabled', 'revision'])
  })

  test('a tenant owner cannot write it', async () => {
    // Being an organization owner is not being a platform admin. This is the refusal that matters most:
    // the write grants Pro Max to every organization in the system.
    const response = await harness.member.api!.put('/api/admin/billing/beta-mode', {
      data: { enabled: true, expectedRevision: 0 },
    })
    expect([401, 403], `answered ${response.status()}`).toContain(response.status())
    expect((await readState()).enabled).toBe(false)
  })

  test('enabling moves the revision exactly once and records the actor', async () => {
    const response = await write(true, 0)
    expect(response.status(), await response.text()).toBe(200)
    const state = await response.json() as { enabled: boolean; revision: number; updatedBy: string | null }
    expect(state.enabled).toBe(true)
    expect(state.revision).toBe(1)
    expect(state.updatedBy).toBe(harness.admin.userId)
  })

  test('a same-state write is an idempotent no-op that does not move the revision', async () => {
    // Otherwise two clicks on "enable" invalidate every other open admin screen for no change.
    const response = await write(true, 1)
    expect(response.status()).toBe(200)
    expect((await response.json() as { revision: number }).revision).toBe(1)
  })

  test('a stale revision is refused with 409 and the winning state', async () => {
    // The current document travels with the conflict so a stale screen can adopt reality in one round
    // trip. Without it, the only recovery is a refetch — and a screen that refetches on conflict can loop.
    const response = await write(false, 0)
    expect(response.status()).toBe(409)
    const body = await response.json() as { error: string; enabled: boolean; revision: number }
    expect(body.error).toBe('revision_conflict')
    expect(body.enabled).toBe(true)
    expect(body.revision).toBe(1)
    // And it changed nothing.
    expect((await readState()).enabled).toBe(true)
  })

  test('the audit trail records the transition, not the no-op', async () => {
    const rows = await harness.sql<{ action: string; target_id: string }[]>`
      select action, target_id from security_audit_events
      where target_type = 'platform_beta_mode'
      order by created_at asc
    `
    // One enable. The same-state write above must not have produced a second row — a trail full of
    // events describing nothing is a trail nobody reads.
    expect(rows.map((row) => row.action)).toEqual(['admin.billing.beta-mode.enable'])
    expect(rows[0]?.target_id).toBe('global')
  })

  test('the member badge state follows within the cache window', async () => {
    // Five seconds is the documented display lag. Authorization has none — it reads in-transaction.
    await expect.poll(
      async () => (await (await harness.member.api!.get('/api/beta-mode')).json() as { enabled: boolean }).enabled,
      { timeout: 15_000 },
    ).toBe(true)
  })

  test('disabling is a reversal, not a deletion: the row keeps its history', async () => {
    const response = await write(false, 1)
    expect(response.status(), await response.text()).toBe(200)
    const state = await response.json() as { enabled: boolean; revision: number; updatedBy: string | null }
    expect(state.enabled).toBe(false)
    expect(state.revision).toBe(2)
    // The actor and the revision survive, which is why no role holds DELETE: "disabled" and "never
    // configured" have to stay distinguishable.
    expect(state.updatedBy).toBe(harness.admin.userId)

    const [row] = await harness.sql<{ enabled: boolean; revision: number }[]>`
      select enabled, revision from platform_beta_mode where id = 'global'
    `
    expect(row?.enabled).toBe(false)
    expect(row?.revision).toBe(2)
  })

  test('re-enabling in the same window works from the current revision', async () => {
    const response = await write(true, 2)
    expect(response.status()).toBe(200)
    expect((await response.json() as { revision: number }).revision).toBe(3)

    const rows = await harness.sql<{ action: string }[]>`
      select action from security_audit_events
      where target_type = 'platform_beta_mode' order by created_at asc
    `
    expect(rows.map((row) => row.action)).toEqual([
      'admin.billing.beta-mode.enable',
      'admin.billing.beta-mode.disable',
      'admin.billing.beta-mode.enable',
    ])
  })

  test('the singleton is still a singleton', async () => {
    // The CHECK is what stops "the flag" from becoming "whichever row came back first".
    const rows = await harness.sql<{ count: string }[]>`select count(*)::text as count from platform_beta_mode`
    expect(rows[0]?.count).toBe('1')
  })
})
