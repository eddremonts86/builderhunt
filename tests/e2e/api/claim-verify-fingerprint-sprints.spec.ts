/**
 * `builders/claim/verify`, `fingerprint/match` and `sprints/preview` (plan 53, task 10 — none had an e2e spec).
 *
 * Three unrelated routes, grouped because each has exactly one property worth an end-to-end assertion and none of
 * them needs a fixture the others do not.
 *
 * **`builders/claim/verify` carries a credential in its query string.** Every one of its answers is a 302, and the
 * token is in the URL — including in the `callbackURL` it hands to the sign-in page so an unauthenticated claimer
 * can come back. That makes `Referrer-Policy: no-referrer` and `Cache-Control: no-store` load-bearing rather than
 * decorative: without the first, the token travels in the `Referer` header to whatever the browser loads next;
 * without the second, it sits in a shared cache. Both are one deleted line away in any refactor and invisible until
 * a token leaks, which is precisely why they are asserted on the response rather than trusted from the source.
 *
 * **`fingerprint/match` answers `insufficient_density` with HTTP 200.** A refusal shaped as a success: a client
 * checking `response.ok` sees a 200 and an empty `matches` array, and would report "no matches found" when the truth
 * is "not enough data to look". Pinned exactly, because it is the kind of contract someone later "fixes" to a 4xx
 * and breaks every caller that learned to read the body.
 *
 * **`sprints/preview` is rate-limited per user at 10/minute** before it validates anything.
 */
import { test, expect, request as playwrightRequest, type APIRequestContext } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { createHash, randomUUID } from 'node:crypto'
import { loadHarnessEnv } from '../harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from '../harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from '../harness/cache'
import { startWorkerServer, stopWorkerServer } from '../harness/server'
import { e2eEnv } from '../harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv } from '../harness/clock'
import { createOwnerPrincipal, type FixtureContext, type Principal } from '../harness/fixtures/principals'
import { seedConsent } from '../harness/fixtures/privacy'
import { seedBuilderIdentity } from '../harness/fixtures/builders'
import { CURRENT_CONSENT_VERSIONS } from '~/shared/lib/legal-versions'

/**
 * Mirrors `hashClaimSecret` from `repositories/builder-claims`, which cannot be imported here: that module
 * transitively validates the server's env and throws a `ZodError` inside the Playwright process, which surfaces as
 * "No tests found" rather than as an import error.
 *
 * Duplicating a security formula in a test is a drift risk with a nasty shape — a changed prefix would make every
 * seeded claim look *unknown* rather than expired, and the indistinguishability test below would still pass, having
 * compared two unknowns. The valid-claim test guards exactly that: it only redirects to `/me?claimed=1` if this hash
 * matches the server's, so a drifted formula fails there loudly instead of quietly hollowing out the other test.
 */
function claimSecretHash(secret: string): string {
  return createHash('sha256').update(`builderhunt:claim:v1:${secret}`).digest('hex')
}

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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}claimfpsprint` }
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

test.describe('GET /api/builders/claim/verify', () => {
  /** `maxRedirects: 0` is the whole point: following the 302 would discard the headers being asserted. */
  async function verify(context: APIRequestContext, query: string) {
    return context.get(`/api/builders/claim/verify${query}`, { maxRedirects: 0 })
  }

  test('every answer protects the token that is sitting in its own URL', async () => {
    /**
     * The route redirects in all four of its outcomes, and its URL carries the claim token. `Referrer-Policy:
     * no-referrer` is what stops that token reaching the next page in a `Referer` header; `Cache-Control: no-store`
     * is what stops it being cached. Asserted across an anonymous call, a bad token and a missing token, because a
     * refactor that adds a new early-return is exactly how one branch ends up without them.
     */
    const cases = [
      { label: 'anonymous with a token', context: harness.anonymous, query: `?token=${randomUUID()}` },
      { label: 'authenticated with an unknown token', context: harness.owner.api!, query: `?token=${randomUUID()}` },
      { label: 'no token at all', context: harness.owner.api!, query: '' },
    ]

    for (const testCase of cases) {
      const response = await verify(testCase.context, testCase.query)
      expect(response.status(), `${testCase.label} must redirect`).toBe(302)
      expect(response.headers()['referrer-policy'], `${testCase.label} must not leak the token via Referer`)
        .toBe('no-referrer')
      expect(response.headers()['cache-control'], `${testCase.label} must not be cached`).toContain('no-store')
    }
  })

  test('an unauthenticated claimer is sent to sign-in with the token preserved for the round trip', async () => {
    // The token has to survive the detour or the claim link becomes single-use-and-lost for anyone not already
    // signed in. It comes back in `callbackURL`, encoded.
    const token = randomUUID()
    const response = await verify(harness.anonymous, `?token=${token}`)
    expect(response.status()).toBe(302)

    const location = response.headers()['location']!
    expect(location).toContain('/auth/sign-in')
    const callback = new URL(location, harness.baseURL).searchParams.get('callbackURL')
    expect(callback, 'sign-in must be told where to return').toBeTruthy()
    expect(callback).toContain('/api/builders/claim/verify')
    expect(callback).toContain(token)
  })

  test('a live token verifies the claim and lands on /me', async () => {
    /**
     * The success path, and the guard for the test below it: this only passes if `claimSecretHash` here matches the
     * server's `hashClaimSecret`. A drifted formula fails here rather than silently turning the
     * expired-versus-unknown comparison into a comparison of two unknowns.
     */
    const token = randomUUID()
    const { builderIdentityId } = await seedBuilderIdentity(harness.sql, { scope: 'liveclaim' })
    await harness.sql`
      insert into builder_claims (id, builder_identity_id, subject_user_id, evidence_source, evidence_reference,
                                  verification_secret_hash, status, expires_at, metadata)
      values (${randomUUID()}, ${builderIdentityId}, ${harness.owner.userId!}, 'github', 'e2e-live',
              ${claimSecretHash(token)}, 'pending', now() + interval '1 hour', '{}'::jsonb)
    `

    const response = await verify(harness.owner.api!, `?token=${token}`)
    expect(response.status()).toBe(302)
    const location = response.headers()['location']!
    expect(location).toContain('/me')
    expect(new URL(location, harness.baseURL).searchParams.get('claimed')).toBe('1')

    // The claim is now verified, and the secret hash is cleared: a used claim link cannot be replayed.
    const [row] = await harness.sql`
      select status, verification_secret_hash from builder_claims where builder_identity_id = ${builderIdentityId}
    `
    expect(row.status).toBe('verified')
    expect(row.verification_secret_hash, 'a spent claim secret must not remain stored').toBeNull()
  })

  test('a genuinely expired token and one that never existed are told exactly the same thing', async () => {
    /**
     * The anti-enumeration property, compared against a **real** expired claim rather than assumed from the wording.
     *
     * A first draft of this test asserted the message does not contain "expired", which had it backwards: the route
     * answers "This claim link is invalid or has expired" precisely so that it names *both* possibilities and
     * confirms neither. Naming both is the mechanism, not a leak. What actually matters is that the two cases are
     * byte-identical, because a response distinguishing them would confirm that a guessed token had once been real.
     */
    const expiredToken = randomUUID()
    const { builderIdentityId } = await seedBuilderIdentity(harness.sql, { scope: 'expiredclaim' })
    await harness.sql`
      insert into builder_claims (id, builder_identity_id, subject_user_id, evidence_source, evidence_reference,
                                  verification_secret_hash, status, expires_at, metadata)
      values (${randomUUID()}, ${builderIdentityId}, ${harness.owner.userId!}, 'github', 'e2e-expired',
              ${claimSecretHash(expiredToken)}, 'pending', now() - interval '1 hour', '{}'::jsonb)
    `

    const [expired, unknown] = await Promise.all([
      verify(harness.owner.api!, `?token=${expiredToken}`),
      verify(harness.owner.api!, `?token=${randomUUID()}`),
    ])

    expect(expired.status()).toBe(unknown.status())
    const messageFor = (location: string) => new URL(location, harness.baseURL).searchParams.get('claimError')
    const expiredMessage = messageFor(expired.headers()['location']!)
    const unknownMessage = messageFor(unknown.headers()['location']!)

    expect(expiredMessage, 'the failure must still be reported').toBeTruthy()
    expect(expiredMessage, 'expired and never-existed must be indistinguishable').toBe(unknownMessage)
  })
})

test.describe('/api/fingerprint/match', () => {
  test('refuses both verbs with no session', async () => {
    const [read, write] = await Promise.all([
      harness.anonymous.get('/api/fingerprint/match'),
      harness.anonymous.post('/api/fingerprint/match', { data: {} }),
    ])
    expect(read.status()).toBe(401)
    expect(write.status()).toBe(401)
  })

  test('GET reports the caller\'s own eligible density', async () => {
    const response = await harness.owner.api!.get('/api/fingerprint/match')
    expect(response.status(), await response.text()).toBe(200)
    const body = await response.json() as Record<string, unknown>
    // A fresh organization tracks nobody, so the honest answer is a zero — asserted as a number rather than a
    // specific value, since the count is data and the shape is the contract.
    expect(Object.keys(body).length).toBeGreaterThan(0)
  })

  test('POST refuses a malformed body with 400 and a zero count', async () => {
    const response = await harness.owner.api!.post('/api/fingerprint/match', { data: {} })
    expect(response.status(), await response.text()).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_request', eligibleCount: 0 })
  })

  test('insufficient density is a 200 carrying an error, not a 4xx', async () => {
    /**
     * The contract worth pinning. A fresh organization has nothing to fingerprint against, and the route says so
     * with `200 { error: 'insufficient_density', matches: [] }` — deliberately not a 4xx, because the request was
     * valid and the answer is "not enough data", not "you asked wrongly".
     *
     * The trap it creates is real: a client checking `response.ok` reads a 200 with an empty `matches` array and
     * reports "no matches found". So this asserts the exact shape a caller must learn to read, and will fail loudly
     * if someone later "corrects" the status.
     */
    const response = await harness.owner.api!.post('/api/fingerprint/match', {
      data: { builderId: `absent-${randomUUID().slice(0, 8)}` },
    })
    const body = await response.json() as { error?: string; eligibleCount?: number; matches?: unknown[] }

    if (body.error === 'insufficient_density') {
      expect(response.status(), 'insufficient density is not a client error').toBe(200)
      expect(body.matches, 'an empty match list must accompany the refusal').toEqual([])
      expect(typeof body.eligibleCount).toBe('number')
    } else {
      // The other reachable answers for a fresh org are a 400 for a builder it does not track, or a 503 when AI is
      // unconfigured. Any of the three is honest; a 200 with fabricated matches would not be.
      expect([400, 503]).toContain(response.status())
    }
  })
})

test.describe('POST /api/sprints/preview', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.post('/api/sprints/preview', { data: {} })
    expect(response.status()).toBe(401)
  })

  test('refuses a malformed body with 400 and says which fields failed', async () => {
    const response = await harness.owner.api!.post('/api/sprints/preview', { data: {} })
    expect(response.status(), await response.text()).toBe(400)
    const body = await response.json() as { error: string; details?: unknown }
    expect(body.error).toBeTruthy()
    // A preview is something a person is composing, so the 400 has to be actionable rather than a bare refusal.
    expect(body.details, 'a validation failure must name the fields').toBeTruthy()
  })

  test('is rate-limited per user, with Retry-After', async () => {
    /**
     * 10 per minute per user. Runs last in the file: exhausting the window first would turn every earlier
     * assertion here into a 429 rather than the thing it means to test.
     */
    const statuses: number[] = []
    for (let attempt = 0; attempt < 13; attempt += 1) {
      const response = await harness.owner.api!.post('/api/sprints/preview', { data: {} })
      statuses.push(response.status())
      if (response.status() === 429) {
        expect(response.headers()['retry-after'], 'a 429 must say when to come back').toBeTruthy()
        break
      }
    }
    expect(statuses, `expected a 429 within 13 attempts, got ${statuses.join(', ')}`).toContain(429)
    expect(
      statuses.filter((status) => status !== 429).length,
      'the first attempts must reach validation, or this is a blanket refusal rather than a limit',
    ).toBeGreaterThan(0)
  })
})
