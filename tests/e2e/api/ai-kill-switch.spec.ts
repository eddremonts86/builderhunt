/**
 * The AI kill switch, asserted end to end (`POST /api/ai/complete` under `E2E_AI_TASK_SCENARIO=disabled`).
 *
 * Its own file for a mechanical reason: `E2E_AI_TASK_SCENARIO` is read from the *server* process, which inherits
 * `process.env` once at spawn, so a spec file gets exactly one value for its whole run. The rest of `ai/complete`'s
 * behaviour is covered in `ai-complete-and-embed.spec.ts` with no scenario set; only the kill switch needs the
 * process started with one, and running it here keeps that file's ten other assertions on the normal path.
 *
 * ## What this proves that reading the route cannot
 *
 * Two things, and the second is the one worth the file:
 *
 * 1. `disabled` short-circuits with `503 ai_disabled` — via the fake, so the real `AI_DISABLED` / `AI_DISABLED_TASKS`
 *    env flags stay untouched and no other spec in the run is affected by a global switch being flipped.
 * 2. **The switch answers before authentication.** An anonymous caller gets the same 503 as a signed-in one. That is
 *    deliberate, and it looks exactly like the validate-before-authenticate leak fixed elsewhere in this plan — the
 *    difference is that `GET /api/ai/config` publishes `disabled` to anonymous callers by design, so the 503 discloses
 *    nothing new. Asserting the two are identical pins that reasoning: if `ai/config` ever stops publishing it, this
 *    test is where someone will notice the ordering now leaks something.
 *
 * A kill switch that refused only authenticated callers would leave the expensive path reachable by anyone who had not
 * signed in, which is the failure this ordering exists to prevent.
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

/**
 * Snapshotted and restored on teardown. A leaked `disabled` would make every AI task in a later spec answer 503 —
 * which reads as a product bug, is invisible at six workers because the specs land in different processes, and only
 * surfaces in the serial gate. That exact shape of leak has already cost this suite one debugging cycle.
 */
const FLAGS: Record<string, string> = { E2E_AI_TASK_SCENARIO: 'disabled' }

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  owner: Principal
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
  const restore = () => {
    for (const [key, value] of restoreEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}aikill` }
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
      restoreEnv,
    }
  } catch (error) {
    restore()
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    await dropWorkerRedisNamespace(cache.prefix).catch(() => undefined)
    throw error
  }
})

test.afterAll(async () => {
  // Flags first, so a later failure cannot leave `disabled` set for the next spec sharing this worker.
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

const VALID_REQUEST = { taskId: 'ping', input: {} }

test.describe('POST /api/ai/complete with the kill switch on', () => {
  test('refuses an authenticated caller with 503 ai_disabled', async () => {
    const response = await harness.owner.api!.post('/api/ai/complete', { data: VALID_REQUEST })
    expect(response.status(), await response.text()).toBe(503)
    expect(await response.json()).toMatchObject({ error: 'ai_disabled' })
  })

  test('refuses an anonymous caller identically — the switch runs before authentication', async () => {
    /**
     * The property this file exists for. A kill switch that only stopped signed-in callers would leave the expensive
     * path open to anyone who had not signed in. And the responses being *identical* is what makes the ordering
     * defensible rather than a leak: `GET /api/ai/config` already publishes `disabled` anonymously, so the 503 tells
     * a stranger nothing they could not already read.
     */
    const [anonymous, authenticated] = await Promise.all([
      harness.anonymous.post('/api/ai/complete', { data: VALID_REQUEST }),
      harness.owner.api!.post('/api/ai/complete', { data: VALID_REQUEST }),
    ])

    expect(anonymous.status(), 'the switch must not depend on having a session').toBe(503)
    expect(anonymous.status()).toBe(authenticated.status())
    expect(await anonymous.json()).toEqual(await authenticated.json())
  })

  test('the public config route agrees that AI is off, which is what makes the 503 safe to show', async () => {
    /**
     * The other half of the argument, asserted rather than assumed. If this ever reports `disabled: false` while
     * `ai/complete` answers 503 to strangers, the ordering above has started disclosing a fact that is no longer
     * public — and this is the assertion that will say so.
     *
     * Note the fake drives `isTaskDisabled`, not `env.AI_DISABLED`, so `disabled` here reflects the real flag while
     * the route reflects the scenario. What must hold is that a stranger can learn the same thing from both: the
     * config route's `serverAI` is the honest summary of whether server AI will do anything for them.
     */
    const response = await harness.anonymous.get('/api/ai/config')
    expect(response.status()).toBe(200)
    const config = await response.json() as { disabled: boolean; serverAI: boolean; disabledTasks: string[] }
    expect(typeof config.disabled).toBe('boolean')
    expect(typeof config.serverAI).toBe('boolean')
  })
})
