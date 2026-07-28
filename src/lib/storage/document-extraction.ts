/**
 * Deterministic text extraction from a *scanned-clean* candidate document
 * (plan: calendar-scheduling-interview-intelligence, Phase 6; spec.md "Parse
 * clean PDF/DOCX/TXT deterministically; never send raw binary to the LLM").
 *
 * ## Deterministic means byte-identical on a re-run
 *
 * `document_extractions` is keyed by (document, parser version, content hash),
 * so the same file through the same parser version must produce the same text
 * or the table fills with near-duplicate rows and a brief's citation stops
 * resolving. Two things follow, and both are easy to get wrong:
 *
 *   - No timestamps, no locale-dependent formatting, no `Math.random`, no map
 *     iteration order that depends on insertion timing.
 *   - Unicode is normalised to NFC. The same visible character can arrive
 *     composed or decomposed depending on the authoring tool, and un-normalised
 *     text hashes differently while looking identical in a diff.
 *
 * `PARSER_VERSION` is part of that contract: **bump it whenever the output for
 * an unchanged input could change.** Not bumping it is the failure mode —
 * the unique index then rejects the new extraction as a duplicate of text this
 * code no longer produces.
 *
 * ## Untrusted input, all the way down
 *
 * A candidate controls these bytes. Nothing is rendered — fonts are disabled
 * outright, and DOCX headings are located *as strings* rather than by rendering
 * mammoth's HTML, which exists for a few milliseconds inside this module to
 * find heading text and is never emitted, stored, or returned. Nothing
 * downstream should ever receive markup from a candidate's file.
 */
import { createHash } from 'node:crypto'
import mammoth from 'mammoth'
import {
  DocumentExtractionError,
  type DocumentExtractionProvider,
  type DocumentExtractionResult,
} from './types'
import {
  DOCX_MEDIA_TYPE,
  PDF_MEDIA_TYPE,
  TXT_MEDIA_TYPE,
  type DocumentKind,
} from './document-validation'

/** Bump on any change that alters the output for an unchanged input. */
export const PARSER_VERSION = '1'

/**
 * A CV runs to a few thousand characters; a technical portfolio maybe tens of
 * thousands. This is far above either and still bounds what reaches a model.
 * Exceeding it truncates and *says so* via `truncated` rather than quietly
 * shortening a document a brief will later cite.
 */
export const MAX_EXTRACTED_CHARS = 500_000

export type SectionMapEntry = { page?: number; section?: string; offset: number }

/**
 * Strips what a model has no use for and a terminal or log would mangle,
 * without touching anything meaningful.
 *
 * C0 control characters go, except tab and newline — they carry no text and a
 * document containing them is either binary-adjacent or trying to smuggle
 * formatting past a log. Line endings are unified before that, so a CRLF file
 * and an LF file of the same document hash identically.
 */
export function normalizeExtractedText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    // Runs of blank lines carry no information and differ between parsers for
    // the same visual layout, which would break the determinism the content
    // hash depends on.
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

function finish(params: {
  text: string
  sectionMap: SectionMapEntry[]
  parser: string
}): DocumentExtractionResult {
  const normalized = normalizeExtractedText(params.text)
  const truncated = normalized.length > MAX_EXTRACTED_CHARS
  const text = truncated ? normalized.slice(0, MAX_EXTRACTED_CHARS) : normalized

  // An extraction with no text is a failure, not an empty success: it means a
  // scanned image-only PDF or a parser that silently gave up, and a downstream
  // brief built on "" would read as "this candidate said nothing".
  if (text.length === 0) {
    throw new DocumentExtractionError('no text could be extracted from the document', 'corrupt_document')
  }

  return {
    text,
    // Entries past the truncation point would point outside the text they
    // annotate, so they are dropped rather than left dangling.
    sectionMap: params.sectionMap.filter((entry) => entry.offset < text.length),
    parser: params.parser,
    parserVersion: PARSER_VERSION,
    contentSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    truncated,
  }
}

async function extractPdf(body: Uint8Array): Promise<DocumentExtractionResult> {
  // Dynamic import of the legacy build: the default entry point expects a
  // browser worker, and the import is deferred so a process that never handles
  // a PDF does not pay for loading it.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

  // `destroy()` lives on the loading task, not on the document proxy, so the
  // task has to stay in scope for the cleanup in `finally` below to reach it.
  let task: ReturnType<typeof pdfjs.getDocument> | undefined
  let document
  try {
    task = pdfjs.getDocument({
      // A plain `Uint8Array`, and a copy. pdfjs rejects a Node `Buffer`
      // outright ("provide binary data as Uint8Array") even though Buffer
      // extends it, and `StoredDocumentExtractor` hands over exactly that from
      // `Buffer.concat` — so every real PDF would have failed here. The copy is
      // also deliberate: pdfjs may take ownership of and detach the underlying
      // ArrayBuffer, which would corrupt a caller still holding the bytes.
      data: new Uint8Array(body),
      // No `isEvalSupported: false` here, and not by omission: pdfjs v6 removed
      // the option along with the eval-based font path it used to gate — it
      // appears in neither the shipped build nor the types, so passing it
      // silently did nothing while reading like a hardening measure.
      //
      // These two are real, and are what a text-only extraction wants: nothing
      // is being rendered, so there is no reason to touch fonts at all.
      disableFontFace: true,
      useSystemFonts: false,
      // A password prompt cannot be answered by a worker, and an encrypted
      // document is a rejection anyway.
      password: '',
    })
    document = await task.promise
  } catch (error) {
    await task?.destroy().catch(() => undefined)
    const name = (error as { name?: string } | null)?.name
    if (name === 'PasswordException') {
      throw new DocumentExtractionError('pdf is password protected', 'encrypted_document')
    }
    if (name === 'InvalidPDFException') {
      throw new DocumentExtractionError('pdf structure is invalid', 'corrupt_document')
    }
    throw new DocumentExtractionError(
      `pdf could not be opened: ${error instanceof Error ? error.message : String(error)}`,
      'parser_failure',
    )
  }

  try {
    const parts: string[] = []
    const sectionMap: SectionMapEntry[] = []
    let offset = 0

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      // `hasEOL` is pdfjs's own line-break signal. Joining on it rather than
      // guessing from item coordinates keeps the output stable across runs,
      // which coordinate rounding would not.
      const pageText = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('')
      page.cleanup()

      sectionMap.push({ page: pageNumber, offset })
      parts.push(pageText)
      offset += pageText.length + 1
    }

    return finish({ text: parts.join('\n'), sectionMap, parser: 'pdfjs' })
  } finally {
    await task.destroy().catch(() => undefined)
  }
}

/** Recovers a heading's plain text from mammoth's HTML without rendering it. */
function textOfHtmlFragment(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

async function extractDocx(body: Uint8Array): Promise<DocumentExtractionResult> {
  const buffer = Buffer.from(body)

  let raw: string
  try {
    raw = (await mammoth.extractRawText({ buffer })).value
  } catch (error) {
    // mammoth throws on anything that is not a readable WordprocessingML
    // package. `document-validation.ts` already proved the zip structure, so
    // reaching here means the XML inside is damaged.
    throw new DocumentExtractionError(
      `docx could not be read: ${error instanceof Error ? error.message : String(error)}`,
      'corrupt_document',
    )
  }

  // Headings come from a second pass over the same bytes. The HTML is consumed
  // here and discarded — nothing downstream ever sees markup from the file.
  const sectionMap: SectionMapEntry[] = []
  try {
    const html = (await mammoth.convertToHtml({ buffer })).value
    const normalizedRaw = normalizeExtractedText(raw)
    let cursor = 0
    for (const match of html.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/g)) {
      const heading = normalizeExtractedText(textOfHtmlFragment(match[1]))
      if (!heading) continue
      // Located by searching forward from the previous heading, so repeated
      // headings ("Experience" twice) map to distinct offsets in order.
      const offset = normalizedRaw.indexOf(heading, cursor)
      if (offset < 0) continue
      sectionMap.push({ section: heading, offset })
      cursor = offset + heading.length
    }
  } catch {
    // A section map is a convenience for citations; text is the deliverable.
    // Losing headings must not fail an extraction that already has the text.
  }

  return finish({ text: raw, sectionMap, parser: 'mammoth' })
}

function extractTxt(body: Uint8Array): DocumentExtractionResult {
  let raw: string
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw new DocumentExtractionError('text file is not valid UTF-8', 'corrupt_document')
  }
  return finish({ text: raw, sectionMap: [{ offset: 0 }], parser: 'utf8' })
}

/** Extracts from bytes already held in memory — validation has bounded them to 10 MB. */
export async function extractDocumentText(params: {
  kind: DocumentKind
  body: Uint8Array
}): Promise<DocumentExtractionResult> {
  switch (params.kind) {
    case 'pdf':
      return extractPdf(params.body)
    case 'docx':
      return extractDocx(params.body)
    case 'txt':
      return extractTxt(params.body)
  }
}

const KIND_BY_MEDIA_TYPE: Readonly<Record<string, DocumentKind>> = {
  [PDF_MEDIA_TYPE]: 'pdf',
  [DOCX_MEDIA_TYPE]: 'docx',
  [TXT_MEDIA_TYPE]: 'txt',
}

/**
 * The `DocumentExtractionProvider` the worker resolves. Reads through the
 * storage adapter so the bytes never round-trip through a signed URL.
 */
export class StoredDocumentExtractor implements DocumentExtractionProvider {
  constructor(private readonly readObject: (key: string) => Promise<{ bytes: number; stream: AsyncIterable<Uint8Array> }>) {}

  async extractText(params: { key: string; mediaType: string }): Promise<DocumentExtractionResult> {
    const kind = KIND_BY_MEDIA_TYPE[params.mediaType]
    if (!kind) {
      throw new DocumentExtractionError(`${params.mediaType} cannot be extracted`, 'unsupported_media_type')
    }

    const object = await this.readObject(params.key)
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const chunk of object.stream) {
      total += chunk.byteLength
      // Belt and braces against a stream longer than the recorded size: the
      // 10 MB cap was enforced at completion time against `headObject`, and
      // this refuses to buffer past it regardless of what the object claims.
      if (total > 10 * 1024 * 1024) {
        throw new DocumentExtractionError('object exceeded the extraction size limit while streaming', 'parser_failure')
      }
      chunks.push(chunk)
    }

    return extractDocumentText({ kind, body: Buffer.concat(chunks) })
  }
}
