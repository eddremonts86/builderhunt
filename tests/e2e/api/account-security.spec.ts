/**
 * `/api/me/sessions` and `/api/me/stepup` over real HTTP (plan 53, task 10 — both routes had no e2e spec).
 *
 * These are the two account-security endpoints, and each has one property that only a real request can prove:
 *
 * - **`/api/me/sessions` returns raw session tokens.** By design: the browser revokes a session by handing the
 *   token back to better-auth's own `revokeSession`. That makes the response the single most dangerous payload in
 *   the account surface, and makes the boundary worth asserting directly — a second signed-in user's session must
 *   not appear in it, by id or by token. A unit test cannot establish this: it would need two real sessions.
 * - **A failed step-up must not set the cookie.** `bh_stepup` is what a future `requireStepUp` guard trusts. An
 *   incorrect password answering 401 while still setting the cookie would be a silent bypass — the status looks
 *   like a refusal and the side effect is a grant. Asserted on the response headers, not on a return value.
 *
 * Both routes authenticate before doing anything else, which `pnpm security:auth-before-validate` now enforces
 * statically; the assertions here pin the status an anonymous caller actually receives.
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
import { createOwnerPrincipal, createVerifiedPrincipal, type FixtureContext, type Principal } from '../harness/fixtures/principals'
import { seedConsent } from '../harness/fixtures/privacy'
import { CURRENT_CONSENT_VERSIONS } from '~/shared/lib/legal-versions'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  a: Principal
  b: Principal
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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}acctsec` }
    const clock = fixedClockFromEnv()

    const { principal: a } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    const b = await createVerifiedPrincipal(ctx, 'other')
    await seedConsent(sql, { userId: a.userId!, document: 'tos', version: CURRENT_CONSENT_VERSIONS.tos, acceptedAt: clock.now() })
    await seedConsent(sql, { userId: b.userId!, document: 'tos', version: CURRENT_CONSENT_VERSIONS.tos, acceptedAt: clock.now() })

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      a,
      b,
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

interface SessionRow {
  id: string
  token: string
  isCurrent: boolean
  createdAt: string
  lastActiveAt: string
  uaFamily: string | null
  trustState: string | null
  isNewDevice: boolean | null
  country: string | null
}

test.describe('GET /api/me/sessions', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.get('/api/me/sessions')
    expect(response.status()).toBe(401)
  })

  test('lists the caller\'s own sessions with exactly one marked current', async () => {
    const response = await harness.a.api!.get('/api/me/sessions')
    expect(response.status(), await response.text()).toBe(200)
    const rows = await response.json() as SessionRow[]

    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    // Exactly one, not "at least one": two rows claiming to be the current session would make the
    // "sign out everywhere else" control ambiguous about which one it is about to keep.
    expect(rows.filter((row) => row.isCurrent)).toHaveLength(1)
  })

  test('never returns another signed-in user\'s session, by id or by token', async () => {
    /**
     * The boundary that matters here, and the reason this is an e2e test rather than a unit one: it needs two
     * genuinely authenticated users. The payload deliberately carries raw session tokens so the browser can hand
     * one back to better-auth's `revokeSession`, so a leak across accounts is not a disclosure of metadata — it is
     * a handover of the other account.
     */
    const [aResponse, bResponse] = await Promise.all([
      harness.a.api!.get('/api/me/sessions'),
      harness.b.api!.get('/api/me/sessions'),
    ])
    const aRows = await aResponse.json() as SessionRow[]
    const bRows = await bResponse.json() as SessionRow[]

    // Without this, an empty B list makes the loop below a no-op and the test passes having compared nothing.
    expect(bRows.length, 'B must have a session for this comparison to mean anything').toBeGreaterThan(0)
    expect(aRows.length, 'A must have a session for this comparison to mean anything').toBeGreaterThan(0)

    const aIds = new Set(aRows.map((row) => row.id))
    const aTokens = new Set(aRows.map((row) => row.token))
    for (const row of bRows) {
      expect(aIds.has(row.id), 'B\'s session id appeared in A\'s list').toBe(false)
      expect(aTokens.has(row.token), 'B\'s session token appeared in A\'s list').toBe(false)
    }
  })

  test('reports country as an explicit null rather than omitting it', async () => {
    // No ASN/geo capability exists yet, and the route says so with a null field instead of dropping it. A missing
    // key would read to a client as "unknown shape"; an explicit null reads as "known, not available".
    const response = await harness.a.api!.get('/api/me/sessions')
    const [row] = await response.json() as SessionRow[]
    expect(row).toHaveProperty('country')
    expect(row.country).toBeNull()
  })
})

test.describe('GET /api/me/stepup', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.get('/api/me/stepup')
    expect(response.status()).toBe(401)
  })

  test('reports the caller\'s enforcement stage and whether a challenge is owed', async () => {
    const response = await harness.a.api!.get('/api/me/stepup')
    expect(response.status(), await response.text()).toBe(200)
    const body = await response.json() as { stage: string; requiresStepUp: boolean }
    expect(typeof body.stage).toBe('string')
    // A clean account owes no challenge. Asserted as a boolean rather than a specific stage name, since the stage
    // vocabulary belongs to the enforcement module and is covered against that module directly.
    expect(body.requiresStepUp).toBe(false)
  })
})

test.describe('POST /api/me/stepup', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.post('/api/me/stepup', { data: { password: 'irrelevant' } })
    expect(response.status()).toBe(401)
  })

  test('refuses an empty body with 400 once the caller is known', async () => {
    const response = await harness.a.api!.post('/api/me/stepup', { data: {} })
    expect(response.status(), await response.text()).toBe(400)
  })

  test('an incorrect password is refused and sets no step-up cookie', async () => {
    /**
     * The silent-bypass case. `bh_stepup` is what `requireStepUp` trusts, so a 401 that still sets the cookie
     * would look like a refusal in every log and grant the thing being refused. Asserted on the response headers
     * because that is where the grant would live.
     */
    const response = await harness.b.api!.post('/api/me/stepup', { data: { password: 'definitely-not-the-password' } })
    expect(response.status()).toBe(401)
    const setCookie = response.headersArray().filter((header) => header.name.toLowerCase() === 'set-cookie')
    expect(setCookie.map((header) => header.value).join('; ')).not.toContain('bh_stepup')
  })

  test('the correct password verifies and sets the step-up cookie', async () => {
    expect(harness.b.password, 'this principal needs real credentials to verify against').toBeTruthy()
    const response = await harness.b.api!.post('/api/me/stepup', { data: { password: harness.b.password } })
    expect(response.status(), await response.text()).toBe(200)
    expect(await response.json()).toMatchObject({ verified: true })

    const setCookie = response.headersArray()
      .filter((header) => header.name.toLowerCase() === 'set-cookie')
      .map((header) => header.value)
      .join('; ')
    expect(setCookie).toContain('bh_stepup')
    // The cookie is the guard's whole basis, so it must not be readable from script or sent cross-site.
    expect(setCookie.toLowerCase()).toContain('httponly')
  })

  test('repeated attempts are rate-limited per user, with Retry-After', async () => {
    /**
     * Runs last, and against a principal the other tests are done with: the limit is 5 per 300s per user, so
     * exhausting it would make every later step-up assertion for that user a 429 rather than the thing it means
     * to test. Ordering is enforced by `test.describe.configure({ mode: 'serial' })` at the top of the file.
     */
    const attempts: number[] = []
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await harness.a.api!.post('/api/me/stepup', { data: { password: 'wrong-on-purpose' } })
      attempts.push(response.status())
      if (response.status() === 429) {
        expect(response.headers()['retry-after'], 'a 429 must say when to come back').toBeTruthy()
        break
      }
    }
    expect(attempts, `expected a 429 within 7 attempts, got ${attempts.join(', ')}`).toContain(429)
    // And that the limit is a limit, not a blanket refusal: some attempts must have been let through to the
    // password check first. A route that answered 429 to everything would satisfy the assertion above.
    expect(
      attempts.filter((status) => status !== 429).length,
      `the first attempts must reach the password check, got ${attempts.join(', ')}`,
    ).toBeGreaterThan(0)
  })
})
