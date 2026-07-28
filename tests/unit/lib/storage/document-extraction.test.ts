/**
 * @vitest-environment node
 *
 * The property under test is determinism, and it is easy to fake: asserting
 * that an extraction "contains the expected words" passes even if the parser
 * emits different whitespace, ordering, or Unicode forms on every run — and
 * `document_extractions` is keyed by content hash, so drift there fills the
 * table with near-duplicates and breaks a brief's citation.
 *
 * So the assertions are on the exact text and the exact hash, extracted twice.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_EXTRACTED_CHARS,
  PARSER_VERSION,
  StoredDocumentExtractor,
  extractDocumentText,
  normalizeExtractedText,
} from '~/lib/storage/document-extraction'
import { DOCX_MEDIA_TYPE, PDF_MEDIA_TYPE, TXT_MEDIA_TYPE } from '~/lib/storage/document-validation'
import { buildDocx, buildPdf } from './fixtures/documents'

const bytes = (content: string) => new TextEncoder().encode(content)

describe('normalizeExtractedText', () => {
  it('unifies line endings so a CRLF and an LF document hash alike', () => {
    expect(normalizeExtractedText('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('strips control characters but keeps tabs and newlines', () => {
    expect(normalizeExtractedText('a\u0000b\u0007c\td\ne')).toBe('abc\td\ne')
  })

  it('normalises Unicode to NFC', () => {
    // The same visible "é": composed, then e + combining acute. Different
    // authoring tools emit different forms, and un-normalised they hash apart.
    const composed = normalizeExtractedText('caf\u00e9')
    const decomposed = normalizeExtractedText('cafe\u0301')
    expect(decomposed).toBe(composed)
    // Guard the guard: as bare literals these differ only by invisible
    // codepoints, so an editor or formatter normalising this file would make
    // the assertion above hold with no normalisation in the code at all.
    expect('caf\u00e9').not.toBe('cafe\u0301')
  })

  it('collapses runs of blank lines and trailing whitespace', () => {
    expect(normalizeExtractedText('a   \n\n\n\n\nb  ')).toBe('a\n\nb')
  })
})

describe('extractDocumentText on a txt', () => {
  it('returns the text with a stable hash', async () => {
    const first = await extractDocumentText({ kind: 'txt', body: bytes('Rust engineer\nDatabases\n') })
    const second = await extractDocumentText({ kind: 'txt', body: bytes('Rust engineer\nDatabases\n') })

    expect(first.text).toBe('Rust engineer\nDatabases')
    expect(first.parser).toBe('utf8')
    expect(first.parserVersion).toBe(PARSER_VERSION)
    expect(first.contentSha256).toBe(second.contentSha256)
    expect(first.truncated).toBe(false)
  })

  it('rejects a file whose only content is whitespace', async () => {
    // Not an empty success: a brief built on "" reads as "the candidate said
    // nothing", which is a different claim from "we could not read this".
    await expect(extractDocumentText({ kind: 'txt', body: bytes('   \n\n  ') }))
      .rejects.toMatchObject({ code: 'corrupt_document' })
  })

  it('rejects invalid utf-8', async () => {
    await expect(extractDocumentText({ kind: 'txt', body: new Uint8Array([0xff, 0xfe, 0x00]) }))
      .rejects.toMatchObject({ code: 'corrupt_document' })
  })

  it('truncates over the cap and says so', async () => {
    const body = bytes('x'.repeat(MAX_EXTRACTED_CHARS + 500))
    const result = await extractDocumentText({ kind: 'txt', body })
    expect(result.text.length).toBe(MAX_EXTRACTED_CHARS)
    expect(result.truncated).toBe(true)
  })
})

describe('extractDocumentText on a pdf', () => {
  it('extracts text and maps every page', async () => {
    const result = await extractDocumentText({
      kind: 'pdf',
      body: buildPdf(['First page text', 'Second page text']),
    })

    expect(result.text).toContain('First page text')
    expect(result.text).toContain('Second page text')
    expect(result.parser).toBe('pdfjs')
    expect(result.sectionMap.map((entry) => entry.page)).toEqual([1, 2])
    // Offsets must actually address the text they annotate.
    for (const entry of result.sectionMap) {
      expect(entry.offset).toBeGreaterThanOrEqual(0)
      expect(entry.offset).toBeLessThan(result.text.length)
    }
  })

  it('produces the identical hash on a second run', async () => {
    const body = buildPdf(['Deterministic output'])
    const first = await extractDocumentText({ kind: 'pdf', body })
    const second = await extractDocumentText({ kind: 'pdf', body })
    expect(first.text).toBe(second.text)
    expect(first.contentSha256).toBe(second.contentSha256)
  })

  it('rejects bytes that are not a pdf at all', async () => {
    await expect(extractDocumentText({ kind: 'pdf', body: bytes('not a pdf') }))
      .rejects.toMatchObject({ name: 'DocumentExtractionError' })
  })
})

describe('extractDocumentText on a docx', () => {
  it('extracts paragraphs and locates headings as sections', async () => {
    const result = await extractDocumentText({
      kind: 'docx',
      body: buildDocx([
        { text: 'Experience', style: 'Heading1' },
        { text: 'Built distributed systems.' },
        { text: 'Education', style: 'Heading1' },
        { text: 'BSc Computer Science.' },
      ]),
    })

    expect(result.text).toContain('Built distributed systems.')
    expect(result.parser).toBe('mammoth')
    expect(result.sectionMap.map((entry) => entry.section)).toEqual(['Experience', 'Education'])
    // Each section offset must land on its own heading in the extracted text,
    // otherwise a citation resolves to the wrong part of the document.
    for (const entry of result.sectionMap) {
      expect(result.text.slice(entry.offset, entry.offset + (entry.section?.length ?? 0))).toBe(entry.section)
    }
  })

  it('maps a repeated heading to distinct ascending offsets', async () => {
    // The naive implementation searches from 0 each time and maps both
    // occurrences to the first one.
    const result = await extractDocumentText({
      kind: 'docx',
      body: buildDocx([
        { text: 'Projects', style: 'Heading1' },
        { text: 'One.' },
        { text: 'Projects', style: 'Heading1' },
        { text: 'Two.' },
      ]),
    })

    const offsets = result.sectionMap.map((entry) => entry.offset)
    expect(result.sectionMap.map((entry) => entry.section)).toEqual(['Projects', 'Projects'])
    expect(offsets[1]).toBeGreaterThan(offsets[0])
  })

  it('never returns markup from the document', async () => {
    // mammoth's HTML pass is used to find headings and then discarded. If any of
    // it leaked into the text, a candidate's file would be feeding markup to a
    // model and, eventually, to a rendered brief.
    const result = await extractDocumentText({
      kind: 'docx',
      body: buildDocx([
        { text: 'Heading', style: 'Heading1' },
        { text: 'Body with <script>alert(1)</script> inside.' },
      ]),
    })
    expect(result.text).not.toContain('<h1>')
    expect(result.text).not.toContain('<p>')
    // The literal characters the candidate typed survive as text — they are
    // escaped in the DOCX XML and must come back as what they were.
    expect(result.text).toContain('<script>alert(1)</script>')
  })

  it('rejects a docx whose xml is damaged', async () => {
    const body = buildDocx([{ text: 'x' }], { corruptDocumentXml: true })
    await expect(extractDocumentText({ kind: 'docx', body }))
      .rejects.toMatchObject({ code: 'corrupt_document' })
  })

  it('produces the identical hash on a second run', async () => {
    const body = buildDocx([{ text: 'Stable', style: 'Heading1' }, { text: 'Output.' }])
    const first = await extractDocumentText({ kind: 'docx', body })
    const second = await extractDocumentText({ kind: 'docx', body })
    expect(first.contentSha256).toBe(second.contentSha256)
  })
})

describe('StoredDocumentExtractor reads through storage', () => {
  function readerFor(body: Uint8Array) {
    return async () => ({ bytes: body.byteLength, stream: (async function* () { yield body })() })
  }

  it('extracts an object by key', async () => {
    const extractor = new StoredDocumentExtractor(readerFor(bytes('stored cv text')))
    const result = await extractor.extractText({ key: 'clean/cv.txt', mediaType: TXT_MEDIA_TYPE })
    expect(result.text).toBe('stored cv text')
  })

  it('routes each accepted media type to a parser', async () => {
    const pdf = new StoredDocumentExtractor(readerFor(buildPdf(['routed'])))
    expect((await pdf.extractText({ key: 'k', mediaType: PDF_MEDIA_TYPE })).parser).toBe('pdfjs')

    const docx = new StoredDocumentExtractor(readerFor(buildDocx([{ text: 'routed' }])))
    expect((await docx.extractText({ key: 'k', mediaType: DOCX_MEDIA_TYPE })).parser).toBe('mammoth')
  })

  it('refuses a media type it has no parser for', async () => {
    const extractor = new StoredDocumentExtractor(readerFor(bytes('x')))
    await expect(extractor.extractText({ key: 'k', mediaType: 'image/png' }))
      .rejects.toMatchObject({ code: 'unsupported_media_type' })
  })

  it('stops buffering a stream that runs past the size limit', async () => {
    // The object store is trusted to report a size, not to be honest about how
    // many bytes it then sends. Without this the extractor would buffer an
    // unbounded stream into memory.
    const oversized = async () => ({
      bytes: 10,
      stream: (async function* () {
        for (let index = 0; index < 12; index += 1) yield new Uint8Array(1024 * 1024)
      })(),
    })
    const extractor = new StoredDocumentExtractor(oversized)
    await expect(extractor.extractText({ key: 'k', mediaType: TXT_MEDIA_TYPE }))
      .rejects.toMatchObject({ code: 'parser_failure' })
  })
})
