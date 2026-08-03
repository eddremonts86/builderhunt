/**
 * `POST` / `DELETE /api/calendar/availability/overrides` (plan 53, task 10 — the route had no e2e spec).
 *
 * A single-date override is how someone says "blocked all day on the 14th" or "only 14:00–16:00 on the 15th", and
 * the route's doc comment stakes its correctness on one claim:
 *
 * > Both verbs carry the policy `version` and route through the same versioned write as a full PUT. A bare insert
 * > or delete would leave the version untouched, so a client holding the previous version would keep believing its
 * > copy was current — every change to the policy has to advance it, not only wholesale replacements.
 *
 * That is an optimistic-concurrency claim, and it is invisible in review: a bare `insert` and a versioned write
 * look equally correct and both return the saved override. What separates them is whether the version moved, and
 * whether a second writer holding the old number is then refused. Both are asserted here against the real
 * database, which is also why this is not a unit test — the version lives in a row, and the refusal is a 409 that
 * only the real write path produces.
 *
 * The interesting failure is not a crash. It is two people editing the same availability policy where the second
 * silently overwrites the first because nothing told them their copy was stale.
 */
import { test, expect, request as playwrightRequest, type APIRequestContext } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from '../harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from '../harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from '../harness/cache'
import { startWorkerServer, stopWorkerServer } from '../harness/server'
import { e2eEnv } from '../harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv } from '../harness/clock'
import { createOwnerPrincipal, type FixtureContext, type Principal } from '../harness/fixtures/principals'
import { seedConsent } from '../harness/fixtures/privacy'
import { CURRENT_CONSENT_VERSIONS } from '~/shared/lib/legal-versions'

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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}calavail` }
    const clock = fixedClockFromEnv()

    const { principal: owner } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    await seedConsent(sql, { userId: owner.userId!, document: 'tos', version: CURRENT_CONSENT_VERSIONS.tos, acceptedAt: clock.now() })

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      owner,
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
  await harness?.anonymous.dispose().catch(() => undefined)
  await harness?.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(harness.workerIndex).catch(() => undefined)
  await dropWorkerDatabase(harness.workerIndex, harness.databaseName).catch(() => undefined)
  await dropWorkerRedisNamespace(harness.redisPrefix).catch(() => undefined)
})

interface AvailabilityPolicy {
  version: number
  overrides: Array<{ localDate: string; kind: string; localStart: string | null; localEnd: string | null }>
  rules: unknown[]
}

/**
 * A valid override body. The schema is `.strict()` and cross-validated: `blocked` requires both times to be null,
 * `available` requires `localEnd > localStart`. Spelled out here rather than guessed — the first version of this
 * spec invented a `{ blocked: true }` shape and got a 400 listing five separate field errors.
 */
function blockedOverride(localDate: string) {
  return { localDate, localStart: null, localEnd: null, kind: 'blocked', timeZone: 'Europe/Madrid' }
}

function availableOverride(localDate: string, localStart: string, localEnd: string) {
  return { localDate, localStart, localEnd, kind: 'available', timeZone: 'Europe/Madrid' }
}

/** The current policy, which is also where the caller learns the `version` its next write must carry. */
async function readPolicy(): Promise<AvailabilityPolicy> {
  const response = await harness.owner.api!.get('/api/calendar/availability')
  expect(response.status(), await response.text()).toBe(200)
  return response.json() as Promise<AvailabilityPolicy>
}

test.describe('POST /api/calendar/availability/overrides', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.post('/api/calendar/availability/overrides', {
      data: { version: 1, override: blockedOverride('2026-08-14') },
    })
    expect(response.status()).toBe(401)
  })

  test('adds the override and advances the policy version', async () => {
    /**
     * The doc's central claim. A bare insert would return the same saved override while leaving `version` where it
     * was, and every client holding that number would go on believing its copy was current.
     */
    const before = await readPolicy()
    const response = await harness.owner.api!.post('/api/calendar/availability/overrides', {
      data: { version: before.version, override: blockedOverride('2026-08-14') },
    })
    expect(response.status(), await response.text()).toBe(200)
    const after = await response.json() as AvailabilityPolicy

    expect(after.version, 'adding an override must advance the version, not only a full PUT').toBeGreaterThan(before.version)
    expect(after.overrides.map((entry) => entry.localDate)).toContain('2026-08-14')
  })

  test('refuses a stale version with 409 and changes nothing', async () => {
    /**
     * The other half: advancing the version is only useful if the old one is then rejected. This is the
     * lost-update case — two people editing one availability policy, where without this the second write silently
     * discards the first.
     */
    /**
     * Makes its own stale version rather than relying on an earlier test having written first. The initial policy is
     * version 1, so `version - 1` is 0 and fails the schema's `positive()` — a first draft of this test depended on
     * file ordering and, run alone with `--grep`, failed on its own precondition instead of on the 409.
     */
    const seed = await readPolicy()
    const seeded = await harness.owner.api!.post('/api/calendar/availability/overrides', {
      data: { version: seed.version, override: blockedOverride('2026-08-19') },
    })
    expect(seeded.status(), await seeded.text()).toBe(200)

    const current = await readPolicy()
    const staleVersion = current.version - 1
    expect(staleVersion, 'the seeding write above must have moved the version past 1').toBeGreaterThan(0)

    const response = await harness.owner.api!.post('/api/calendar/availability/overrides', {
      data: { version: staleVersion, override: blockedOverride('2026-08-20') },
    })
    expect(response.status(), await response.text()).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'state_changed' })

    const unchanged = await readPolicy()
    expect(unchanged.version, 'a refused write must not advance the version either').toBe(current.version)
    expect(unchanged.overrides.map((entry) => entry.localDate)).not.toContain('2026-08-20')
  })

  test('a second override for the same date replaces the first rather than duplicating it', async () => {
    // Documented on the route: "blocked all day" and "available 14:00-16:00" on one date cannot both be true.
    const before = await readPolicy()
    const response = await harness.owner.api!.post('/api/calendar/availability/overrides', {
      data: { version: before.version, override: availableOverride('2026-08-14', '14:00', '16:00') },
    })
    expect(response.status(), await response.text()).toBe(200)
    const after = await response.json() as AvailabilityPolicy

    const forThatDate = after.overrides.filter((entry) => entry.localDate === '2026-08-14')
    expect(forThatDate, 'one override per local date').toHaveLength(1)
    expect(forThatDate[0]!.kind, 'the replacement must be the available window, not the earlier block').toBe('available')
  })

  test('refuses an unknown extra field — the body schema is strict', async () => {
    const current = await readPolicy()
    const response = await harness.owner.api!.post('/api/calendar/availability/overrides', {
      data: { version: current.version, override: blockedOverride('2026-08-21'), unexpected: true },
    })
    expect(response.status(), await response.text()).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_input' })
  })
})

test.describe('DELETE /api/calendar/availability/overrides', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.fetch('/api/calendar/availability/overrides', {
      method: 'DELETE',
      data: { version: 1, localDate: '2026-08-14' },
    })
    expect(response.status()).toBe(401)
  })

  test('removes the override and advances the version too', async () => {
    // The delete side of the same claim: a bare delete would leave the version untouched just as a bare insert
    // would, and the route routes both through the versioned write for exactly that reason.
    const before = await readPolicy()
    expect(before.overrides.map((entry) => entry.localDate)).toContain('2026-08-14')

    const response = await harness.owner.api!.fetch('/api/calendar/availability/overrides', {
      method: 'DELETE',
      data: { version: before.version, localDate: '2026-08-14' },
    })
    expect(response.status(), await response.text()).toBe(200)
    const after = await response.json() as AvailabilityPolicy

    expect(after.version).toBeGreaterThan(before.version)
    expect(after.overrides.map((entry) => entry.localDate)).not.toContain('2026-08-14')
  })

  test('refuses a malformed local date with 400', async () => {
    const current = await readPolicy()
    const response = await harness.owner.api!.fetch('/api/calendar/availability/overrides', {
      method: 'DELETE',
      data: { version: current.version, localDate: '14-08-2026' },
    })
    expect(response.status(), await response.text()).toBe(400)
  })
})
