/**
 * @vitest-environment node
 *
 * Every rejection here is a file a candidate could actually upload, built from
 * real bytes — see `fixtures/documents.ts` for why they are constructed rather
 * than committed. The valid cases matter as much as the hostile ones: a
 * validator that rejects everything passes every security test and ships a
 * feature nobody can use.
 */
import { describe, expect, it } from 'vitest'
import {
  DOCX_MEDIA_TYPE,
  MAX_DOCUMENT_BYTES,
  MAX_INVITATION_BYTES,
  PDF_MEDIA_TYPE,
  TXT_MEDIA_TYPE,
  assertWithinInvitationQuota,
  sha256Hex,
  validateDocument,
} from '~/lib/storage/document-validation'
import { buildDocx, buildPdf, buildZip } from './fixtures/documents'

/** Fills in the declared metadata honestly, so each test can spoil exactly one field. */
function claim(body: Uint8Array, overrides: Partial<{
  originalName: string
  declaredMediaType: string
  declaredBytes: number
  declaredSha256: string
}> = {}) {
  return {
    originalName: 'cv.pdf',
    declaredMediaType: PDF_MEDIA_TYPE,
    declaredBytes: body.byteLength,
    declaredSha256: sha256Hex(body),
    body,
    ...overrides,
  }
}

const textBody = (content: string) => new TextEncoder().encode(content)

describe('validateDocument accepts the three real formats', () => {
  it('accepts a pdf', async () => {
    const body = buildPdf(['Senior systems engineer'])
    const result = await validateDocument(claim(body))
    expect(result.kind).toBe('pdf')
    expect(result.sha256).toBe(sha256Hex(body))
    expect(result.bytes).toBe(body.byteLength)
  })

  it('accepts a docx', async () => {
    const body = buildDocx([{ text: 'Experience', style: 'Heading1' }, { text: 'Built things.' }])
    const result = await validateDocument(claim(body, {
      originalName: 'cv.docx',
      declaredMediaType: DOCX_MEDIA_TYPE,
    }))
    expect(result.kind).toBe('docx')
  })

  it('accepts a txt', async () => {
    const body = textBody('plain text cv\n')
    const result = await validateDocument(claim(body, {
      originalName: 'cv.txt',
      declaredMediaType: TXT_MEDIA_TYPE,
    }))
    expect(result.kind).toBe('txt')
  })

  it('accepts an uppercase extension', async () => {
    const body = buildPdf(['x'])
    await expect(validateDocument(claim(body, { originalName: 'CV.PDF' }))).resolves.toMatchObject({ kind: 'pdf' })
  })
})

describe('validateDocument checks the bytes against every claim', () => {
  it('rejects an empty file', async () => {
    await expect(validateDocument(claim(new Uint8Array(0)))).rejects.toMatchObject({ code: 'empty_file' })
  })

  it('rejects a file over the per-document limit', async () => {
    const body = new Uint8Array(MAX_DOCUMENT_BYTES + 1)
    await expect(validateDocument(claim(body))).rejects.toMatchObject({ code: 'too_large' })
  })

  it('rejects a declared size that does not match the object', async () => {
    const body = buildPdf(['x'])
    await expect(validateDocument(claim(body, { declaredBytes: body.byteLength - 1 })))
      .rejects.toMatchObject({ code: 'size_mismatch' })
  })

  it('rejects a checksum that does not match the bytes', async () => {
    const body = buildPdf(['x'])
    await expect(validateDocument(claim(body, { declaredSha256: 'f'.repeat(64) })))
      .rejects.toMatchObject({ code: 'checksum_mismatch' })
  })

  it('rejects a format that is not one of the three', async () => {
    const body = textBody('hello')
    await expect(validateDocument(claim(body, { originalName: 'cv.rtf', declaredMediaType: 'application/rtf' })))
      .rejects.toMatchObject({ code: 'unsupported_media_type' })
  })

  it('rejects an extension that contradicts the media type', async () => {
    const body = buildPdf(['x'])
    await expect(validateDocument(claim(body, { originalName: 'cv.txt' })))
      .rejects.toMatchObject({ code: 'extension_mismatch' })
  })

  it('rejects a name with no extension at all', async () => {
    const body = buildPdf(['x'])
    await expect(validateDocument(claim(body, { originalName: 'cv' })))
      .rejects.toMatchObject({ code: 'extension_mismatch' })
  })
})

describe('validateDocument does not take the declared type on trust', () => {
  it('rejects a docx wearing a .pdf name', async () => {
    // The whole point of sniffing: extension and declared type agree with each
    // other and both disagree with the file.
    const body = buildDocx([{ text: 'not a pdf' }])
    await expect(validateDocument(claim(body))).rejects.toMatchObject({ code: 'media_type_mismatch' })
  })

  it('rejects a pdf declared as text/plain', async () => {
    const body = buildPdf(['x'])
    await expect(validateDocument(claim(body, { originalName: 'cv.txt', declaredMediaType: TXT_MEDIA_TYPE })))
      .rejects.toMatchObject({ code: 'media_type_mismatch' })
  })

  it('rejects a binary renamed to .txt', async () => {
    // Text has no magic bytes, so `file-type` cannot catch this — the NUL scan
    // is the only thing standing between a binary and the extractor.
    const body = new Uint8Array([0x68, 0x69, 0x00, 0x01, 0x02])
    await expect(validateDocument(claim(body, { originalName: 'cv.txt', declaredMediaType: TXT_MEDIA_TYPE })))
      .rejects.toMatchObject({ code: 'media_type_mismatch' })
  })

  it('rejects text that is not valid utf-8', async () => {
    const body = new Uint8Array([0x68, 0xff, 0xfe, 0x69])
    await expect(validateDocument(claim(body, { originalName: 'cv.txt', declaredMediaType: TXT_MEDIA_TYPE })))
      .rejects.toMatchObject({ code: 'media_type_mismatch' })
  })

  it('rejects a pdf hidden behind leading bytes', async () => {
    // A polyglot: viewers scan for `%PDF-` rather than requiring it at offset 0,
    // so the same file can be an archive to one reader and a document to
    // another.
    const body = Buffer.concat([Buffer.from('GIF89a'), buildPdf(['x'])])
    await expect(validateDocument(claim(body))).rejects.toMatchObject({ code: 'media_type_mismatch' })
  })

  it.each([['a NUL', '\u0000'], ['whitespace', ' '], ['a newline', '\n'], ['a kilobyte of NUL padding', '\u0000'.repeat(1024)]])(
    'refuses a pdf displaced by %s',
    async (_label, prefix) => {
      // Pins the property the validator depends on: `file-type` reports
      // `application/pdf` only when the magic sits at offset 0, so *any*
      // displacement fails the sniff. Written as a test because it is a
      // dependency's behaviour, not ours — if a future version starts scanning
      // ahead, the polyglot door reopens and this fails instead of going quiet.
      const body = Buffer.concat([Buffer.from(prefix, 'latin1'), buildPdf(['x'])])
      await expect(validateDocument(claim(body))).rejects.toMatchObject({ code: 'media_type_mismatch' })
    },
  )

  it('rejects a pdf with no %%EOF in its tail', async () => {
    const valid = buildPdf(['x'])
    const body = valid.subarray(0, valid.byteLength - 6)
    await expect(validateDocument(claim(body))).rejects.toMatchObject({ code: 'corrupt_document' })
  })

  it('rejects an encrypted pdf', async () => {
    const body = buildPdf(['x'], { encrypted: true })
    await expect(validateDocument(claim(body))).rejects.toMatchObject({ code: 'encrypted_document' })
  })
})

describe('validateDocument inspects a docx as the archive it is', () => {
  const asDocx = (body: Uint8Array) => claim(body, {
    originalName: 'cv.docx',
    declaredMediaType: DOCX_MEDIA_TYPE,
  })

  it('rejects an archive that claims an absurd uncompressed size', async () => {
    // The bomb: a few hundred compressed bytes declaring gigabytes. Caught from
    // the central directory without inflating anything.
    const body = buildDocx([{ text: 'x' }], { declaredUncompressedSize: 900 * 1024 * 1024 })
    await expect(validateDocument(asDocx(body))).rejects.toMatchObject({ code: 'archive_bomb' })
  })

  it('rejects an archive whose expansion ratio is implausible', async () => {
    const body = buildDocx([{ text: 'x' }], { declaredUncompressedSize: 40 * 1024 * 1024 })
    await expect(validateDocument(asDocx(body))).rejects.toMatchObject({ code: 'archive_bomb' })
  })

  it('rejects a zip that is not a word package', async () => {
    const body = buildZip([{ name: 'notes.txt', content: 'just a zip' }])
    await expect(validateDocument(asDocx(body))).rejects.toMatchObject({ code: 'media_type_mismatch' })
  })

  it('rejects a truncated archive', async () => {
    const valid = buildDocx([{ text: 'x' }])
    // Losing the tail loses the end-of-central-directory record, which is the
    // only place the entry count and directory offset live.
    const body = valid.subarray(0, valid.byteLength - 30)
    await expect(validateDocument(asDocx(body))).rejects.toMatchObject({ code: 'corrupt_document' })
  })
})

describe('assertWithinInvitationQuota', () => {
  it('allows a total exactly at the limit', () => {
    expect(() => assertWithinInvitationQuota({
      existingBytes: MAX_INVITATION_BYTES - 100,
      incomingBytes: 100,
    })).not.toThrow()
  })

  it('rejects a total one byte over', () => {
    expect(() => assertWithinInvitationQuota({
      existingBytes: MAX_INVITATION_BYTES,
      incomingBytes: 1,
    })).toThrow(expect.objectContaining({ code: 'quota_exceeded' }))
  })
})
