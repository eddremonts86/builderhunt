/**
 * Self-managed attachment routes, end to end (plan: phase-2/07-perfiles-autogestionados,
 * "Expose upload intent, completion, download, and deletion routes").
 *
 * Real Postgres with the real roles, real MinIO, real ClamAV, real EICAR — the same posture as
 * `documents.spec.ts`, because the properties under test are exactly the ones a fake would grant
 * for free: that an unscanned object is never signed, that a lying claim is rejected on the bytes,
 * and that the worker's verdict is what flips visibility.
 *
 * Profiles are seeded straight into the database: the profile CRUD routes belong to the next task,
 * and this spec is about attachments. The one deliberate bypass is the scanner-leg test, which
 * promotes an EICAR object to `pending` by SQL — the upload policy has no magic-byte-less format,
 * so no EICAR body can pass completion honestly, and the worker's fail-closed behaviour still has
 * to hold if validation is ever sidestepped. That is defence in depth being tested as depth.
 */
import { createHash } from 'node:crypto'
import type { APIRequestContext } from 'playwright/test'
import { expect, test } from 'playwright/test'

import { buildPng } from '../unit/lib/storage/fixtures/documents'
import { newApiContext } from './harness/auth'
import {
  addMember,
  startInterviewHarness,
  stopInterviewHarness,
  type InterviewHarness,
} from './harness/fixtures/interviews'

let harness: InterviewHarness

const PNG = Buffer.from(buildPng())

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The EICAR test string, assembled so this file is not itself flagged by a scanner. */
function eicarBytes(): Buffer {
  const parts = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}', '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*']
  return Buffer.from(parts.join(''), 'utf8')
}

async function seedProfile(userId: string, handle: string): Promise<string> {
  const id = `smp-${handle}`
  await harness.sql`
    insert into self_managed_profiles (id, handle, owner_user_id, display_name, visibility)
    values (${id}, ${handle}, ${userId}, ${handle}, 'public')`
  return id
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

  await seedProfile(harness.owner.userId!, 'smprof-ada')
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
  await seedProfile(other.userId!, 'smprof-bob')

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
