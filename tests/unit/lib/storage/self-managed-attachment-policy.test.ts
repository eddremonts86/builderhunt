/**
 * @vitest-environment node
 *
 * The self-managed attachment contract (plan: phase-2/07-perfiles-autogestionados, task 3).
 *
 * A policy over the existing validator rather than a second validator, so most of what protects
 * these uploads is already proved by `document-validation.test.ts` and is not repeated here. What
 * *is* worth proving is the part a policy can get wrong on its own: that the seven formats the spec
 * names are accepted, that the three the candidate path accepts are not silently inherited, that
 * the cap moved from 10 MB to 25 MB, and that the shared checks still fire under the new policy
 * rather than being bypassed along with the format list.
 */
import { describe, expect, it } from 'vitest'

import {
  CANDIDATE_DOCUMENT_POLICY,
  DOCX_MEDIA_TYPE,
  PDF_MEDIA_TYPE,
  SELF_MANAGED_ATTACHMENT_POLICY,
  TXT_MEDIA_TYPE,
  sha256Hex,
  validateDocument,
} from '~/lib/storage/document-validation'
import {
  CLEAN_PREFIX,
  ObjectKeyError,
  QUARANTINE_PREFIX,
  cleanKeyFor,
  isSelfManagedKey,
  quarantineKeyFor,
  selfManagedQuarantineKeyFor,
} from '~/lib/storage/object-keys'
import { buildDocx, buildJpeg, buildMp3, buildMp4, buildPdf, buildPng, buildWav, buildWebp } from './fixtures/documents'

function claim(body: Uint8Array, originalName: string, declaredMediaType: string) {
  return {
    originalName,
    declaredMediaType,
    declaredBytes: body.byteLength,
    declaredSha256: sha256Hex(body),
    body,
    policy: SELF_MANAGED_ATTACHMENT_POLICY,
  }
}

describe('the seven formats the spec names', () => {
  const cases: ReadonlyArray<[string, Uint8Array, string, string]> = [
    ['pdf', buildPdf(['A work sample']), 'sample.pdf', PDF_MEDIA_TYPE],
    ['png', buildPng(), 'shot.png', 'image/png'],
    ['jpeg', buildJpeg(), 'shot.jpg', 'image/jpeg'],
    ['webp', buildWebp(), 'shot.webp', 'image/webp'],
    ['mp3', buildMp3(), 'talk.mp3', 'audio/mpeg'],
    ['wav', buildWav(), 'talk.wav', 'audio/wav'],
    ['mp4', buildMp4(), 'clip.mp4', 'video/mp4'],
  ]

  it.each(cases)('accepts a %s', async (_name, body, fileName, mediaType) => {
    const result = await validateDocument(claim(body, fileName, mediaType))
    expect(result.mediaType).toBe(mediaType)
    expect(result.bytes).toBe(body.byteLength)
  })

  it('accepts .jpeg as well as .jpg, because both name the same format', async () => {
    await expect(validateDocument(claim(buildJpeg(), 'shot.jpeg', 'image/jpeg'))).resolves.toMatchObject({
      kind: 'image',
    })
  })
})

describe('what the policy does not accept', () => {
  it('refuses text/plain, which the candidate path allows', async () => {
    const body = new TextEncoder().encode('a plain CV')

    await expect(validateDocument(claim(body, 'cv.txt', TXT_MEDIA_TYPE))).rejects.toMatchObject({
      code: 'unsupported_media_type',
    })
    // The same bytes under the other policy are fine — which is what makes this a policy decision
    // and not a validator that lost a format.
    await expect(
      validateDocument({
        originalName: 'cv.txt',
        declaredMediaType: TXT_MEDIA_TYPE,
        declaredBytes: body.byteLength,
        declaredSha256: sha256Hex(body),
        body,
        policy: CANDIDATE_DOCUMENT_POLICY,
      }),
    ).resolves.toMatchObject({ kind: 'txt' })
  })

  it('refuses docx, for the same reason', async () => {
    const body = buildDocx([{ text: 'A CV' }])
    await expect(validateDocument(claim(body, 'cv.docx', DOCX_MEDIA_TYPE))).rejects.toMatchObject({
      code: 'unsupported_media_type',
    })
  })

  it('names the policy that refused, not just that something did', async () => {
    const body = buildDocx([{ text: 'A CV' }])
    await expect(validateDocument(claim(body, 'cv.docx', DOCX_MEDIA_TYPE))).rejects.toThrow(
      /self-managed-attachment/,
    )
  })
})

describe('the shared checks still fire under the new policy', () => {
  it('rejects a jpeg renamed to .png — the bytes decide, not the name', async () => {
    await expect(validateDocument(claim(buildJpeg(), 'shot.png', 'image/png'))).rejects.toMatchObject({
      code: 'media_type_mismatch',
    })
  })

  it('rejects a declared media type that disagrees with the extension', async () => {
    await expect(validateDocument(claim(buildPng(), 'shot.jpg', 'image/png'))).rejects.toMatchObject({
      code: 'extension_mismatch',
    })
  })

  it('rejects a hash that does not match the bytes', async () => {
    const body = buildPng()
    await expect(
      validateDocument({ ...claim(body, 'shot.png', 'image/png'), declaredSha256: 'f'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'checksum_mismatch' })
  })

  it('rejects a declared length that does not match the object', async () => {
    const body = buildPng()
    await expect(
      validateDocument({ ...claim(body, 'shot.png', 'image/png'), declaredBytes: body.byteLength + 1 }),
    ).rejects.toMatchObject({ code: 'size_mismatch' })
  })

  it('rejects an empty file', async () => {
    await expect(validateDocument(claim(new Uint8Array(0), 'shot.png', 'image/png'))).rejects.toMatchObject({
      code: 'empty_file',
    })
  })

  it('still refuses an encrypted pdf, which is the candidate path’s check reused', async () => {
    const body = buildPdf(['Secret'], { encrypted: true })
    await expect(validateDocument(claim(body, 'sample.pdf', PDF_MEDIA_TYPE))).rejects.toMatchObject({
      code: 'encrypted_document',
    })
  })
})

describe('the byte cap', () => {
  it('is 25 MB here and 10 MB on the candidate path', () => {
    expect(SELF_MANAGED_ATTACHMENT_POLICY.maxBytes).toBe(25 * 1024 * 1024)
    expect(CANDIDATE_DOCUMENT_POLICY.maxBytes).toBe(10 * 1024 * 1024)
  })

  it('refuses a file past the cap', async () => {
    // A real 25 MB fixture would make this test cost a second for nothing; the check is on
    // `byteLength`, so a sparse array of the right size exercises the same branch.
    const body = new Uint8Array(SELF_MANAGED_ATTACHMENT_POLICY.maxBytes + 1)
    body.set(buildPng())

    await expect(validateDocument(claim(body, 'shot.png', 'image/png'))).rejects.toMatchObject({
      code: 'too_large',
    })
  })
})

describe('object keys', () => {
  const key = selfManagedQuarantineKeyFor({
    ownerUserId: 'user-abc',
    profileId: 'profile-def',
    attachmentId: 'att-123',
  })

  it('writes under quarantine and never under clean', () => {
    expect(key.startsWith(QUARANTINE_PREFIX)).toBe(true)
    expect(key.startsWith(CLEAN_PREFIX)).toBe(false)
  })

  it('holds no filename, no handle and no display name', () => {
    expect(key).toBe('quarantine/self-managed/user-abc/profile-def/att-123')
    expect(key).not.toMatch(/\.(pdf|png|jpe?g|webp|mp3|wav|mp4)$/)
  })

  it('is a different space from a candidate document key of the same shape', () => {
    const candidate = quarantineKeyFor({ organizationId: 'user-abc', submissionId: 'profile-def', documentId: 'att-123' })

    // Same three segments, same prefix — and still not the same key. Without the infix these would
    // collide, and a download route authorizing one space would resolve an object from the other.
    expect(candidate).toBe('quarantine/user-abc/profile-def/att-123')
    expect(candidate).not.toBe(key)
    expect(isSelfManagedKey(key)).toBe(true)
    expect(isSelfManagedKey(candidate)).toBe(false)
  })

  it('survives promotion to the clean prefix, space intact', () => {
    const promoted = cleanKeyFor(key)
    expect(promoted).toBe('clean/self-managed/user-abc/profile-def/att-123')
    expect(isSelfManagedKey(promoted)).toBe(true)
  })

  it('refuses an id that would change the key’s shape', () => {
    expect(() =>
      selfManagedQuarantineKeyFor({ ownerUserId: '../other', profileId: 'p', attachmentId: 'a' }),
    ).toThrow(ObjectKeyError)
    expect(() =>
      selfManagedQuarantineKeyFor({ ownerUserId: 'u', profileId: 'p/../../etc', attachmentId: 'a' }),
    ).toThrow(ObjectKeyError)
  })
})
