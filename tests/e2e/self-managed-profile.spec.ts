/**
 * Self-managed profiles end to end (plan: phase-2/07-perfiles-autogestionados) — the attachment
 * and profile routes, then the editor and the public page that sit on them.
 *
 * Real Postgres with the real roles, real MinIO, real ClamAV, real EICAR — the same posture as
 * `documents.spec.ts`, because the properties under test are exactly the ones a fake would grant
 * for free: that an unscanned object is never signed, that a lying claim is rejected on the bytes,
 * and that the worker's verdict is what flips visibility.
 *
 * Profiles are created through their own route rather than seeded by SQL — once that route existed,
 * making the API its own fixture removed the last place this spec could disagree with production.
 * The one deliberate bypass is the scanner-leg test, which
 * promotes an EICAR object to `pending` by SQL — the upload policy has no magic-byte-less format,
 * so no EICAR body can pass completion honestly, and the worker's fail-closed behaviour still has
 * to hold if validation is ever sidestepped. That is defence in depth being tested as depth.
 */
import { createHash } from 'node:crypto'
import { AxeBuilder } from '@axe-core/playwright'
import type { APIRequestContext, Page } from 'playwright/test'
import { expect, test } from 'playwright/test'

import { buildPng } from '../unit/lib/storage/fixtures/documents'
import { newApiContext } from './harness/auth'
import { gotoHydrated, waitForHydration } from './harness/browser'
import {
  addMember,
  startInterviewHarness,
  stopInterviewHarness,
  type InterviewHarness,
} from './harness/fixtures/interviews'

let harness: InterviewHarness
let ownerProfileId: string
/**
 * One account for every browser test, reused.
 *
 * Better Auth rate-limits sign-up per IP and every virtual account in this file comes from one
 * host, so a fixture per test is a fixture budget the file cannot afford — it failed on the tenth
 * with a 429 that reads like a product bug. The profile is hard-deleted between tests instead,
 * which also side-steps the thirty-day handle hold a soft delete would leave behind.
 */
let uiBuilder: Awaited<ReturnType<typeof addMember>>

const PNG = Buffer.from(buildPng())

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The EICAR test string, assembled so this file is not itself flagged by a scanner. */
function eicarBytes(): Buffer {
  const parts = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}', '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*']
  return Buffer.from(parts.join(''), 'utf8')
}

/** Creates the caller's profile through the real route — the API is the seed. */
async function createProfileVia(api: APIRequestContext, handle: string): Promise<string> {
  const response = await api.post('/api/self-managed/profile', {
    data: { handle, displayName: handle, visibility: 'public' },
  })
  expect(response.status(), await response.text()).toBe(200)
  return (await response.json()).profile.id as string
}

function intentBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'work-sample',
    title: 'A work sample',
    declaredMediaType: 'image/png',
    declaredBytes: PNG.byteLength,
    ...overrides,
  }
}

async function createIntent(api: APIRequestContext, overrides: Record<string, unknown> = {}) {
  return api.post('/api/self-managed/attachments', { data: intentBody(overrides) })
}

/**
 * Puts the bytes at the presigned URL with a plain `fetch` — deliberately not through the app's
 * request context, because the point of a presigned PUT is that the object never passes through
 * the application.
 */
async function putObject(uploadUrl: string, body: Buffer, contentType: string): Promise<number> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: new Uint8Array(body),
  })
  return response.status
}

async function complete(api: APIRequestContext, attachmentId: string, sha: string) {
  return api.post(`/api/self-managed/attachments/${attachmentId}/complete`, { data: { sha256: sha } })
}

async function listAttachments(api: APIRequestContext) {
  const response = await api.get('/api/self-managed/attachments')
  expect(response.status()).toBe(200)
  return (await response.json()).attachments as Array<Record<string, unknown>>
}

async function runScanWorker() {
  const response = await harness.owner.api!.post('/api/admin/self-managed/run-worker', {
    headers: { 'x-cron-secret': process.env.CRON_SECRET ?? '' },
  })
  expect(response.status(), await response.text()).toBeLessThan(400)
  return (await response.json()) as Record<string, number>
}

/** Intent → PUT → complete, returning the id of a `pending` attachment. */
async function uploadPending(api: APIRequestContext, overrides: Record<string, unknown> = {}): Promise<string> {
  const intent = await createIntent(api, overrides)
  expect(intent.status(), await intent.text()).toBe(200)
  const { attachmentId, uploadUrl } = await intent.json()
  expect(await putObject(uploadUrl, PNG, 'image/png')).toBeLessThan(300)
  const completed = await complete(api, attachmentId, sha256(PNG))
  expect(completed.status(), await completed.text()).toBe(200)
  return attachmentId
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({ scope: 'smprof' })

  // MinIO and ClamAV come from docker-compose. Without them every assertion below would fail as a
  // storage error, which reads as a product bug rather than a missing container.
  const health = await harness.owner.api!.get('/api/health')
  expect(health.status(), 'the worker server is up').toBe(200)

  ownerProfileId = await createProfileVia(harness.owner.api!, 'smprof-ada')
  uiBuilder = await addMember(harness, 'member')
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

test.beforeEach(async () => {
  await harness.sql`delete from self_managed_attachments`
})

test('an unauthenticated request is refused', async () => {
  const anonymous = await newApiContext(harness.baseURL)
  try {
    expect((await anonymous.get('/api/self-managed/attachments')).status()).toBe(401)
    expect((await createIntent(anonymous)).status()).toBe(401)
  } finally {
    await anonymous.dispose()
  }
})

test('every other method is refused with an Allow header', async () => {
  const collection = await harness.owner.api!.put('/api/self-managed/attachments')
  expect(collection.status()).toBe(405)
  expect(collection.headers()['allow']).toContain('POST')

  const item = await harness.owner.api!.patch('/api/self-managed/attachments/nope')
  expect(item.status()).toBe(405)
  expect(item.headers()['allow']).toContain('DELETE')
})

test('a clean upload travels quarantine → scan → clean → signed download', async () => {
  const api = harness.owner.api!

  const attachmentId = await uploadPending(api)

  // Completed is not servable: the scanner has not spoken.
  let listed = await listAttachments(api)
  expect(listed).toHaveLength(1)
  expect(listed[0]).toMatchObject({ id: attachmentId, scanStatus: 'pending' })
  expect((await api.get(`/api/self-managed/attachments/${attachmentId}/download`)).status()).toBe(404)

  const run = await runScanWorker()
  expect(run.scannedClean).toBeGreaterThanOrEqual(1)

  listed = await listAttachments(api)
  expect(listed[0]).toMatchObject({ scanStatus: 'clean', mediaType: 'image/png' })
  // The DTO names its fields: no object key, no checksum, in any row.
  expect(Object.keys(listed[0]!)).not.toContain('storageKey')
  expect(Object.keys(listed[0]!)).not.toContain('checksumSha256')

  const download = await api.get(`/api/self-managed/attachments/${attachmentId}/download`)
  expect(download.status(), await download.text()).toBe(200)
  const signed = await download.json()
  expect(Object.keys(signed)).not.toContain('storageKey')

  // The signed URL serves exactly the bytes that were uploaded, and expires soon.
  const fetched = await fetch(signed.downloadUrl)
  expect(fetched.status).toBe(200)
  const served = new Uint8Array(await fetched.arrayBuffer())
  expect(sha256(served)).toBe(sha256(PNG))
  expect(new Date(signed.expiresAt).getTime() - Date.now()).toBeLessThan(24 * 60 * 60_000)
})

test('a body that is not what it claims is rejected at completion, not queued', async () => {
  const api = harness.owner.api!

  const intent = await createIntent(api)
  expect(intent.status()).toBe(200)
  const { attachmentId, uploadUrl } = await intent.json()

  const eicar = eicarBytes()
  expect(await putObject(uploadUrl, eicar, 'image/png')).toBeLessThan(300)

  const completed = await complete(api, attachmentId, sha256(eicar))
  expect(completed.status()).toBe(422)
  const refusal = await completed.json()
  expect(refusal.scanStatus).toBe('failed')
  expect(typeof refusal.rejectionCode).toBe('string')

  // The owner can read why; a stranger could never have seen the row at all.
  const listed = await listAttachments(api)
  expect(listed[0]).toMatchObject({ scanStatus: 'failed', rejectionCode: refusal.rejectionCode })
  expect((await api.get(`/api/self-managed/attachments/${attachmentId}/download`)).status()).toBe(404)
})

test('an infected object never reaches clean, even past validation', async () => {
  const api = harness.owner.api!

  const intent = await createIntent(api)
  expect(intent.status()).toBe(200)
  const { attachmentId, uploadUrl } = await intent.json()

  const eicar = eicarBytes()
  expect(await putObject(uploadUrl, eicar, 'image/png')).toBeLessThan(300)

  // Promote by SQL, deliberately skipping completion: the policy has no magic-byte-less format, so
  // no EICAR body can reach `pending` through the API — and the worker must hold regardless.
  await harness.sql`
    update self_managed_attachments
    set scan_status = 'pending', checksum_sha256 = ${sha256(eicar)}, size_bytes = ${eicar.byteLength}
    where id = ${attachmentId}`

  const run = await runScanWorker()
  expect(run.scannedInfected).toBeGreaterThanOrEqual(1)

  const listed = await listAttachments(api)
  expect(listed[0]!.scanStatus).toBe('infected')
  expect(typeof listed[0]!.rejectionCode).toBe('string')
  expect((await api.get(`/api/self-managed/attachments/${attachmentId}/download`)).status()).toBe(404)
})

test('another user’s attachment id reads as not found, in every handler', async () => {
  const owner = harness.owner.api!
  const other = await addMember(harness, 'member')
  await createProfileVia(other.api!, 'smprof-bob')

  const intent = await createIntent(owner)
  expect(intent.status()).toBe(200)
  const { attachmentId } = await intent.json()

  expect((await complete(other.api!, attachmentId, sha256(PNG))).status()).toBe(404)
  expect((await other.api!.get(`/api/self-managed/attachments/${attachmentId}/download`)).status()).toBe(404)
  expect((await other.api!.delete(`/api/self-managed/attachments/${attachmentId}`)).status()).toBe(404)

  // And nothing happened to the owner's row.
  const listed = await listAttachments(owner)
  expect(listed).toHaveLength(1)
  expect(listed[0]!.id).toBe(attachmentId)
})

test('a user with no profile gets a refusal they can act on', async () => {
  const profileless = await addMember(harness, 'member')
  const response = await createIntent(profileless.api!)
  expect(response.status()).toBe(404)
  expect((await response.json()).error).toBe('no-profile')
})

test('the twelve slots are reserved at intent, and a rejection hands its slot back', async () => {
  const api = harness.owner.api!

  const intents: string[] = []
  for (let index = 0; index < 12; index += 1) {
    const response = await createIntent(api, { title: `slot ${index}` })
    expect(response.status(), await response.text()).toBe(200)
    intents.push((await response.json()).attachmentId)
  }

  const thirteenth = await createIntent(api, { title: 'one too many' })
  expect(thirteenth.status()).toBe(409)
  expect((await thirteenth.json()).error).toBe('too-many')

  // Completing an intent whose bytes never arrived reports the missing upload and keeps the
  // reservation — an abandoned slot is the sweep's to reclaim, not the completion call's.
  const completed = await complete(api, intents[0]!, sha256(PNG))
  expect(completed.status()).toBe(400)
  expect((await completed.json()).error).toBe('upload_missing')

  // Deleting releases the slot immediately, and the fourteenth request fits.
  expect((await api.delete(`/api/self-managed/attachments/${intents[0]}`)).status()).toBe(200)
  const retry = await createIntent(api, { title: 'now it fits' })
  expect(retry.status(), await retry.text()).toBe(200)
})

test('one CV at a time, counted from the intent', async () => {
  const api = harness.owner.api!

  expect((await createIntent(api, { kind: 'cv', title: 'CV' })).status()).toBe(200)

  const second = await createIntent(api, { kind: 'cv', title: 'CV again' })
  expect(second.status()).toBe(409)
  expect((await second.json()).error).toBe('cv-exists')

  // A work sample is not a CV; the CV rule does not block it.
  expect((await createIntent(api, { title: 'not a cv' })).status()).toBe(200)
})

test('the profile lifecycle answers over the API: read, rename, visibility, duplicates', async () => {
  const api = harness.owner.api!

  // The caller's own profile reads back, dates as strings and no subject id.
  const own = await api.get('/api/self-managed/profile')
  expect(own.status()).toBe(200)
  const ownBody = (await own.json()).profile
  expect(ownBody).toMatchObject({ id: ownerProfileId, handle: 'smprof-ada', visibility: 'public' })
  expect(Object.keys(ownBody)).not.toContain('ownerUserId')

  // One live profile per account: a second create is a refusal, not a replacement.
  const duplicate = await api.post('/api/self-managed/profile', {
    data: { handle: 'smprof-ada-two', displayName: 'Ada again' },
  })
  expect(duplicate.status()).toBe(409)
  expect((await duplicate.json()).error).toBe('already-exists')

  // The handle oracle sees what the profile holds.
  expect(await (await api.get('/api/self-managed/handle/smprof-free')).json()).toMatchObject({ available: true })

  // Rename through the full update, addressed by id — a foreign id is a 404, the own id works.
  const foreign = await api.patch('/api/self-managed/profile/prof-not-mine', {
    data: { handle: 'smprof-ada', displayName: 'Ada' },
  })
  expect(foreign.status()).toBe(404)
  const renamed = await api.patch(`/api/self-managed/profile/${ownerProfileId}`, {
    data: { handle: 'smprof-ada', displayName: 'Ada Lovelace', visibility: 'public' },
  })
  expect(renamed.status(), await renamed.text()).toBe(200)
  expect((await renamed.json()).profile.displayName).toBe('Ada Lovelace')

  // Visibility moves on its own route, and comes back.
  const hidden = await api.patch('/api/self-managed/visibility', { data: { visibility: 'draft' } })
  expect(hidden.status()).toBe(200)
  expect((await (await api.get('/api/self-managed/profile')).json()).profile.visibility).toBe('draft')
  const restored = await api.patch('/api/self-managed/visibility', { data: { visibility: 'public' } })
  expect(restored.status()).toBe(200)
})

test('a reservation blocks a stranger and yields to its holder', async () => {
  const holder = await addMember(harness, 'member')
  const rival = await addMember(harness, 'member')

  const reserved = await holder.api!.post('/api/self-managed/handle/smprof-held/reserve')
  expect(reserved.status(), await reserved.text()).toBe(200)
  expect(typeof (await reserved.json()).expiresAt).toBe('string')

  // The rival sees it as taken and cannot create with it.
  expect(await (await rival.api!.get('/api/self-managed/handle/smprof-held')).json()).toMatchObject({ available: false })
  const stolen = await rival.api!.post('/api/self-managed/profile', {
    data: { handle: 'smprof-held', displayName: 'Rival' },
  })
  expect(stolen.status()).toBe(409)

  // The holder's own reservation is not an obstacle to the holder.
  await createProfileVia(holder.api!, 'smprof-held')
})

test('deleting the profile takes everything with it', async () => {
  const leaver = await addMember(harness, 'member')
  const profileId = await createProfileVia(leaver.api!, 'smprof-leaver')
  await uploadPending(leaver.api!)

  const deleted = await leaver.api!.delete(`/api/self-managed/profile/${profileId}`)
  expect(deleted.status()).toBe(200)

  // The profile is gone, the attachments have no profile to hang off, and new uploads are refused
  // with the reason the caller can act on.
  expect((await leaver.api!.get('/api/self-managed/profile')).status()).toBe(404)
  expect(await listAttachments(leaver.api!)).toHaveLength(0)
  const orphanIntent = await createIntent(leaver.api!)
  expect(orphanIntent.status()).toBe(404)
  expect((await orphanIntent.json()).error).toBe('no-profile')

  // The thirty-day handle hold, through the real app role — the property RLS silently voided until
  // 0177: a stranger sees the freed handle as taken, and cannot create over it.
  const vulture = await addMember(harness, 'member')
  expect(await (await vulture.api!.get('/api/self-managed/handle/smprof-leaver')).json()).toMatchObject({
    available: false,
  })
  const squat = await vulture.api!.post('/api/self-managed/profile', {
    data: { handle: 'smprof-leaver', displayName: 'Vulture' },
  })
  expect(squat.status()).toBe(409)
  expect((await squat.json()).error).toBe('handle-taken')
})

test('soft delete hides it, releases its slot, and is idempotent-ish about honesty', async () => {
  const api = harness.owner.api!

  const attachmentId = await uploadPending(api)
  await runScanWorker()
  expect((await api.get(`/api/self-managed/attachments/${attachmentId}/download`)).status()).toBe(200)

  const deleted = await api.delete(`/api/self-managed/attachments/${attachmentId}`)
  expect(deleted.status()).toBe(200)

  expect(await listAttachments(api)).toHaveLength(0)
  expect((await api.get(`/api/self-managed/attachments/${attachmentId}/download`)).status()).toBe(404)
  // A second delete is nothing to do, and reads exactly like an id that never existed.
  expect((await api.delete(`/api/self-managed/attachments/${attachmentId}`)).status()).toBe(404)
})

// ── The editor and the public page ────────────────────────────────────────────────────────────
//
// Driven through the browser rather than the API, because what this half of the plan promises is
// visual: a reader must know in one glance that nothing here is verified, and the owner must be
// able to get there without an API client. Anonymous reads are asserted against the *served HTML*
// with a request context, not a hydrated page — a crawler is the reader whose mistake would matter
// most, and hydration would paper over a page that renders nothing server-side.

/** Fails on the two severities the release gate fails on. */
async function expectNoSeriousAxeViolations(page: Page, testId: string) {
  const results = await new AxeBuilder({ page }).include(`[data-testid="${testId}"]`).analyze()
  const serious = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')
  expect(serious.map((v) => `${v.id}: ${v.nodes.length} node(s)`)).toEqual([])
}

async function signedInPage(page: Page, principal: { storageState: { cookies: Array<Record<string, unknown>> } | null }) {
  await page.context().addCookies(principal.storageState!.cookies as never)
  return page
}

/**
 * Open a page as the signed-in owner, past the terms modal.
 *
 * A fresh account meets that modal before it meets anything else, and it is modal in the real sense
 * — it intercepts pointer events, so every click below times out behind it. The check has to run
 * *after* hydration: the modal is client-rendered, so an earlier `count()` is always zero and the
 * skip looks like a pass. Accepting it is what a person does; seeding the consent instead would
 * test a state no new builder is ever in.
 */
/** Hard delete, so the handle is free again and the next test starts from nothing. */
async function resetUiBuilderProfile() {
  await harness.sql`delete from self_managed_profiles where owner_user_id = ${uiBuilder.userId!}`
}

async function openAsOwner(page: Page, url: string) {
  await gotoHydrated(page, url)
  const accept = page.getByTestId('tos-modal-accept')
  if (await accept.count() > 0) {
    await accept.first().click()
    await expect(page.getByTestId('tos-modal')).toHaveCount(0)
  }
}

test('the editor creates a profile, publishes it, and uploads a work sample', async ({ page }) => {
  await resetUiBuilderProfile()
  await signedInPage(page, uiBuilder)

  await openAsOwner(page, `${harness.baseURL}/me/profile`)
  await expect(page.getByTestId('self-managed-editor')).toBeVisible()

  // Nothing is verified here, and the editor says so before anything is typed.
  await expect(page.getByTestId('self-managed-chip').first()).toBeVisible()

  await page.locator('#profile-handle').fill('smprof-editor')
  await page.locator('#profile-name').fill('Edie Editor')
  await page.locator('#profile-headline').fill('Technical translator, es↔en')
  await page.locator('#profile-bio').fill('Twelve years of documentation nobody had to reread.')
  await page.locator('#profile-languages').fill('es, en')
  await page.getByTestId('profile-save').click()
  await expect(page.getByTestId('profile-message')).toHaveText('Saved.')

  // Publishing is its own decision, on its own control.
  await page.getByTestId('visibility-public').click()
  await expect(page.getByTestId('view-public-profile')).toBeVisible()

  // The three-call upload: intent, a PUT the app never sees, then completion.
  await page.locator('#attachment-title').fill('A translated manual')
  await page.locator('#attachment-file').setInputFiles({
    name: 'sample.png',
    mimeType: 'image/png',
    buffer: PNG,
  })
  await page.getByTestId('attachment-upload').click()
  await expect(page.getByTestId('attachment-status')).toHaveText(/Checking for viruses/)

  await runScanWorker()
  await page.reload()
  await waitForHydration(page)
  await expect(page.getByTestId('attachment-status')).toHaveText(/Published/)

  await expectNoSeriousAxeViolations(page, 'self-managed-editor')
})

test('a stranger reads the published page, chip and caveat included, with no verified token', async ({ page }) => {
  // Its own fixture rather than the editor test's: `beforeEach` clears every attachment, so a page
  // seeded two tests ago is a page with nothing on it — and a public-page assertion that depends on
  // the order tests happen to run in is one that fails for a reason nobody will look for here.
  await resetUiBuilderProfile()
  const profileId = await createProfileVia(uiBuilder.api!, 'smprof-public')
  await uiBuilder.api!.patch(`/api/self-managed/profile/${profileId}`, {
    data: { handle: 'smprof-public', displayName: 'Pia Public', headline: 'Technical translator, es↔en', visibility: 'public' },
  })
  await uploadPending(uiBuilder.api!, { title: 'A translated manual' })
  await runScanWorker()

  const anonymous = await newApiContext(harness.baseURL)
  try {
    const served = await anonymous.get('/u/smprof-public')
    expect(served.status()).toBe(200)
    const html = await served.text()

    // Server-rendered, so a crawler sees the same page a person does.
    expect(html).toContain('Pia Public')
    expect(html).toContain('Self-managed')
    expect(html).toContain('BuilderHunt has not verified any of it')
    expect(html).toContain('A translated manual')
    // The one visual token this surface may never borrow.
    expect(html).not.toContain('>Verified<')
    // And nothing that names an object, a hash or a scan verdict.
    expect(html).not.toContain('quarantine/')
    expect(html).not.toContain('clean/self-managed')
    // Public, so it is indexable — the noindex case is the next test.
    expect(html).not.toMatch(/name="robots"[^>]*noindex/)
  } finally {
    await anonymous.dispose()
  }

  await gotoHydrated(page, `${harness.baseURL}/u/smprof-public`)
  await expect(page.getByTestId('self-managed-profile')).toBeVisible()
  await expect(page.getByTestId('self-managed-attachments').getByText('A translated manual')).toBeVisible()
  await expectNoSeriousAxeViolations(page, 'self-managed-profile')
})

test('draft is a 404 and unlisted is a 200 that carries noindex', async ({ page }) => {
  await resetUiBuilderProfile()
  await createProfileVia(uiBuilder.api!, 'smprof-states')
  const builder = uiBuilder
  const anonymous = await newApiContext(harness.baseURL)

  try {
    // Draft: indistinguishable from a handle nobody ever took.
    await builder.api!.patch('/api/self-managed/visibility', { data: { visibility: 'draft' } })
    const draft = await anonymous.get('/u/smprof-states')
    const absent = await anonymous.get('/u/smprof-never-existed')
    expect(draft.status()).toBe(404)
    expect(absent.status()).toBe(404)

    // Unlisted: reachable by link, kept out of the index — and `googlebot` too, because the root
    // sets its own and Google honours the named tag over the generic one.
    await builder.api!.patch('/api/self-managed/visibility', { data: { visibility: 'unlisted' } })
    const unlisted = await anonymous.get('/u/smprof-states')
    expect(unlisted.status()).toBe(200)
    const html = await unlisted.text()
    expect(html).toContain('noindex')
    expect(html).toMatch(/name="googlebot"[^>]*noindex/)

    // Public again: the noindex goes away rather than sticking to the handle.
    await builder.api!.patch('/api/self-managed/visibility', { data: { visibility: 'public' } })
    const republished = await anonymous.get('/u/smprof-states')
    expect(await republished.text()).not.toMatch(/name="robots"[^>]*noindex/)
  } finally {
    await anonymous.dispose()
  }

  // A malformed handle is a 404 rather than a 500 from the inner validator.
  const malformed = await page.goto(`${harness.baseURL}/u/NOT_A_HANDLE`)
  expect(malformed?.status()).toBe(404)
})

test('publishing indexes the profile for semantic search, and hiding it removes the row', async () => {
  await resetUiBuilderProfile()
  const profileId = await createProfileVia(uiBuilder.api!, 'smprof-semantic')

  const indexed = async () => harness.sql`
    select source_id, document from builder_embeddings
    where entity_kind = 'self_managed_person' and source_id = ${profileId}`

  // Polled, not asserted once: create and update fire the index write off the response path on
  // purpose, so a slow index cannot make saving a profile slow. Removal is the half that is
  // awaited, and the assertions below say so by not polling.
  await expect.poll(async () => (await indexed()).length).toBe(1)
  expect((await indexed())[0]!.document).toContain('declared by its owner, not verified')

  // A clean attachment's words join the document — that is the "clean-scan" event.
  await uploadPending(uiBuilder.api!, { title: 'A translated manual' })
  await runScanWorker()
  await expect.poll(async () => (await indexed())[0]?.document ?? '').toContain('A translated manual')

  // Draft takes it out immediately, on the request path rather than at the next reconciliation.
  const hidden = await uiBuilder.api!.patch('/api/self-managed/visibility', { data: { visibility: 'draft' } })
  expect(hidden.status()).toBe(200)
  expect(await indexed()).toHaveLength(0)

  // And publishing again puts it back.
  await uiBuilder.api!.patch('/api/self-managed/visibility', { data: { visibility: 'public' } })
  expect(await indexed()).toHaveLength(1)

  // Deleting the profile removes it too, and the row is gone before the response returns.
  await uiBuilder.api!.delete(`/api/self-managed/profile/${profileId}`)
  expect(await indexed()).toHaveLength(0)
})

test('a pending attachment is the owner’s alone until the scanner clears it', async ({ page }) => {
  await resetUiBuilderProfile()
  await createProfileVia(uiBuilder.api!, 'smprof-pending')
  await uploadPending(uiBuilder.api!)
  const builder = uiBuilder

  const anonymous = await newApiContext(harness.baseURL)
  try {
    const html = await (await anonymous.get('/u/smprof-pending')).text()
    // The page is there; the unscanned attachment is not.
    expect(html).toContain('smprof-pending')
    expect(html).toContain('Nothing attached yet')
  } finally {
    await anonymous.dispose()
  }

  // The owner sees it, with the honest interim state rather than an empty list.
  await signedInPage(page, builder)
  await openAsOwner(page, `${harness.baseURL}/me/profile`)
  await expect(page.getByTestId('attachment-status')).toHaveText(/Checking for viruses/)
})
