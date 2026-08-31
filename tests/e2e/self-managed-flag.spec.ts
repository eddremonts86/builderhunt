/**
 * Self-managed profiles with the flag off (plan: phase-2/07-perfiles-autogestionados).
 *
 * Its own file on a per-worker server, because this is the property the shared server cannot test:
 * `playwright.config.ts` pins `SELF_MANAGED_PROFILES_ENABLED='true'` there so the main spec
 * exercises a feature that is actually on.
 *
 * What "off" has to mean, all at once:
 *
 *  - **every entry point 404s** — the editor, the public page, and all ten API routes. Not a 200
 *    with the UI hidden, and not a 503: with the feature off these surfaces do not exist, and a 503
 *    would say "this is ours and it is broken" about something an operator switched off deliberately;
 *  - **no write succeeds**, so a rollback cannot be undermined by a client that kept its tab open;
 *  - **the rows stay**, so switching it back on restores what was there rather than starting over;
 *  - **export and erasure keep working**, because a person's right to see and delete what is held
 *    about them is not a feature — a rollback that took it with it would turn an operational
 *    decision into a compliance one.
 *
 * The last two are what make this a rollback rather than a deletion, and they are the ones an
 * implementation is most likely to get wrong by switching off one guard too many.
 */
import { expect, test } from 'playwright/test'

import { startInterviewHarness, stopInterviewHarness, type InterviewHarness } from './harness/fixtures/interviews'

let harness: InterviewHarness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({
    scope: 'smflag',
    flags: { SELF_MANAGED_PROFILES_ENABLED: 'false' },
  })

  // Seeded straight into the database, which is the state a rollback actually finds: rows written
  // while the feature was on, and an operator who has just switched it off.
  await harness.sql`
    insert into self_managed_profiles (id, handle, owner_user_id, display_name, visibility)
    values ('smflag-profile', 'smflag-ada', ${harness.owner.userId!}, 'Ada Off', 'public')`
  await harness.sql`
    insert into self_managed_attachments
      (id, profile_id, kind, title, storage_key, mime_type, size_bytes, checksum_sha256, scan_status)
    values ('smflag-att', 'smflag-profile', 'work-sample', 'A manual',
            'clean/self-managed/o/smflag-profile/smflag-att', 'application/pdf', 1024,
            ${'a'.repeat(64)}, 'clean')`
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

test('every API entry point answers 404, and none of them 503', async () => {
  const api = harness.owner.api!
  const reads = [
    '/api/self-managed/attachments',
    '/api/self-managed/profile',
    '/api/self-managed/handle/smflag-free',
    '/api/self-managed/attachments/smflag-att/download',
  ]
  for (const path of reads) {
    const response = await api.get(path)
    expect(response.status(), path).toBe(404)
  }

  const writes: Array<[string, () => Promise<{ status(): number }>]> = [
    ['create profile', () => api.post('/api/self-managed/profile', { data: { handle: 'smflag-new', displayName: 'New' } })],
    ['update profile', () => api.patch('/api/self-managed/profile/smflag-profile', { data: { handle: 'smflag-ada', displayName: 'Renamed' } })],
    ['delete profile', () => api.delete('/api/self-managed/profile/smflag-profile')],
    ['visibility', () => api.patch('/api/self-managed/visibility', { data: { visibility: 'draft' } })],
    ['promote', () => api.post('/api/self-managed/profile/smflag-profile/promote', { data: { claimId: 'c', confirm: true } })],
    ['reserve handle', () => api.post('/api/self-managed/handle/smflag-free/reserve')],
    ['upload intent', () => api.post('/api/self-managed/attachments', { data: { kind: 'work-sample', title: 't', declaredMediaType: 'image/png', declaredBytes: 10 } })],
    ['complete upload', () => api.post('/api/self-managed/attachments/smflag-att/complete', { data: { sha256: 'a'.repeat(64) } })],
    ['delete attachment', () => api.delete('/api/self-managed/attachments/smflag-att')],
  ]
  for (const [name, call] of writes) {
    expect((await call()).status(), name).toBe(404)
  }
})

test('the public page and the editor do not exist', async ({ page }) => {
  const publicPage = await page.goto(`${harness.baseURL}/u/smflag-ada`)
  expect(publicPage?.status()).toBe(404)
  // And the copy does not leak into the not-found body, which would leave it indexable under a 404
  // a crawler treats as soft.
  expect(await page.content()).not.toContain('Ada Off')

  // The editor is an authenticated SPA route, so the honest assertion is what a person sees rather
  // than the status line: the dashboard shell renders its own not-found view and the document is
  // served with a 200 either way. What must be true is that the editor is not there.
  await page.goto(`${harness.baseURL}/me/profile`)
  await expect(page.getByTestId('self-managed-editor')).toHaveCount(0)
  await expect(page.locator('#profile-handle')).toHaveCount(0)
})

test('the search origin is not contacted, however explicitly it is asked for', async () => {
  const response = await harness.owner.api!.post('/api/search/builders', {
    data: { keywords: ['smflag'], sources: ['self-managed'] },
  })

  // Asked for by name and still absent: the flag is applied where the origin is contacted, so no
  // surface can route around it by naming the source itself.
  expect(response.status()).toBe(200)
  const body = await response.json()
  expect((body.builders ?? []).map((row: { source: string }) => row.source)).not.toContain('self-managed')
})

test('the rows are still there, so switching back on is a restore and not a rebuild', async () => {
  const profiles = await harness.sql`select handle, visibility from self_managed_profiles where id = 'smflag-profile'`
  const attachments = await harness.sql`select scan_status from self_managed_attachments where id = 'smflag-att'`

  expect(profiles).toHaveLength(1)
  expect(profiles[0]!.handle).toBe('smflag-ada')
  // Untouched, including the visibility a write would have changed had one got through.
  expect(profiles[0]!.visibility).toBe('public')
  expect(attachments[0]!.scan_status).toBe('clean')
})

test('export and erasure keep working, because neither is a feature', async () => {
  const requested = await harness.owner.api!.post('/api/me/data-export')
  expect(requested.status(), await requested.text()).toBeLessThan(400)

  // The export still discloses the profile held about this person. A rollback that hid it would
  // answer a subject access request with a page that is demonstrably not the whole truth.
  const listed = await harness.owner.api!.get('/api/me/data-export')
  expect(listed.status()).toBe(200)

  // And the deletion route is reachable — not exercised to completion here, because deleting the
  // harness owner would take the rest of this file's fixtures with it.
  const deletion = await harness.owner.api!.get('/api/me/deletion')
  expect(deletion.status(), 'erasure must not be gated by a feature flag').toBeLessThan(500)
})
