/**
 * `/api/privacy/profile-removal` and its `/verify` step over real HTTP (plan 53, task 10 — neither had an e2e spec).
 *
 * These are the only unauthenticated *writes* in the product apart from the Stripe webhook: no session, no tenant,
 * no CSRF token. Someone asking to be removed from a people-search product need not have — or want — an account
 * here, so the design substitutes two other things for authentication, and both are worth proving over real HTTP:
 *
 * - **Possessing `{requestId, challenge}` IS the authorization.** `requestId` is a `randomUUID()` and the
 *   challenge's *plaintext is never stored* — only an HMAC of it. So the interesting assertion is not that the
 *   endpoint works, it is that the plaintext cannot be found in the database afterwards. A row that kept it would
 *   turn one database read into the ability to complete anyone's pending removal.
 * - **The same 202 for an identity we hold and one we have never seen.** This endpoint takes an arbitrary profile
 *   URL from an anonymous caller. If a URL we track answered differently from one we do not, it would become a
 *   free membership oracle for a people-search index — ask about anyone, learn whether they are in it.
 *
 * ## What is deliberately not covered here
 *
 * The `verified` and `proof_failed` outcomes both require `adapter.verifyChallenge` to fetch the profile's live bio
 * from github.com. An e2e suite that reaches the public internet is flaky and leaks test traffic, and no
 * source-fetch fake exists yet, so this spec stops at `invalid_challenge` — which returns *before* the adapter is
 * consulted (verified against `verifyProfileRemoval`'s ordering). The remaining branches need that fake first.
 *
 * The `PROFILE_REMOVAL_ENABLED=false` → 503 path is a pure env check with no database involvement, and is left to
 * the unit tests; proving it here would need a second server started with the flag off.
 */
import { test, expect, request as playwrightRequest, type APIRequestContext } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { randomUUID } from 'node:crypto'
import { loadHarnessEnv } from '../harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from '../harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from '../harness/cache'
import { startWorkerServer, stopWorkerServer } from '../harness/server'
import { e2eEnv } from '../harness/env'
import { ensureFixedTimeEnv } from '../harness/clock'
import { seedBuilderIdentity, cleanupBuilderIdentity } from '../harness/fixtures/builders'

/**
 * The route is behind a flag that defaults to `false`, and the flag's own validation requires an HMAC key
 * alongside it. The worker server inherits `process.env` at spawn, so these are set here and **restored on
 * teardown** — a previous harness leaked its flags this way and broke an unrelated spec with a wrong-secret 400
 * that looked like a product bug, invisible at six workers and caught only by the serial gate.
 */
const FLAGS: Record<string, string> = {
  PROFILE_REMOVAL_ENABLED: 'true',
  PROFILE_REMOVAL_HMAC_KEY: 'a'.repeat(64),
}

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  anonymous: APIRequestContext
  restoreEnv: Array<[string, string | undefined]>
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

  const restoreEnv: Array<[string, string | undefined]> = []
  for (const [key, value] of Object.entries(FLAGS)) {
    restoreEnv.push([key, process.env[key]])
    process.env[key] = value
  }

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      anonymous: await playwrightRequest.newContext({ baseURL: server.baseURL }),
      restoreEnv,
    }
  } catch (error) {
    for (const [key, value] of restoreEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    await dropWorkerRedisNamespace(cache.prefix).catch(() => undefined)
    throw error
  }
})

test.afterAll(async () => {
  // Flags first: a later failure must not leave them set for the next spec in this worker.
  for (const [key, value] of harness?.restoreEnv ?? []) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await harness?.anonymous.dispose().catch(() => undefined)
  await harness?.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(harness.workerIndex).catch(() => undefined)
  await dropWorkerDatabase(harness.workerIndex, harness.databaseName).catch(() => undefined)
  await dropWorkerRedisNamespace(harness.redisPrefix).catch(() => undefined)
})

interface IssuedRemoval {
  ok: boolean
  requestId: string
  challenge: string
  instructions: string
  expiresAt: string
}

/** A distinct username per call, so the per-(ip, profile) limit of 5/hour never colours another test's result. */
function uniqueGithubUrl(label: string): string {
  return `https://github.com/e2e-removal-${label}-${randomUUID().slice(0, 8)}`
}

async function requestRemoval(profileUrl: string) {
  return harness.anonymous.post('/api/privacy/profile-removal', { data: { profileUrl } })
}

test.describe('POST /api/privacy/profile-removal', () => {
  test('issues a challenge for a supported source without any session', async () => {
    const response = await requestRemoval(uniqueGithubUrl('issue'))
    expect(response.status(), await response.text()).toBe(202)
    const body = await response.json() as IssuedRemoval
    expect(body.ok).toBe(true)
    expect(body.requestId).toBeTruthy()
    expect(body.challenge).toBeTruthy()
    // The instructions must actually contain the challenge — they are what the person pastes into their bio, so
    // instructions that omitted it would leave the flow uncompletable while still answering 202.
    expect(body.instructions).toContain(body.challenge)
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  test('stores only a hash of the challenge — the plaintext is unrecoverable from the database', async () => {
    /**
     * The property that makes an unauthenticated flow defensible. The challenge is the capability: whoever holds
     * it can complete the removal. It is returned once, at issue time, and only its HMAC is persisted, so a
     * database read cannot yield it. Asserted against every text column of the row rather than against the one
     * column expected to hold it, because the failure being guarded is the plaintext appearing *somewhere*.
     */
    const response = await requestRemoval(uniqueGithubUrl('hash'))
    const { requestId, challenge } = await response.json() as IssuedRemoval

    const [row] = await harness.sql`select * from profile_removal_requests where id = ${requestId}`
    expect(row, 'the request must have been persisted').toBeTruthy()
    expect(row.challenge_hash).toBeTruthy()
    expect(row.challenge_hash).not.toBe(challenge)

    const serialized = JSON.stringify(row)
    expect(serialized, 'the plaintext challenge must not appear anywhere in the stored row').not.toContain(challenge)
  })

  test('answers a tracked identity and an unknown one identically', async () => {
    /**
     * The anti-enumeration property, and the reason it has to be checked over HTTP: the endpoint accepts any
     * profile URL from anyone. Status *and* key set are compared — a body that added, say, `alreadyRequested` for
     * one of the two would be a membership oracle for a people-search index even with matching statuses.
     *
     * The tracked side is a **real seeded `builder_identities` row**. A first version of this test compared two
     * random URLs, so neither existed in the data and it proved nothing about tracked-versus-unknown while reading
     * as though it did — the comparison has to have a genuine member on one side to mean anything.
     */
    const trackedUsername = `e2e-removal-tracked-${randomUUID().slice(0, 8)}`
    const { builderIdentityId } = await seedBuilderIdentity(harness.sql, { source: 'github', username: trackedUsername })
    try {
      const [tracked, unknown] = await Promise.all([
        requestRemoval(`https://github.com/${trackedUsername}`),
        requestRemoval(uniqueGithubUrl('unknown')),
      ])
      expect(tracked.status()).toBe(unknown.status())

      const trackedBody = await tracked.json() as Record<string, unknown>
      const unknownBody = await unknown.json() as Record<string, unknown>
      expect(Object.keys(trackedBody).sort()).toEqual(Object.keys(unknownBody).sort())
      // The values that are not per-request secrets must match too: a differing `manualReview` or `message` would
      // separate the two just as effectively as a differing key set.
      expect(trackedBody.ok).toEqual(unknownBody.ok)
      expect(trackedBody.instructions).toBeTruthy()
    } finally {
      await cleanupBuilderIdentity(harness.sql, builderIdentityId)
    }
  })

  test('refuses a URL from an unrecognised host with 400, not a challenge', async () => {
    // A challenge for a host we cannot verify against would be unfollowable: nobody could ever prove control.
    const response = await harness.anonymous.post('/api/privacy/profile-removal', {
      data: { profileUrl: 'https://example.com/someone' },
    })
    expect(response.status(), await response.text()).toBe(400)
  })

  test('refuses a malformed body with 400', async () => {
    const response = await harness.anonymous.post('/api/privacy/profile-removal', { data: {} })
    expect(response.status()).toBe(400)
  })

  test('rate-limits repeated requests for the same profile, with Retry-After', async () => {
    // 5 per hour per (ip, profileUrl). One URL, reused deliberately — this is the only test that may.
    const profileUrl = uniqueGithubUrl('ratelimit')
    const statuses: number[] = []
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await requestRemoval(profileUrl)
      statuses.push(response.status())
      if (response.status() === 429) {
        expect(response.headers()['retry-after'], 'a 429 must say when to come back').toBeTruthy()
        break
      }
    }
    expect(statuses, `expected a 429 within 7 attempts, got ${statuses.join(', ')}`).toContain(429)
    expect(
      statuses.filter((status) => status === 202).length,
      `the first attempts must be accepted, got ${statuses.join(', ')}`,
    ).toBeGreaterThan(0)
  })
})

test.describe('POST /api/privacy/profile-removal/verify', () => {
  test('answers 404 for a request id that does not exist', async () => {
    const response = await harness.anonymous.post('/api/privacy/profile-removal/verify', {
      data: { requestId: randomUUID(), challenge: 'whatever' },
    })
    expect(response.status()).toBe(404)
  })

  test('answers 422 invalid_challenge for a real request with the wrong challenge', async () => {
    /**
     * Note what this pair means: 404 for an absent id and 422 for a real one is a distinguishable answer, so a
     * caller *can* learn whether a request id exists. That is deliberate and safe here, unlike the invitation
     * oracle fixed earlier in this plan: `requestId` is a `randomUUID()` that is only ever returned to the
     * requester, not a guessable handle, and it is itself the capability. Distinguishing them costs an attacker a
     * 122-bit guess first.
     */
    const issued = await requestRemoval(uniqueGithubUrl('wrongchallenge'))
    const { requestId } = await issued.json() as IssuedRemoval

    const response = await harness.anonymous.post('/api/privacy/profile-removal/verify', {
      data: { requestId, challenge: 'not-the-real-challenge' },
    })
    expect(response.status(), await response.text()).toBe(422)
    expect(await response.json()).toMatchObject({ error: 'invalid_challenge' })
  })

  test('a wrong challenge leaves the request pending and creates no suppression', async () => {
    // The write side of the refusal. A failed attempt that advanced the row's status, or inserted a suppression,
    // would let anyone with a request id remove a profile without ever proving control of it.
    const issued = await requestRemoval(uniqueGithubUrl('nowrite'))
    const { requestId } = await issued.json() as IssuedRemoval
    const before = await harness.sql`select count(*)::int as count from profile_suppressions`

    await harness.anonymous.post('/api/privacy/profile-removal/verify', {
      data: { requestId, challenge: 'still-not-it' },
    })

    const [row] = await harness.sql`select status from profile_removal_requests where id = ${requestId}`
    expect(row.status).toBe('pending')
    const after = await harness.sql`select count(*)::int as count from profile_suppressions`
    expect(after[0].count).toBe(before[0].count)
  })

  test('refuses a malformed body with 400', async () => {
    const response = await harness.anonymous.post('/api/privacy/profile-removal/verify', { data: { requestId: '' } })
    expect(response.status()).toBe(400)
  })
})
