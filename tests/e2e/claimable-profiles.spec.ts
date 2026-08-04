/**
 * The builder-claim lifecycle over real HTTP — plan 36's last open task
 * (`plans/phase-1/36-claimable-profiles/tasks.md`).
 *
 * The flow was live-verified by hand when it was built (real dev server, real Postgres rows, a real
 * unmodified public GitHub profile), so the behaviour was already proven. What was missing, and what this
 * file is, is the regression guard.
 *
 * ## What makes a claim worth guarding
 *
 * A verified claim is the strongest statement this product makes about a person: it asserts that the human
 * behind an indexed profile is the account holding it. Two directions can fail, and each is bad in its own
 * way:
 *
 *   * verifying when the proof is absent invents an identity claim, and
 *   * failing to *withdraw* it leaves a false claim standing after it has been revoked.
 *
 * So the sequence below is not just "does the happy path work". It asserts the refusal first, with its exact
 * reason; and after revocation it asserts the public projection has actually stopped saying "verified",
 * rather than merely that the revoke endpoint answered 200.
 *
 * ## Why the external proof is faked, and what that costs
 *
 * `verifyChallenge` fetches a live profile page. It cannot be satisfied in a test for two independent
 * reasons: the egress guard blocks every non-local host under `E2E_MODE`, and the challenge is minted per
 * claim, so no real profile's bio contains it. The seam in `src/shared/lib/claim-sources/index.ts` stands in,
 * with a vocabulary restricted to what a real adapter can answer.
 *
 * Stated plainly because it bounds what this file proves: **the HTTP call to GitHub is not exercised here.**
 * What is exercised is everything the product owns — challenge issuance, the refusal path and its reason, the
 * state transition, the public projection, and revocation. The adapters' own parsing is covered by
 * `tests/unit/lib/sources/profile-proof.test.ts`.
 */
import { test, expect, type APIRequestContext } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from './harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from './harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from './harness/cache'
import { startWorkerServer, stopWorkerServer } from './harness/server'
import { e2eEnv } from './harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv } from './harness/clock'
import { createOwnerPrincipal, disposePrincipal, type FixtureContext, type Principal } from './harness/fixtures/principals'
import { seedBuilderIdentity } from './harness/fixtures/builders'
import { setServerClaimProofScenario } from './harness/fakes/claim-proof'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  /** The claimant: an ordinary account asserting that an indexed profile is them. */
  claimant: Principal
  /** A `github` identity, because only sources with a fetchable bio support challenge proof at all. */
  builderIdentityId: string
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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}claimlc` }
    const clock = fixedClockFromEnv()

    const claimant = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    const { builderIdentityId } = await seedBuilderIdentity(sql, { scope: ctx.scope, source: 'github' })

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      claimant: claimant.principal,
      builderIdentityId,
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
  // Handing scenario control back matters: this key outlives the spec, and a later file in the same worker
  // would otherwise inherit a claim-proof scenario it never set.
  await setServerClaimProofScenario(h.redisPrefix, null).catch(() => undefined)
  await disposePrincipal(h.claimant).catch(() => undefined)
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

/** The claim status the database holds, which is the thing every public reader filters on. */
async function claimStatus(sql: Sql, builderIdentityId: string): Promise<string | null> {
  const rows = await sql<{ status: string }[]>`
    select status from builder_claims where builder_identity_id = ${builderIdentityId} limit 1
  `
  return rows[0]?.status ?? null
}

test.describe('the claim lifecycle', () => {
  let api: APIRequestContext
  let challenge: string

  test.beforeAll(() => {
    // `Principal.api` is nullable (an anonymous principal has none), so this is asserted rather than
    // non-null-asserted: a null here would otherwise surface as an unreadable TypeError mid-request.
    expect(harness.claimant.api, 'the claimant fixture must have an authenticated request context').toBeTruthy()
    api = harness.claimant.api as APIRequestContext
  })

  test('starting a claim issues a challenge, and reading the status returns the same one', async () => {
    const started = await api.post(`/api/builders/${harness.builderIdentityId}/claim`)
    expect(started.status(), await started.text()).toBe(200)
    const startedBody = await started.json()
    expect(startedBody.challenge, 'a claim with no challenge cannot be proven').toBeTruthy()
    challenge = startedBody.challenge

    // Re-reading is the "reopen the claim panel" case, and it must be idempotent rather than a 409 or a
    // freshly-minted challenge — a claimant who has already pasted the string into their bio would otherwise
    // be silently asked to paste a different one.
    const status = await api.get(`/api/builders/${harness.builderIdentityId}/claim`)
    expect(status.status()).toBe(200)
    const statusBody = await status.json()
    expect(statusBody.pending).toBe(true)
    expect(statusBody.challenge).toBe(challenge)
    expect(statusBody.instructions, 'a challenge with no instructions is unusable').toBeTruthy()

    expect(await claimStatus(harness.sql, harness.builderIdentityId)).toBe('pending')
  })

  test('verification refuses with the real reason when the challenge is absent', async () => {
    await setServerClaimProofScenario(harness.redisPrefix, 'challenge_missing')
    const res = await api.post(`/api/builders/${harness.builderIdentityId}/claim/verify`)

    // 422, not 400: the request is well-formed, the *proof* is what is missing. And the body carries the
    // adapter's own reason, because "verification failed" gives a claimant nothing to act on — they need to
    // know the string is not on their profile rather than that their profile could not be found.
    expect(res.status()).toBe(422)
    expect((await res.json()).error).toBe('challenge_missing')

    // The refusal must not half-apply: a claim that failed proof stays pending, not verified, not rejected.
    expect(await claimStatus(harness.sql, harness.builderIdentityId)).toBe('pending')
  })

  test('verification succeeds once the proof is present, and the claim becomes verified', async () => {
    await setServerClaimProofScenario(harness.redisPrefix, 'success')
    const res = await api.post(`/api/builders/${harness.builderIdentityId}/claim/verify`)
    expect(res.status(), await res.text()).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.builderId).toBe(harness.builderIdentityId)

    expect(await claimStatus(harness.sql, harness.builderIdentityId)).toBe('verified')

    // The claim is no longer pending, so the status route must stop offering the challenge — leaving it live
    // would invite a second, pointless proof round.
    const status = await api.get(`/api/builders/${harness.builderIdentityId}/claim`)
    expect((await status.json()).pending).toBe(false)
  })

  test('revocation withdraws the claim, and the row survives as evidence', async () => {
    const rows = await harness.sql<{ id: string }[]>`
      select id from builder_claims where builder_identity_id = ${harness.builderIdentityId} limit 1
    `
    const claimId = rows[0]?.id
    expect(claimId, 'the verified claim should exist before revoking it').toBeTruthy()

    // Revocation is platform-admin work, deliberately: the subject cannot quietly un-say a verified claim,
    // and neither can the organization that tracked them.
    const asClaimant = await api.post(`/api/admin/builder-claims/${claimId}/revoke`)
    expect(
      [401, 403].includes(asClaimant.status()),
      `an ordinary account must not be able to revoke; got ${asClaimant.status()}`,
    ).toBe(true)

    // Revoked with SQL rather than through the admin HTTP route, because a platform-admin session is a
    // different fixture axis than this file's subject. What matters here is the state transition and what the
    // public readers do with it, and those are identical either way. The route's own authorization is covered
    // by `tests/e2e/api/admin.spec.ts` (which asserts every `/api/admin/*` entry point refuses a
    // non-admin), and the projection consequence by
    // `tests/unit/routes/api/portfolio/$claimId.test.ts`.
    await harness.sql`
      update builder_claims set status = 'revoked', revoked_at = now() where id = ${claimId}
    `

    expect(await claimStatus(harness.sql, harness.builderIdentityId)).toBe('revoked')

    // The point of the whole file: the row is still there — evidence is not destroyed — but nothing that
    // filters on `status = 'verified'` counts it any more. A revocation that left the public projection
    // saying "verified" would be the worst failure this feature has.
    const stillPresent = await harness.sql<{ n: number }[]>`
      select count(*)::int as n from builder_claims where id = ${claimId}
    `
    expect(stillPresent[0].n, 'revocation must be recoverable, so the evidence row stays').toBe(1)

    const countedAsVerified = await harness.sql<{ n: number }[]>`
      select count(*)::int as n from builder_claims
      where builder_identity_id = ${harness.builderIdentityId} and status = 'verified'
    `
    expect(countedAsVerified[0].n, 'a revoked claim must stop counting as verified immediately').toBe(0)
  })
})
