/**
 * `POST /api/ai/complete` and `POST /api/ai/embed` (plan 53, task 10 — the last two AI routes without an e2e spec).
 *
 * ## The assertion that matters most: a sensitive task is indistinguishable from one that does not exist
 *
 * `ai/complete` reaches MiniMax. Three tasks read candidate material and are marked `sensitive` because they may only
 * run on the EU provider through `sensitive.ts` — the provider a candidate was actually told would process their CV.
 * This route refuses them, and refuses them as **`unknown_task`** rather than with a distinct code, for a reason
 * written into the route: "a caller probing this route has no business learning that the task exists."
 *
 * So the property is not "sensitive tasks are refused" — it is that the refusal is byte-identical to a fabricated
 * task id. A well-meaning change to `sensitive_task_not_allowed_here` would look like better error reporting and
 * would hand a prober the registry.
 *
 * ## The gate order is deliberately not authenticate-first, and that is defensible here
 *
 * Steps 1 and 2 of the documented pipeline — the kill switch and "provider unconfigured" — run *before*
 * `requireTenantPrincipal`, so an anonymous caller can receive `503 ai_disabled` or `503 ai_unconfigured`. That looks
 * like the validate-before-authenticate leak fixed elsewhere in this plan, and is not: `GET /api/ai/config` publishes
 * exactly those two facts to anonymous callers by design. The 503 discloses nothing that is not already public, so
 * `pnpm security:auth-before-validate` correctly leaves it alone — it only flags a *schema* parse before a guard, and
 * `task.inputSchema.safeParse` here runs after one.
 *
 * ## What this file cannot cover, and why it is not a gap in the assertions
 *
 * `E2E_AI_TASK_SCENARIO` (`disabled`, `budget_exceeded`, `unsupported`) is read from the *server* process, which
 * inherits `process.env` once at spawn — one value per spec file. Those three branches therefore need their own
 * file(s) rather than being toggled mid-run, and are recorded in the plan as such. `E2E_EMBEDDINGS_SCENARIO` is a
 * different variable, so setting it here to drive `ai/embed` deterministically does not disturb `ai/complete`.
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
import {
  createPlatformAdminPrincipal,
  registerPlatformAdminEnv,
  reservePlatformAdminSeed,
} from '../harness/fixtures/platform-admin'
import { seedConsent } from '../harness/fixtures/privacy'
import { CURRENT_CONSENT_VERSIONS } from '~/shared/lib/legal-versions'

/**
 * Drives the embedding boundary through its deterministic stub instead of a real HTTP call. Snapshotted and restored
 * on teardown: the worker server inherits `process.env` at spawn, and a leaked scenario would silently change how a
 * later spec's embeddings behave — invisible at six workers, and only caught by the serial gate.
 */
const FLAGS: Record<string, string> = { E2E_EMBEDDINGS_SCENARIO: 'success' }

/** Marked `sensitive` in the task registry, so this route must refuse it as if it did not exist. */
const SENSITIVE_TASK_ID = 'interview-brief-generate'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  owner: Principal
  admin: Principal
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
  const adminSeed = reservePlatformAdminSeed(`w${workerIndex}aiembed`)
  restoreEnv.push(['ADMIN_USER_IDS', process.env.ADMIN_USER_IDS])
  registerPlatformAdminEnv(adminSeed)

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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}aicomplete` }
    const clock = fixedClockFromEnv()

    const { principal: owner } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    await seedConsent(sql, { userId: owner.userId!, document: 'tos', version: CURRENT_CONSENT_VERSIONS.tos, acceptedAt: clock.now() })
    const admin = await createPlatformAdminPrincipal(ctx, adminSeed)

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      owner,
      admin,
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
  // Flags first, so a later failure cannot leave them set for the next spec sharing this worker.
  for (const [key, value] of harness?.restoreEnv ?? []) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await harness?.anonymous.dispose().catch(() => undefined)
  await harness?.admin.api?.dispose().catch(() => undefined)
  await harness?.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(harness.workerIndex).catch(() => undefined)
  await dropWorkerDatabase(harness.workerIndex, harness.databaseName).catch(() => undefined)
  await dropWorkerRedisNamespace(harness.redisPrefix).catch(() => undefined)
})

test.describe('POST /api/ai/complete', () => {
  test('refuses a well-formed request with no session', async () => {
    // Well-formed on purpose: `{}` would be refused by an earlier gate, proving only that a gate exists.
    const response = await harness.anonymous.post('/api/ai/complete', {
      data: { taskId: 'ping', input: {} },
    })
    expect(response.status(), await response.text()).toBe(401)
  })

  test('refuses a body that is not JSON at all with 400 invalid_json', async () => {
    /**
     * Sent as a Buffer, which is the only way to get genuinely malformed bytes through Playwright: passing a string
     * as `data` gets JSON-serialised, so `'not json'` arrives as the valid JSON document `"not json"` and the route
     * parses it happily and answers 401 instead. The first draft of this test did exactly that and asserted nothing.
     */
    const response = await harness.anonymous.post('/api/ai/complete', {
      headers: { 'content-type': 'application/json' },
      data: Buffer.from('{ this is not json'),
    })
    expect(response.status(), await response.text()).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_json' })
  })

  test('a sensitive task is refused exactly as if it did not exist', async () => {
    /**
     * The route's own reasoning: "`unknown_task` deliberately, not a distinct code: a caller probing this route has
     * no business learning that the task exists." So the two responses are compared whole — status and body — rather
     * than each being checked against 400 separately, because a distinct code for the sensitive case would satisfy
     * two independent 400 assertions while handing a prober the registry.
     */
    const [sensitive, fabricated] = await Promise.all([
      harness.owner.api!.post('/api/ai/complete', { data: { taskId: SENSITIVE_TASK_ID, input: {} } }),
      harness.owner.api!.post('/api/ai/complete', { data: { taskId: `absent-${randomUUID().slice(0, 8)}`, input: {} } }),
    ])

    expect(sensitive.status()).toBe(fabricated.status())
    expect(await sensitive.json()).toEqual(await fabricated.json())
    expect(sensitive.status(), await sensitive.text()).toBe(400)
    expect(await sensitive.json()).toMatchObject({ error: 'unknown_task' })
  })

  test('a real task with input the schema rejects answers invalid_input, not unknown_task', async () => {
    // The two 400s are different facts: one says "no such task", the other "that task, wrong input". Collapsing them
    // would make a typo in a task id indistinguishable from a malformed payload.
    const response = await harness.owner.api!.post('/api/ai/complete', {
      data: { taskId: 'query-translate', input: { unexpected: 'shape' } },
    })
    expect(response.status(), await response.text()).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_input' })
  })
})

test.describe('POST /api/ai/embed', () => {
  test('refuses an anonymous caller', async () => {
    const response = await harness.anonymous.post('/api/ai/embed', { data: { texts: ['hello'] } })
    expect([401, 403]).toContain(response.status())
  })

  test('refuses an ordinary organization owner — this is platform-admin only', async () => {
    // Embedding is an operator tool, not a tenant feature: it spends provider budget and is not metered per
    // organization. A paying customer's owner is still not an operator.
    const response = await harness.owner.api!.post('/api/ai/embed', { data: { texts: ['hello'] } })
    expect([401, 403]).toContain(response.status())
  })

  test('refuses a platform admin sending an invalid body with 400', async () => {
    const response = await harness.admin.api!.post('/api/ai/embed', { data: { texts: [] } })
    expect(response.status(), await response.text()).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_input' })
  })

  test('embeds for a platform admin, returning one vector per text at the configured dimension', async () => {
    /**
     * Runs through the `E2E_EMBEDDINGS_SCENARIO=success` stub, so there is no HTTP call and no dependency on a local
     * embedding server being up. The stub is deterministic and reproduces the production path's shape, which is what
     * makes the dimension assertion meaningful: `AIDimensionMismatchError` is a real 502 branch, so a vector of the
     * wrong length is a failure the route is expected to catch rather than pass through.
     */
    const texts = ['first text', 'second text', 'third text']
    const response = await harness.admin.api!.post('/api/ai/embed', { data: { texts } })
    expect(response.status(), await response.text()).toBe(200)
    const body = await response.json() as { embeddings: number[][]; dim: number }

    expect(body.embeddings, 'one vector per input, in input order').toHaveLength(texts.length)
    expect(typeof body.dim).toBe('number')
    for (const vector of body.embeddings) {
      expect(vector).toHaveLength(body.dim)
      expect(vector.every((value) => typeof value === 'number')).toBe(true)
    }
  })

  /**
   * Not asserted: that the `admin.ai.embed` audit event is durably recorded.
   *
   * A first version of this test queried a `platform_admin_audit` table, which does not exist — the name was
   * invented. `auditPlatformAdminAction` calls `emitSecurityAudit(..., consoleSecurityAuditSink)`, and that sink is
   * `console.log('[security-audit]', …)`. Nothing reaches the database, so there is no row for a spec to assert and
   * no way to query the trail after the fact from SQL.
   *
   * That is a real property of the system rather than a gap in this file, and it is worth someone deciding on
   * deliberately: in production the line lands in the container log, which is a trail, but not a queryable or
   * retained one. Asserting it here would need the server's stdout, which the worker harness does not expose.
   */
})
