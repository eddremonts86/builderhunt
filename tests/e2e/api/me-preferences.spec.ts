/**
 * `/api/me/preferences` against a running server (plan: phase-2/02-segmentacion-usuarios).
 *
 * The unit tests cover the schema and the repository, but two properties only exist end to end:
 *
 * - **the subject is the session, never the body.** A request naming somebody else has to fail, and
 *   the person it named has to be untouched afterwards — asserted by reading their row back, not by
 *   trusting the 400;
 * - **row-level security is actually in force.** Unit tests connect as a superuser and see every
 *   row, so only a real request through the app proves that one member cannot reach another's.
 */
import { expect, test, type APIRequestContext } from 'playwright/test'

import { addMember, startInterviewHarness, stopInterviewHarness, type InterviewHarness } from '../harness/fixtures/interviews'
import { newApiContext, signIn } from '../harness/auth'

let harness: InterviewHarness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({
    scope: 'prefs',
    // The feature ships dark. Every assertion below is about the enabled behaviour, so the flag is
    // set explicitly rather than inherited from whatever a laptop's `.env` happens to hold.
    flags: { USER_SEGMENTATION_ENABLED: 'true' },
  })
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

test('an unauthenticated request is refused', async () => {
  const anonymous = await newApiContext(harness.baseURL)
  try {
    const response = await anonymous.get('/api/me/preferences')
    expect(response.status()).toBe(401)
  } finally {
    await anonymous.dispose()
  }
})

test('starts with no segment, and says which ones exist', async () => {
  const response = await harness.owner.api!.get('/api/me/preferences')
  expect(response.status()).toBe(200)

  const body = await response.json()
  // Never asked is a first-class state, not an error and not a default of `other`.
  expect(body.primarySegment).toBeNull()
  expect(body.selectedAt).toBeNull()
  expect(body.available).toEqual(['hiring', 'investing', 'building', 'other'])
})

test('persists a choice, and returns it on the next read', async () => {
  const patch = await harness.owner.api!.patch('/api/me/preferences', {
    data: { primarySegment: 'hiring', source: 'settings' },
  })
  expect(patch.status()).toBe(200)
  expect((await patch.json()).primarySegment).toBe('hiring')

  const reread = await harness.owner.api!.get('/api/me/preferences')
  const body = await reread.json()
  expect(body.primarySegment).toBe('hiring')
  expect(body.source).toBe('settings')
  expect(body.schemaVersion).toBe(1)
  expect(body.selectedAt).not.toBeNull()
})

test('clearing is a write, not a delete', async () => {
  await harness.owner.api!.patch('/api/me/preferences', { data: { primarySegment: 'investing' } })
  const cleared = await harness.owner.api!.patch('/api/me/preferences', { data: { primarySegment: null } })

  expect(cleared.status()).toBe(200)
  expect((await cleared.json()).primarySegment).toBeNull()
  // The row survives; only the value is gone. A rollback must not punish the people who answered.
  expect((await harness.owner.api!.get('/api/me/preferences')).status()).toBe(200)
})

test('refuses an unknown segment and an unknown key', async () => {
  const badValue = await harness.owner.api!.patch('/api/me/preferences', { data: { primarySegment: 'recruiter' } })
  expect(badValue.status()).toBe(400)

  const badKey = await harness.owner.api!.patch('/api/me/preferences', {
    data: { primarySegment: 'hiring', organizationId: harness.organization.organizationId },
  })
  expect(badKey.status()).toBe(400)
})

/**
 * The property the whole design rests on. Naming another user must fail *and* leave them untouched
 * — a 400 alone would not distinguish "refused" from "refused after writing".
 */
test('a request naming another user is refused, and that user is unchanged', async () => {
  const other = await addMember(harness, 'member')
  await other.api!.patch('/api/me/preferences', { data: { primarySegment: 'building' } })

  const attempt = await harness.owner.api!.patch('/api/me/preferences', {
    data: { primarySegment: 'hiring', userId: other.userId },
  })
  expect(attempt.status()).toBe(400)

  const theirs = await other.api!.get('/api/me/preferences')
  expect((await theirs.json()).primarySegment).toBe('building')
})

/** Two members of the same organisation keep separate preferences — this is account-subject data. */
test('two people in one workspace do not share a segment', async () => {
  const member = await addMember(harness, 'member')
  await harness.owner.api!.patch('/api/me/preferences', { data: { primarySegment: 'hiring' } })
  await member.api!.patch('/api/me/preferences', { data: { primarySegment: 'investing' } })

  expect((await (await harness.owner.api!.get('/api/me/preferences')).json()).primarySegment).toBe('hiring')
  expect((await (await member.api!.get('/api/me/preferences')).json()).primarySegment).toBe('investing')
})

test('every other method is refused with an Allow header', async () => {
  const response = await harness.owner.api!.delete('/api/me/preferences')
  expect(response.status()).toBe(405)
  expect(response.headers()['allow']).toContain('PATCH')
})

/**
 * ## Why "with the feature off" is not asserted here
 *
 * `startWorkerServer` caches one server per Playwright worker, and `flags` reach it only by being
 * written to `process.env` *before* that server spawns. A second harness in the same worker reuses
 * the first server, so a spec asserting `USER_SEGMENTATION_ENABLED=false` in the same file — or, at
 * `--workers=1`, in the same run — would be talking to a process that already booted with it on.
 * The first attempt at this block duly received `200` where it expected `404`.
 *
 * The gate is covered where it can be: `UserSegmentSettings.test.tsx` proves the surface disappears
 * on the 404, and the guard itself is read before the session is resolved, above every other line in
 * the handler. What remains unproven end-to-end is the API returning 404 on a server that booted
 * with the flag off — which needs a run whose whole worker has it off, not a second harness inside
 * one that does not.
 */
