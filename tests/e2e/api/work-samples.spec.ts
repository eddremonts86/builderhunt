/**
 * The three `/api/work-samples` routes over real HTTP (plan 53, task 10 — none had an e2e spec).
 *
 * These are scoped **per user**, not per organization: `listWorkSampleAnalyses` and `deleteWorkSampleAnalysis` both
 * filter on `principal.userId`. That makes the boundary here different from every other tenant route in the suite,
 * and it is the reason a unit test is not enough — a unit test connects as the migration superuser and would see
 * both users' rows regardless of whether the filter or the RLS policy did any work.
 *
 * Two properties carry these routes:
 *
 * - **Another user's analysis id answers 404, not 403.** The ids are the only handle on someone else's saved work,
 *   so a 403 for a real id and 404 for a fabricated one would confirm which ids exist. Answering 404 to both means
 *   the distinction is not observable.
 * - **`analyze` refuses before doing any AI work.** A `pro` organization's daily allowance for this task is zero,
 *   so the entitlement gate answers `429 { error: 'plan' }` — and nothing is persisted. An empty-but-successful
 *   analysis presented as a real assessment of someone's work would be far worse than a refusal.
 *
 * ## Where the coverage stops, and a warning about extending it
 *
 * This spec was first written expecting `503 unavailable` from the missing-credentials branch. That was wrong:
 * `.env` supplies `MINIMAX_API_KEY` and `GITHUB_TOKEN`, so every e2e worker has them and the 503 branch is
 * unreachable here. What is actually reached is the plan gate, one step further down.
 *
 * **That gate is the only thing standing between this suite and a real MiniMax + GitHub call.** Raising the
 * fixture's tier to get past it would make every run of this spec bill a provider and depend on github.com being
 * up — slow, chargeable and flaky. The freshness cache, the 3-per-hour rate limit and the success shape all live
 * past that point, and they want an AI provider fake first. Do not reach them by widening the entitlement.
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
import { ensureFixedTimeEnv, fixedClockFromEnv } from '../harness/clock'
import { createOwnerPrincipal, type FixtureContext, type Principal } from '../harness/fixtures/principals'
import { seedConsent } from '../harness/fixtures/privacy'
import { seedBuilderIdentity, cleanupBuilderIdentity } from '../harness/fixtures/builders'
import { CURRENT_CONSENT_VERSIONS } from '~/shared/lib/legal-versions'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  a: Principal
  b: Principal
  builderIdentityId: string
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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}worksamples` }
    const clock = fixedClockFromEnv()

    const { principal: a } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    const { principal: b } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    for (const principal of [a, b]) {
      await seedConsent(sql, { userId: principal.userId!, document: 'tos', version: CURRENT_CONSENT_VERSIONS.tos, acceptedAt: clock.now() })
    }
    const { builderIdentityId } = await seedBuilderIdentity(sql, { scope: ctx.scope })

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      a,
      b,
      builderIdentityId,
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
  if (harness?.builderIdentityId) {
    await harness.sql`delete from work_sample_analyses where builder_identity_id = ${harness.builderIdentityId}`.catch(() => undefined)
    await cleanupBuilderIdentity(harness.sql, harness.builderIdentityId).catch(() => undefined)
  }
  await harness?.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(harness.workerIndex).catch(() => undefined)
  await dropWorkerDatabase(harness.workerIndex, harness.databaseName).catch(() => undefined)
  await dropWorkerRedisNamespace(harness.redisPrefix).catch(() => undefined)
})

/**
 * Inserts an analysis row directly. The write path is `analyze`, which cannot run here without provider
 * credentials — so the read and delete routes are exercised against seeded rows rather than left uncovered
 * because their producer is unreachable.
 */
async function seedAnalysis(userId: string, label: string): Promise<{ id: string; sampleUrl: string }> {
  const id = randomUUID()
  const sampleUrl = `https://github.com/e2e/${label}-${randomUUID().slice(0, 8)}`
  await harness.sql`
    insert into work_sample_analyses (id, user_id, builder_identity_id, sample_url, sample_type, analysis)
    values (${id}, ${userId}, ${harness.builderIdentityId}, ${sampleUrl}, 'repo',
            ${harness.sql.json({ analyzedAt: new Date().toISOString(), summary: `seeded ${label}` })})
  `
  return { id, sampleUrl }
}

test.describe('GET /api/work-samples', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.get('/api/work-samples')
    expect(response.status()).toBe(401)
  })

  test('lists the caller\'s own analyses and never another user\'s', async () => {
    const mine = await seedAnalysis(harness.a.userId!, 'mine')
    const theirs = await seedAnalysis(harness.b.userId!, 'theirs')

    const response = await harness.a.api!.get('/api/work-samples')
    expect(response.status(), await response.text()).toBe(200)
    const rows = await response.json() as Array<{ id: string; sampleUrl: string }>
    const ids = rows.map((row) => row.id)

    // Seeing my own row is what makes the absence of theirs evidence of scoping rather than of an empty table.
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(theirs.id)
  })

  test('filters by builderId without widening to another user\'s rows', async () => {
    const theirs = await seedAnalysis(harness.b.userId!, 'filtered')
    // Both users' rows hang off the same builder identity, so a filter that forgot the user scope would return
    // theirs too. That is the whole point of passing the shared id.
    const response = await harness.a.api!.get(`/api/work-samples?builderId=${harness.builderIdentityId}`)
    expect(response.status(), await response.text()).toBe(200)
    const ids = (await response.json() as Array<{ id: string }>).map((row) => row.id)
    expect(ids).not.toContain(theirs.id)
  })
})

test.describe('DELETE /api/work-samples/$id', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.delete(`/api/work-samples/${randomUUID()}`)
    expect(response.status()).toBe(401)
  })

  test('deletes the caller\'s own analysis', async () => {
    const mine = await seedAnalysis(harness.a.userId!, 'deletable')
    const response = await harness.a.api!.delete(`/api/work-samples/${mine.id}`)
    expect(response.status(), await response.text()).toBe(200)
    expect(await response.json()).toMatchObject({ success: true })

    const rows = await harness.sql`select id from work_sample_analyses where id = ${mine.id}`
    expect(rows).toHaveLength(0)
  })

  test('answers 404 for another user\'s analysis, and leaves it intact', async () => {
    /**
     * 404 rather than 403 is the point. These ids are the only handle on someone else's saved work, so a 403 for a
     * real id against a 404 for a fabricated one would confirm which ids exist. The row surviving is the other
     * half — a refusal that still deleted would be worse than a leak.
     */
    const theirs = await seedAnalysis(harness.b.userId!, 'protected')
    const response = await harness.a.api!.delete(`/api/work-samples/${theirs.id}`)
    expect(response.status(), await response.text()).toBe(404)

    const rows = await harness.sql`select id from work_sample_analyses where id = ${theirs.id}`
    expect(rows, 'the other user\'s row must survive a refused delete').toHaveLength(1)
  })

  test('answers 404 for an id that never existed — indistinguishable from the refusal above', async () => {
    const response = await harness.a.api!.delete(`/api/work-samples/${randomUUID()}`)
    expect(response.status()).toBe(404)
  })
})

test.describe('POST /api/work-samples/analyze', () => {
  test('refuses a request with no session', async () => {
    const response = await harness.anonymous.post('/api/work-samples/analyze', {
      data: { url: 'https://github.com/someone/something' },
    })
    expect(response.status()).toBe(401)
  })

  test('refuses a malformed body with 400 invalid_request', async () => {
    const response = await harness.a.api!.post('/api/work-samples/analyze', { data: {} })
    expect(response.status(), await response.text()).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_request' })
  })

  test('refuses an unsupported URL with 400 before ever reaching the AI configuration check', async () => {
    /**
     * Ordering matters for the message the caller gets. `parseSampleUrl` runs before the credential check, so a
     * nonsense URL is told it is unsupported rather than being told the feature is unavailable — which would send
     * someone to check their configuration over a typo.
     */
    const response = await harness.a.api!.post('/api/work-samples/analyze', {
      data: { url: 'https://example.com/not-a-code-host' },
    })
    expect(response.status(), await response.text()).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'unsupported_url' })
  })

  test('refuses a plan without an allowance for this task, before any AI or GitHub call', async () => {
    /**
     * A `pro` organization's daily allowance for `work-sample-analyze` is zero, so `decideBudget` returns
     * `reason: 'plan'` and the handler answers 429 without ever reaching the provider. The dangerous alternative
     * is not a 500 — it is an empty-but-successful analysis presented as a real assessment of someone's work.
     *
     * This gate is also what keeps the suite offline; see the file docblock before changing the fixture's tier.
     */
    const response = await harness.a.api!.post('/api/work-samples/analyze', {
      data: { url: 'https://github.com/e2e/unavailable-check' },
    })
    expect(response.status(), await response.text()).toBe(429)
    expect(await response.json()).toMatchObject({ error: 'plan' })

    const rows = await harness.sql`
      select id from work_sample_analyses
      where user_id = ${harness.a.userId!} and sample_url = 'https://github.com/e2e/unavailable-check'
    `
    expect(rows, 'a refused request must leave no analysis row behind').toHaveLength(0)
  })
})
