/**
 * `/api/onboarding/v2` against a running server (plan: phase-2/03-onboarding-segmentado).
 *
 * Three properties only exist end to end:
 *
 * - **v1 still answers.** The whole rollout strategy is that a client chooses an endpoint, so
 *   `/api/onboarding/status` must be untouched by anything here;
 * - **the route follows the stored segment**, not anything the request says;
 * - **a stale advance is a 409, not a 400.** One means re-read, the other means fix your code, and
 *   a client cannot tell them apart if the server does not.
 */
import { expect, test } from 'playwright/test'

import { startInterviewHarness, stopInterviewHarness, type InterviewHarness } from '../harness/fixtures/interviews'
import { newApiContext } from '../harness/auth'

let harness: InterviewHarness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({ scope: 'onbv2', flags: { USER_SEGMENTATION_ENABLED: 'true' } })
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

/**
 * Resets both halves of the state.
 *
 * These specs run serially against one account, so a test that only cleared the segment would
 * inherit whatever step its predecessor advanced to — which is how the stale-advance test first
 * failed, expecting `welcome` and finding `goal`.
 */
async function setSegment(segment: string | null) {
  await harness.sql`delete from onboarding_progress where user_id = ${harness.owner.userId}`
  await harness.sql`delete from user_preferences where user_id = ${harness.owner.userId}`
  if (segment) {
    await harness.sql`
      insert into user_preferences (user_id, primary_segment, segment_source, segment_schema_version)
      values (${harness.owner.userId}, ${segment}, 'onboarding', 1)
    `
  }
}

test('an unauthenticated request is refused', async () => {
  const anonymous = await newApiContext(harness.baseURL)
  try {
    expect((await anonymous.get('/api/onboarding/v2')).status()).toBe(401)
  } finally {
    await anonymous.dispose()
  }
})

test('answers the general route to somebody with no segment', async () => {
  await setSegment(null)
  const response = await harness.owner.api!.get('/api/onboarding/v2')
  expect(response.status()).toBe(200)

  const body = await response.json()
  expect(body.flowVersion).toBe(2)
  expect(body.preset).toBe('general')
  expect(body.currentStep).toBe('welcome')
  expect(body.flow).toContain('general_search')
  // Reaching a step is never activation.
  expect(body.activationType).toBeNull()
})

test('follows the stored segment', async () => {
  await setSegment('investing')
  const body = await (await harness.owner.api!.get('/api/onboarding/v2')).json()

  expect(body.preset).toBe('investing')
  expect(body.flow).toContain('investing_thesis')
  expect(body.flow).not.toContain('hiring_search')
})

/** The reason for versioning rather than replacing: a consumer that has not moved keeps working. */
test('carries the v1 reading, and leaves the v1 endpoint alone', async () => {
  await setSegment('hiring')
  const v2 = await (await harness.owner.api!.get('/api/onboarding/v2')).json()
  expect(v2.legacy).toEqual({ step: 0, completed: false })

  const v1 = await harness.owner.api!.get('/api/onboarding/status')
  expect(v1.status()).toBe(200)
  const v1Body = await v1.json()
  expect(v1Body).toHaveProperty('step')
  // v1 answers its own shape, unchanged — no `flowVersion`, no `preset`.
  expect(v1Body).not.toHaveProperty('flowVersion')
})

test('advances one step and keeps the v1 column in step', async () => {
  await setSegment('hiring')
  const response = await harness.owner.api!.post('/api/onboarding/v2', {
    data: { action: 'advance', from: 'welcome' },
  })
  expect(response.status()).toBe(200)

  const body = await response.json()
  expect(body.currentStep).toBe('goal')
  expect(body.legacy.step).toBe(1)
})

/**
 * 409 and not 400. The request was well-formed and the state moved underneath it — a client that
 * gets 409 re-reads, one that gets 400 has a bug, and collapsing them makes a retry loop
 * indistinguishable from a broken client.
 */
test('a stale advance is a conflict, and returns the current state with it', async () => {
  await setSegment('hiring')
  const response = await harness.owner.api!.post('/api/onboarding/v2', {
    data: { action: 'advance', from: 'hiring_save' },
  })

  expect(response.status()).toBe(409)
  const body = await response.json()
  expect(body.error).toBe('stale_step')
  // The current state travels with the refusal, so a client can re-render without a second request.
  expect(body.state.currentStep).toBe('welcome')
})

test('refuses a malformed action, and one naming a segment or a user', async () => {
  for (const bad of [
    { action: 'teleport', from: 'welcome' },
    { action: 'advance' },
    { action: 'advance', from: 'not_a_step' },
    { action: 'advance', from: 'welcome', userId: 'someone-else' },
    { action: 'advance', from: 'welcome', segment: 'hiring' },
    { action: 'activate', activationType: 'made_it_up' },
  ]) {
    const response = await harness.owner.api!.post('/api/onboarding/v2', { data: bad })
    expect(response.status(), JSON.stringify(bad)).toBe(400)
  }
})

/**
 * The evidence is counted on the server. A client that could assert "I saved three builders" could
 * assert it having saved none, and the activation rate would be the first casualty.
 */
test('an activation request does not activate on its own say-so', async () => {
  await setSegment('hiring')
  const response = await harness.owner.api!.post('/api/onboarding/v2', {
    data: { action: 'activate', activationType: 'tracked_builders' },
  })

  expect(response.status()).toBe(200)
  expect((await response.json()).activationType).toBeNull()
})

/**
 * The other half of the same rule: with real evidence in the database, the server *does* record the
 * activation — and records which kind. Without this, the test above would be satisfied by an
 * endpoint that never activates anybody.
 */
test('activates once the evidence is actually there, and names the kind', async () => {
  await setSegment('hiring')

  // The row the activation counter reads. Written directly rather than through the flow, because
  // what is under test is the server's counting, not the search UI that produces the rows.
  await harness.sql`
    insert into onboarding_progress (user_id, organization_id, step)
    values (${harness.owner.userId}, ${harness.organization.organizationId}, 2)
  `
  for (const n of [1, 2, 3]) {
    await harness.sql`
      insert into onboarding_selected_builders (id, organization_id, user_id, builder_ref)
      values (${`sb-${harness.owner.userId}-${n}`}, ${harness.organization.organizationId},
              ${harness.owner.userId}, ${`gh-${n}`})
    `
  }

  const response = await harness.owner.api!.post('/api/onboarding/v2', {
    data: { action: 'activate', activationType: 'tracked_builders', refId: 'run-1' },
  })

  expect(response.status()).toBe(200)
  const body = await response.json()
  expect(body.activationType).toBe('tracked_builders')
  expect(body.activatedAt).not.toBeNull()
})

/**
 * The first real act is the one that counts. A later activation of a different kind would move
 * `activated_at` and quietly corrupt every time-to-activation figure computed from it.
 */
test('never re-activates once it has', async () => {
  const before = await (await harness.owner.api!.get('/api/onboarding/v2')).json()
  expect(before.activationType).toBe('tracked_builders')

  await harness.owner.api!.post('/api/onboarding/v2', {
    data: { action: 'activate', activationType: 'sourcing_sprint' },
  })

  const after = await (await harness.owner.api!.get('/api/onboarding/v2')).json()
  expect(after.activationType).toBe('tracked_builders')
  expect(after.activatedAt).toBe(before.activatedAt)
})

test('every other method is refused with an Allow header', async () => {
  const response = await harness.owner.api!.delete('/api/onboarding/v2')
  expect(response.status()).toBe(405)
  expect(response.headers()['allow']).toContain('POST')
})
