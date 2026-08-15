/**
 * `/api/dashboard/context` over HTTP (plan: phase-2/04-dashboard-personalizado).
 *
 * The endpoint that decides which dashboard route somebody is on. What only exists end to end:
 *
 * - **a null segment is the normal answer**, not a failure — it is what every account has until
 *   somebody chooses, and it must resolve to the `general` route;
 * - **the segment comes from the server**, never from the request. There is no field a caller could
 *   send to name one, and a body that tries changes nothing;
 * - **the role and the plan are the caller's own**, read through the tenant principal rather than
 *   asked for.
 */
import { expect, test } from 'playwright/test'

import { startInterviewHarness, stopInterviewHarness, type InterviewHarness } from '../harness/fixtures/interviews'
import { createMemberPrincipal, type Principal } from '../harness/fixtures/principals'
import { newApiContext } from '../harness/auth'

let harness: InterviewHarness
let member: Principal

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({
    scope: 'dashctx',
    tier: 'free',
    flags: { USER_SEGMENTATION_ENABLED: 'true' },
  })
  member = await createMemberPrincipal(harness.ctx, harness.organization.organizationId, 'member')
  harness.extraPrincipals.push(member)
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

async function setSegment(segment: string | null) {
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
    expect((await anonymous.get('/api/dashboard/context')).status()).toBe(401)
  } finally {
    await anonymous.dispose()
  }
})

/** The common case, and not a failure: nobody has a segment until they choose one. */
test('answers the general route to somebody with no segment', async () => {
  await setSegment(null)
  const response = await harness.owner.api!.get('/api/dashboard/context')
  expect(response.status()).toBe(200)

  const body = await response.json()
  expect(body.segment).toBeNull()
  expect(body.presetId).toBe('general')
  // The capabilities the deployment has shipped — not the ones the spec names. `pipeline` and
  // `saved-search-health` do not exist, and a widget declaring them is omitted rather than rendered
  // as a permanently empty tile.
  expect(body.capabilities).not.toContain('pipeline')
  expect(body.capabilities).toContain('calendar')
})

test('follows the stored segment', async () => {
  for (const [segment, presetId] of [
    ['hiring', 'hiring'],
    ['investing', 'investing'],
    ['building', 'building'],
    ['other', 'other'],
  ] as const) {
    await setSegment(segment)
    const body = await (await harness.owner.api!.get('/api/dashboard/context')).json()
    expect(body.segment, segment).toBe(segment)
    expect(body.presetId, segment).toBe(presetId)
  }
})

/**
 * The route is a property of the person. A request that could name a segment would make it a
 * property of whatever the client last claimed — and would let one member's dashboard be composed
 * for somebody else's goal.
 */
test('ignores anything the caller says about the segment', async () => {
  await setSegment('hiring')
  const response = await harness.owner.api!.fetch('/api/dashboard/context?segment=investing&presetId=investing', {
    method: 'GET',
  })
  const body = await response.json()
  expect(body.presetId).toBe('hiring')
})

test('reports the role the caller actually holds', async () => {
  const asOwner = await (await harness.owner.api!.get('/api/dashboard/context')).json()
  expect(asOwner.role).toBe('owner')

  const asMember = await (await member.api!.get('/api/dashboard/context')).json()
  expect(asMember.role).toBe('member')
})

/**
 * The plan travels so the dashboard can say "that is on another plan" instead of hiding a widget.
 * Hiding would tell somebody the feature does not exist, which is a different message from the true
 * one — and it would make a preset a second entitlement surface.
 */
test('reports the plan, and moves with it', async () => {
  const free = await (await harness.owner.api!.get('/api/dashboard/context')).json()
  expect(free.entitlement).toEqual({ tier: 'free', paidActionsAllowed: false })

  await harness.sql`
    update organization_entitlements set tier = 'pro', status = 'active'
    where organization_id = ${harness.organization.organizationId}
  `
  const paid = await (await harness.owner.api!.get('/api/dashboard/context')).json()
  expect(paid.entitlement).toEqual({ tier: 'pro', paidActionsAllowed: true })
})

/** A member of the same workspace reads the same plan — entitlement is the organization's. */
test('gives a member the workspace plan, not a private one', async () => {
  const body = await (await member.api!.get('/api/dashboard/context')).json()
  expect(body.entitlement.tier).toBe('pro')
  // And their own segment, which they never set.
  expect(body.segment).toBeNull()
  expect(body.presetId).toBe('general')
})

test('every other method is refused with an Allow header', async () => {
  const response = await harness.owner.api!.post('/api/dashboard/context', { data: {} })
  expect(response.status()).toBe(405)
  expect(response.headers()['allow']).toContain('GET')
})
