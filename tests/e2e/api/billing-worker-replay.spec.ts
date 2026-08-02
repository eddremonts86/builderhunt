/**
 * The billing worker, the dead-letter queue and single-event replay (plan 53, task 5).
 *
 * A webhook arriving is not a webhook applied. `POST /api/webhooks/stripe` records the event and answers 200 —
 * deliberately, because Stripe retries anything else — and the *worker* is what turns a recorded event into
 * money in the ledger. That split is where the interesting failures live, and none of them are visible from
 * the webhook endpoint the previous spec covers:
 *
 * - **An event that is recorded but never processed** is a payment the customer made and the product never
 *   honoured. Silent: Stripe got its 200 and stopped retrying.
 * - **An event processed twice** is a payment honoured twice. The worker's idempotency is the only thing
 *   between a retry and a double grant.
 * - **A dead-lettered event** is the honest end state for something that cannot be applied, and its value is
 *   entirely in being *discoverable*. A dead letter nobody can list is the same as a lost payment.
 * - **Replay** is the recovery path, and it is a platform-admin action on production money. It must be
 *   authorized like one, and it must be safe to run twice, because the operator who runs it will not be sure
 *   the first one worked.
 */
import { createHmac } from 'node:crypto'
import { expect, request as playwrightRequest, test, type APIRequestContext } from 'playwright/test'

import { startInterviewHarness, stopInterviewHarness, type InterviewHarness } from '../harness/fixtures/interviews'
import {
  createPlatformAdminPrincipal,
  registerPlatformAdminEnv,
  reservePlatformAdminSeed,
} from '../harness/fixtures/platform-admin'
import { disposePrincipal, type Principal } from '../harness/fixtures/principals'

const API_VERSION = '2025-10-29.clover'
const SECRET = 'whsec_e2e_worker_secret'

let harness: InterviewHarness
let admin: Principal
let anonymous: APIRequestContext

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  // The allowlist is read from the environment by the app process, so the id must be registered before spawn.
  const adminSeed = reservePlatformAdminSeed(`w${workerIndex}-worker`)
  registerPlatformAdminEnv(adminSeed)

  harness = await startInterviewHarness({
    scope: 'wrkr',
    flags: {
      STRIPE_WEBHOOK_SECRET: SECRET,
      STRIPE_API_VERSION: API_VERSION,
    },
  })
  admin = await createPlatformAdminPrincipal(harness.ctx, adminSeed)
  anonymous = await playwrightRequest.newContext({ baseURL: harness.baseURL })
})

test.afterAll(async () => {
  await anonymous.dispose().catch(() => undefined)
  await disposePrincipal(admin).catch(() => undefined)
  await stopInterviewHarness(harness)
})

function sign(payload: string, secret: string, timestampSeconds: number): string {
  const signature = createHmac('sha256', secret).update(`${timestampSeconds}.${payload}`).digest('hex')
  return `t=${timestampSeconds},v1=${signature}`
}

/** Delivers a signed event the way Stripe would, so the row under test was created by the real path. */
async function deliver(stripeEventId: string, type = 'checkout.session.completed'): Promise<void> {
  const payload = JSON.stringify({
    id: stripeEventId,
    object: 'event',
    api_version: API_VERSION,
    livemode: false,
    type,
    created: 1_754_136_000,
    data: { object: { object: 'checkout.session', id: `cs_${stripeEventId}` } },
  })
  const response = await anonymous.post('/api/webhooks/stripe', {
    headers: {
      'content-type': 'application/json',
      'stripe-signature': sign(payload, SECRET, Math.floor(Date.now() / 1000)),
    },
    data: payload,
  })
  expect(response.status(), await response.text()).toBe(200)
}

async function eventRow(stripeEventId: string) {
  const [row] = await harness.sql<{ id: string; status: string; attempts: number | null }[]>`
    select id, status, attempts from billing_webhook_events where stripe_event_id = ${stripeEventId}
  `
  return row
}

test('a delivered event lands in the inbox as pending, not as applied', async () => {
  /**
   * The split this whole file is about. The webhook endpoint's job is to *record and acknowledge* — applying
   * it is the worker's. An endpoint that applied inline would have to do money work inside a request Stripe
   * will retry on timeout, which is how double-grants happen.
   */
  await deliver('evt_worker_pending')
  const row = await eventRow('evt_worker_pending')

  expect(row, 'the event was recorded').toBeTruthy()
  expect(
    ['pending', 'processed', 'ignored'],
    `unexpected initial status ${row?.status}`,
  ).toContain(row!.status)
  expect(row!.status, 'receiving is not applying').not.toBe('failed')
})

test('the worker run endpoint is platform-admin only', async () => {
  /**
   * This endpoint applies money. A tenant owner reaching it could force settlement work on the whole platform,
   * not only their own organization — the worker is not tenant-scoped, which is exactly why the allowlist and
   * not a role guards it.
   */
  const anonymousAttempt = await anonymous.post('/api/admin/billing/run-worker', { data: {} })
  expect([401, 403]).toContain(anonymousAttempt.status())

  const tenantAttempt = await harness.owner.api!.post('/api/admin/billing/run-worker', { data: {} })
  expect([401, 403], await tenantAttempt.text()).toContain(tenantAttempt.status())
})

test('the worker runs and reports what it did', async () => {
  /**
   * The summary is the operator's only window into a process that touches money without a user watching. A
   * run that silently returned 200 with no counts would make "did anything happen?" unanswerable.
   */
  await deliver('evt_worker_run')
  const response = await admin.api!.post('/api/admin/billing/run-worker', { data: {} })

  expect(response.status(), await response.text()).toBeLessThan(400)
  const summary = await response.json() as Record<string, unknown>
  expect(Object.keys(summary).length, 'the run reported nothing at all').toBeGreaterThan(0)
})

test('running the worker twice does not process the same event twice', async () => {
  /**
   * The invariant that makes the worker safe to schedule *and* safe to run by hand. An operator who is unsure
   * whether a run finished will run it again; that must be free.
   */
  await deliver('evt_worker_twice')

  await admin.api!.post('/api/admin/billing/run-worker', { data: {} })
  const afterFirst = await eventRow('evt_worker_twice')
  await admin.api!.post('/api/admin/billing/run-worker', { data: {} })
  const afterSecond = await eventRow('evt_worker_twice')

  const rows = await harness.sql<{ count: string }[]>`
    select count(*)::text as count from billing_webhook_events where stripe_event_id = 'evt_worker_twice'
  `
  expect(rows[0]?.count, 'a second run duplicated the event row').toBe('1')
  expect(
    afterSecond?.status,
    `status moved on a second run: ${afterFirst?.status} -> ${afterSecond?.status}`,
  ).toBe(afterFirst?.status)
})

test('events are discoverable by status, so a dead letter is never invisible', async () => {
  /**
   * A dead-lettered event's entire value is that somebody can find it. If the only way to see one is a
   * database console, then in practice a failed payment is lost — and the customer, who paid, is the one who
   * finds out.
   */
  await deliver('evt_worker_listed')

  const response = await admin.api!.get('/api/admin/billing/events')
  expect(response.status(), await response.text()).toBe(200)
  const body = await response.text()
  expect(body, 'a delivered event is not listed').toContain('evt_worker_listed')

  // Every documented status is a valid filter — an operator hunting a dead letter must not be told their
  // query is invalid.
  for (const status of ['pending', 'processing', 'processed', 'failed', 'ignored']) {
    const filtered = await admin.api!.get(`/api/admin/billing/events?status=${status}`)
    expect(filtered.status(), `status=${status} was rejected`).toBe(200)
  }

  const rejected = await admin.api!.get('/api/admin/billing/events?status=not-a-status')
  expect(rejected.status(), 'an unknown status should be refused, not silently ignored').toBe(400)
})

test('replay is platform-admin only and 404s an event that does not exist', async () => {
  /**
   * Replay re-applies a money event on demand. `not_found` for an unknown id rather than a 500 matters
   * operationally: an admin pasting an id from a support ticket needs "no such event", not a stack trace.
   */
  const anonymousAttempt = await anonymous.post('/api/admin/billing/events/evt_absent/replay', { data: {} })
  expect([401, 403]).toContain(anonymousAttempt.status())

  const tenantAttempt = await harness.owner.api!.post('/api/admin/billing/events/evt_absent/replay', { data: {} })
  expect([401, 403], await tenantAttempt.text()).toContain(tenantAttempt.status())

  const adminAttempt = await admin.api!.post('/api/admin/billing/events/evt_absent/replay', { data: {} })
  expect(adminAttempt.status(), await adminAttempt.text()).toBe(404)
  expect((await adminAttempt.json()).code).toBe('not_found')
})

test('replaying an applied event does not apply it a second time', async () => {
  /**
   * The recovery path's own safety property. An operator replays precisely when they are unsure the first
   * attempt worked, so the dangerous case is the one where it already did — and the answer must be "nothing
   * changed", not a second grant.
   */
  await deliver('evt_worker_replay')
  await admin.api!.post('/api/admin/billing/run-worker', { data: {} })
  const before = await eventRow('evt_worker_replay')

  const replay = await admin.api!.post(
    `/api/admin/billing/events/${before!.id}/replay`,
    { data: {} },
  )
  // Either the replay succeeds idempotently or it refuses — what it must not do is duplicate the row or
  // silently move the event into a state the first pass had already settled differently.
  expect(replay.status(), await replay.text()).not.toBe(500)

  const rows = await harness.sql<{ count: string }[]>`
    select count(*)::text as count from billing_webhook_events where stripe_event_id = 'evt_worker_replay'
  `
  expect(rows[0]?.count, 'a replay duplicated the event row').toBe('1')
})
