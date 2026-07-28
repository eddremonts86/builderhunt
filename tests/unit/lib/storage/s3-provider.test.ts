/**
 * These run against the real MinIO from `docker compose --profile interviews`,
 * not a mocked S3 client. A mock would assert that the adapter calls the SDK the
 * way the adapter calls the SDK, which is a tautology; what is worth knowing is
 * whether MinIO accepts what it sends — path-style addressing, presigned PUT
 * semantics, and whether a delete on a missing key throws or not are all
 * server-side behaviours a mock invents.
 *
 * Skipped when no store is configured, so a checkout without the interviews
 * profile running still passes rather than failing for the wrong reason.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { S3StorageProvider } from '~/lib/storage/s3-provider'
import { StorageProviderError } from '~/lib/storage/types'

const endpoint = process.env.INTERVIEW_R2_ENDPOINT
const bucket = process.env.INTERVIEW_R2_BUCKET
const accessKeyId = process.env.INTERVIEW_R2_ACCESS_KEY_ID
const secretAccessKey = process.env.INTERVIEW_R2_SECRET_ACCESS_KEY
const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey)

describe.skipIf(!configured)('S3StorageProvider against a real object store', () => {
  let provider: S3StorageProvider
  const prefix = `test/${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const written: string[] = []

  beforeAll(() => {
    provider = new S3StorageProvider({
      endpoint: endpoint!, bucket: bucket!, accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!,
    })
  })

  afterAll(async () => {
    for (const key of written) await provider.deleteObject({ key }).catch(() => undefined)
  })

  async function put(key: string, body: string, contentType = 'application/pdf'): Promise<void> {
    const signed = await provider.createSignedUploadUrl({ key, contentType, maxBytes: 1024 })
    const response = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body })
    expect(response.ok, `upload failed: ${response.status}`).toBe(true)
    written.push(key)
  }

  it('signs an upload a plain HTTP client can actually complete', async () => {
    const key = `${prefix}/cv.pdf`
    await put(key, 'a candidate cv')
    const head = await provider.headObject({ key })
    expect(head?.bytes).toBe('a candidate cv'.length)
    expect(head?.contentType).toBe('application/pdf')
  })

  it('binds the signed url to the declared content type', async () => {
    const key = `${prefix}/typed.pdf`
    const signed = await provider.createSignedUploadUrl({ key, contentType: 'application/pdf', maxBytes: 1024 })
    // The content type is part of the signature, so a client that announces a
    // different one is rejected by the store rather than silently storing a
    // mislabelled object.
    const response = await fetch(signed.url, {
      method: 'PUT',
      headers: { ...signed.headers, 'content-type': 'text/html' },
      body: '<script>alert(1)</script>',
    })
    expect(response.ok).toBe(false)
  })

  it('does NOT enforce maxBytes at the url — the caller must check afterwards', async () => {
    // Pinning the documented weakness so nobody later reads
    // `createSignedUploadUrl({ maxBytes })` as a guarantee. If a future S3
    // implementation starts rejecting this, that is good news and this test
    // should be rewritten, not deleted.
    const key = `${prefix}/oversized.pdf`
    const signed = await provider.createSignedUploadUrl({ key, contentType: 'application/pdf', maxBytes: 4 })
    const response = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: 'x'.repeat(500) })
    expect(response.ok, 'a presigned PUT cannot cap the body').toBe(true)
    written.push(key)

    const head = await provider.headObject({ key })
    expect(head?.bytes, 'the real size is only knowable from headObject').toBe(500)
  })

  it('returns null rather than throwing for an object that is not there', async () => {
    expect(await provider.headObject({ key: `${prefix}/never-written.pdf` })).toBeNull()
  })

  it('signs a download that serves the bytes back', async () => {
    const key = `${prefix}/download.pdf`
    await put(key, 'downloadable')
    const signed = await provider.createSignedDownloadUrl({ key, expiresInSeconds: 60 })
    const response = await fetch(signed.url)
    expect(response.ok).toBe(true)
    expect(await response.text()).toBe('downloadable')
  })

  it('streams the bytes back for the scanner', async () => {
    const key = `${prefix}/scannable.pdf`
    await put(key, 'bytes for clamd')
    const object = await provider.readObject({ key })
    expect(object.bytes).toBe('bytes for clamd'.length)

    const chunks: Uint8Array[] = []
    for await (const chunk of object.stream) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString()).toBe('bytes for clamd')
  })

  it('throws rather than yielding an empty stream for a missing object', async () => {
    // The distinction that matters: `headObject` answers null because absence
    // is a legitimate answer, but a zero-byte stream handed to clamd comes back
    // `clean`. Reading something that is not there has to be an error.
    await expect(provider.readObject({ key: `${prefix}/not-here.pdf` })).rejects.toMatchObject({
      name: 'StorageProviderError',
      code: 'not_found',
    })
  })

  it('moves an object and leaves nothing behind at the source', async () => {
    const from = `${prefix}/quarantine/scan-me.pdf`
    const to = `${prefix}/clean/scanned.pdf`
    await put(from, 'scanned clean')
    await provider.moveObject({ fromKey: from, toKey: to })
    written.push(to)

    expect(await provider.headObject({ key: from }), 'the source must be gone').toBeNull()
    const moved = await provider.headObject({ key: to })
    expect(moved?.bytes).toBe('scanned clean'.length)
  })

  it('treats deleting an absent object as success', async () => {
    // S3 answers 204 for a key that never existed. The retention worker depends
    // on that: a re-run after a partial failure must not error on the documents
    // it already removed.
    await expect(provider.deleteObject({ key: `${prefix}/absent.pdf` })).resolves.toBeUndefined()
  })
})

describe('object key validation', () => {
  const provider = new S3StorageProvider({
    endpoint: 'http://127.0.0.1:9000', bucket: 'irrelevant', accessKeyId: 'k', secretAccessKey: 's',
  })

  // No network involved: these must be rejected before a request is built.
  it.each([
    ['empty', ''],
    ['absolute', '/org/sub/cv.pdf'],
    ['empty segment', 'org//cv.pdf'],
    ['parent traversal', 'org/../../etc/passwd'],
    ['current-dir segment', 'org/./cv.pdf'],
    ['control character', 'org/cv\u0007.pdf'],
  ])('rejects a %s key', async (_label, key) => {
    await expect(provider.headObject({ key })).rejects.toMatchObject({
      name: 'StorageProviderError',
      code: 'invalid_key',
    })
  })

  it('rejects a non-positive maxBytes', async () => {
    await expect(
      provider.createSignedUploadUrl({ key: 'org/cv.pdf', contentType: 'application/pdf', maxBytes: 0 }),
    ).rejects.toBeInstanceOf(StorageProviderError)
  })

  it('refuses a download url that outlives an hour', async () => {
    await expect(
      provider.createSignedDownloadUrl({ key: 'org/cv.pdf', expiresInSeconds: 3601 }),
    ).rejects.toMatchObject({ code: 'invalid_key' })
  })
})
