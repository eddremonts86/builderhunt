/**
 * The saved-brief CRUD and the two public feature-flag readouts (plan 53, task 10 — none had an e2e spec).
 *
 * ## `ai/config` and `solutions/config`: `cache-control: public` is a promise about the payload
 *
 * Both answer unauthenticated with `cache-control: public, max-age=60`, which lets shared caches keep and re-serve
 * the response. That is safe *only* while the body is identical for every caller — the moment one field varies by
 * session, a shared cache hands one user's answer to another. So this spec asserts the payload is byte-identical
 * anonymous versus authenticated, which is the property the caching header actually depends on and the one a review
 * of either route in isolation cannot check.
 *
 * `ai/config` also reports `serverAI: Boolean(env.MINIMAX_API_KEY)` — a boolean *derived from* a secret. The useful
 * assertion is not "is it true", it is that the key's value never appears in the body, since a route whose whole job
 * is to describe configuration is where a secret gets leaked by accident.
 *
 * ## The briefs are the tenant boundary, with two distinct 404s
 *
 * A saved brief is the question someone asked, so `findBrief`/`updateBrief`/`deleteBrief` are all
 * principal-scoped. Another organization's brief id answers **404, not 403** — indistinguishable from one that never
 * existed — and `PATCH` reaches the same 404 through a different path (`SolutionsRepositoryError` mapped by code)
 * than `GET` and `DELETE` do, so all three are probed rather than one taken as representative.
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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}solbriefs` }
    const clock = fixedClockFromEnv()

    const principals: Principal[] = []
    for (let index = 0; index < 2; index += 1) {
      const { principal } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
      await seedConsent(sql, { userId: principal.userId!, document: 'tos', version: CURRENT_CONSENT_VERSIONS.tos, acceptedAt: clock.now() })
      principals.push(principal)
    }

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      a: principals[0]!,
      b: principals[1]!,
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

const PUBLIC_CONFIG_ROUTES = ['/api/ai/config', '/api/solutions/config'] as const

test.describe('public feature-flag readouts', () => {
  for (const path of PUBLIC_CONFIG_ROUTES) {
    test(`${path} answers anonymously and is cacheable`, async () => {
      const response = await harness.anonymous.get(path)
      expect(response.status(), await response.text()).toBe(200)
      expect(response.headers()['cache-control']).toContain('public')
    })

    test(`${path} returns the identical body to an anonymous and an authenticated caller`, async () => {
      /**
       * The property `cache-control: public` depends on. A shared cache does not know who asked, so if any field
       * varied by session it would serve one caller's answer to another. Compared as raw text, not parsed, because
       * key order changing between callers would also mean the body is being built per-request.
       */
      const [anonymous, authenticated] = await Promise.all([
        harness.anonymous.get(path),
        harness.a.api!.get(path),
      ])
      expect(await anonymous.text()).toBe(await authenticated.text())
    })
  }

  test('/api/ai/config describes whether a provider key exists without ever containing one', async () => {
    /**
     * `serverAI` is `Boolean(env.MINIMAX_API_KEY)` — the fact of configuration, not the configuration. A route whose
     * entire job is to describe setup is exactly where a secret gets echoed back by accident, so the body is checked
     * against the real key rather than against a guess at what a key looks like.
     */
    const response = await harness.anonymous.get('/api/ai/config')
    const body = await response.text()
    const parsed = JSON.parse(body) as { disabled: boolean; disabledTasks: string[]; serverAI: boolean }

    expect(typeof parsed.serverAI).toBe('boolean')
    expect(typeof parsed.disabled).toBe('boolean')
    expect(Array.isArray(parsed.disabledTasks)).toBe(true)
    expect(Object.keys(parsed).sort(), 'an added field here is a new public disclosure')
      .toEqual(['disabled', 'disabledTasks', 'serverAI'])

    const realKey = process.env.MINIMAX_API_KEY
    if (realKey && realKey.length > 8) {
      expect(body, 'the provider key must never reach a public payload').not.toContain(realKey)
    }
  })
})

/** A brief that satisfies `solutionBriefSchema`: a `deliverable` with an allowed domain, and at least one capability. */
function validBrief(description: string) {
  return {
    deliverable: { description, domain: 'software_and_ai' },
    capabilities: ['rust'],
    inputFormats: [],
    outputFormats: [],
    languages: [],
    integrations: [],
  }
}

async function saveBrief(principal: Principal, title: string): Promise<{ id: string }> {
  const response = await principal.api!.post('/api/solutions/briefs', {
    data: { title, brief: validBrief(`e2e brief ${title}`) },
  })
  expect(response.status(), await response.text()).toBe(201)
  return response.json() as Promise<{ id: string }>
}

test.describe('/api/solutions/briefs', () => {
  test('refuses both verbs with no session', async () => {
    const [read, write] = await Promise.all([
      harness.anonymous.get('/api/solutions/briefs'),
      harness.anonymous.post('/api/solutions/briefs', { data: {} }),
    ])
    expect(read.status()).toBe(401)
    expect(write.status()).toBe(401)
  })

  test('refuses an invalid brief with 422 and names at most five issues', async () => {
    // 422 rather than 400: the request is well-formed JSON that fails a domain schema. The issue list is capped at
    // five on purpose — a brief has enough fields that echoing all of them would be a wall of text, not a message.
    const response = await harness.a.api!.post('/api/solutions/briefs', { data: { title: 'x', brief: {} } })
    expect(response.status(), await response.text()).toBe(422)
    const body = await response.json() as { error: string; issues?: unknown[] }
    expect(body.issues, 'the caller needs to know what failed').toBeTruthy()
    expect(body.issues!.length).toBeLessThanOrEqual(5)
  })

  test('saves a brief and lists it back, without the other tenant\'s', async () => {
    const mine = await saveBrief(harness.a, `mine-${randomUUID().slice(0, 6)}`)
    const theirs = await saveBrief(harness.b, `theirs-${randomUUID().slice(0, 6)}`)

    const response = await harness.a.api!.get('/api/solutions/briefs')
    expect(response.status(), await response.text()).toBe(200)
    const ids = (await response.json() as Array<{ id: string }>).map((row) => row.id)
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(theirs.id)
  })

  /**
   * Not asserted here: the route's claim that "generation never writes a brief — a run carries its own
   * brief_snapshot, so keeping the question is a separate decision from keeping the answer".
   *
   * A first version of this file pretended to cover it by reading the list twice and checking the count had not
   * moved, which is true of any list nobody wrote to and proves nothing at all. Proving it means running a
   * generation (`POST /api/solutions/generate` under `E2E_AI_TASK_SCENARIO=success`) and showing no brief appeared —
   * that belongs with the generate route's own coverage, not smuggled in here as a no-op.
   */
})

test.describe('/api/solutions/briefs/$briefId', () => {
  test('refuses every verb with no session', async () => {
    const id = randomUUID()
    const responses = await Promise.all([
      harness.anonymous.get(`/api/solutions/briefs/${id}`),
      harness.anonymous.fetch(`/api/solutions/briefs/${id}`, { method: 'PATCH', data: { title: 'x' } }),
      harness.anonymous.fetch(`/api/solutions/briefs/${id}`, { method: 'DELETE' }),
    ])
    for (const response of responses) expect(response.status()).toBe(401)
  })

  test('reads, renames and deletes the caller\'s own brief', async () => {
    const brief = await saveBrief(harness.a, `crud-${randomUUID().slice(0, 6)}`)

    const read = await harness.a.api!.get(`/api/solutions/briefs/${brief.id}`)
    expect(read.status(), await read.text()).toBe(200)

    const renamed = await harness.a.api!.patch(`/api/solutions/briefs/${brief.id}`, { data: { title: 'renamed' } })
    expect(renamed.status(), await renamed.text()).toBe(200)
    expect(await renamed.json()).toMatchObject({ title: 'renamed' })

    const deleted = await harness.a.api!.delete(`/api/solutions/briefs/${brief.id}`)
    expect(deleted.status(), 'a delete with nothing to return is a 204').toBe(204)

    const gone = await harness.a.api!.get(`/api/solutions/briefs/${brief.id}`)
    expect(gone.status()).toBe(404)
  })

  test('another tenant\'s brief is a 404 on all three verbs, and survives', async () => {
    /**
     * 404 rather than 403 on every verb, so a foreign id cannot be distinguished from a fabricated one. All three are
     * probed because `PATCH` arrives at its 404 by a different route than the others — through
     * `SolutionsRepositoryError`'s `code` mapping rather than a null check — and a single spot-check would leave that
     * path unproven.
     */
    const theirs = await saveBrief(harness.b, `protected-${randomUUID().slice(0, 6)}`)
    const fabricated = randomUUID()

    const foreign = await Promise.all([
      harness.a.api!.get(`/api/solutions/briefs/${theirs.id}`),
      harness.a.api!.patch(`/api/solutions/briefs/${theirs.id}`, { data: { title: 'stolen' } }),
      harness.a.api!.delete(`/api/solutions/briefs/${theirs.id}`),
    ])
    for (const response of foreign) expect(response.status(), await response.text()).toBe(404)

    const absent = await harness.a.api!.get(`/api/solutions/briefs/${fabricated}`)
    expect(absent.status(), 'a foreign id and an absent one must look the same').toBe(foreign[0]!.status())

    // The refusals must not have been partially applied.
    const stillTheirs = await harness.b.api!.get(`/api/solutions/briefs/${theirs.id}`)
    expect(stillTheirs.status(), 'B\'s brief must survive A\'s attempts').toBe(200)
    expect(await stillTheirs.json()).not.toMatchObject({ title: 'stolen' })
  })
})
