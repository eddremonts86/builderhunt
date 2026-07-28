/**
 * Deterministic validation of a candidate upload (plan:
 * calendar-scheduling-interview-intelligence, Phase 6; spec.md "Private file
 * contract").
 *
 * ## What the declared metadata is worth
 *
 * Nothing. `originalName`, `declaredMediaType` and `bytes` arrive from the
 * browser alongside a presigned PUT that cannot enforce any of them — the
 * adapter documents at length why `maxBytes` is advisory on the URL. So every
 * declared value here is treated as a *claim to be checked against the bytes*,
 * never as a fact:
 *
 *   - `bytes` is checked against the object's real length,
 *   - `declaredMediaType` against the magic bytes,
 *   - `sha256` against a hash computed here,
 *   - the extension against the media type it claims.
 *
 * A mismatch is a rejection, not a correction. Silently trusting the sniffed
 * type over the declared one would let a candidate upload a `.pdf` that is
 * really something else and have the system quietly agree with the file.
 *
 * ## Order matters
 *
 * Cheap structural checks run before anything that allocates in proportion to
 * the input, so a hostile file is refused before it can cost much. The zip
 * walk in particular happens before any DOCX parser sees the bytes: mammoth
 * would happily inflate a bomb.
 *
 * ## What this deliberately does NOT decide
 *
 * Whether a PDF is *really* encrypted or corrupt. The `/Encrypt` scan below is
 * an early, cheap reject; `document-extraction.ts` is authoritative, because
 * only a real parse can tell a damaged xref from an unusual one. Both paths
 * produce the same rejection codes, so a caller does not care which one fired.
 */
import { createHash } from 'node:crypto'
import { fileTypeFromBuffer } from 'file-type'

export type DocumentKind = 'pdf' | 'docx' | 'txt'

export const PDF_MEDIA_TYPE = 'application/pdf'
export const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const TXT_MEDIA_TYPE = 'text/plain'

/** spec.md: "Limits: 10 MB each, 25 MB total per invitation." */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
export const MAX_INVITATION_BYTES = 25 * 1024 * 1024

/**
 * A DOCX is a zip, and a zip is an amplifier. These bound the inflated size
 * before a parser is handed the file. Both are generous for a real document:
 * text compresses roughly 5-10x, so a legitimate 10 MB DOCX lands nowhere near
 * either ceiling, while a bomb clears them by orders of magnitude.
 */
const MAX_DOCX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
const MAX_DOCX_COMPRESSION_RATIO = 150

const KIND_BY_MEDIA_TYPE: Readonly<Record<string, { kind: DocumentKind; extensions: readonly string[] }>> = {
  [PDF_MEDIA_TYPE]: { kind: 'pdf', extensions: ['.pdf'] },
  [DOCX_MEDIA_TYPE]: { kind: 'docx', extensions: ['.docx'] },
  [TXT_MEDIA_TYPE]: { kind: 'txt', extensions: ['.txt'] },
}

export type DocumentRejectionCode =
  | 'empty_file'
  | 'too_large'
  | 'quota_exceeded'
  | 'unsupported_media_type'
  | 'extension_mismatch'
  | 'size_mismatch'
  | 'checksum_mismatch'
  | 'media_type_mismatch'
  | 'encrypted_document'
  | 'corrupt_document'
  | 'archive_bomb'

export class DocumentValidationError extends Error {
  constructor(message: string, readonly code: DocumentRejectionCode) {
    super(message)
    this.name = 'DocumentValidationError'
  }
}

export interface ValidatedDocument {
  kind: DocumentKind
  mediaType: string
  sha256: string
  bytes: number
}

/** Lowercased final extension, or '' when the name has none. */
function extensionOf(originalName: string): string {
  const dot = originalName.lastIndexOf('.')
  return dot <= 0 ? '' : originalName.slice(dot).toLowerCase()
}

export function sha256Hex(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

/**
 * spec.md: "25 MB total per invitation". Separate from the per-file check so
 * the upload route can enforce the quota *before* issuing a signed URL, while
 * the completion path re-checks it against what was actually written — the
 * gap between the two is exactly where a client that ignores the announced
 * size would otherwise slip through.
 */
export function assertWithinInvitationQuota(params: { existingBytes: number; incomingBytes: number }): void {
  const total = params.existingBytes + params.incomingBytes
  if (total > MAX_INVITATION_BYTES) {
    throw new DocumentValidationError(
      `invitation total would be ${total} bytes, above the ${MAX_INVITATION_BYTES}-byte limit`,
      'quota_exceeded',
    )
  }
}

/**
 * Walks a zip's central directory to total the *uncompressed* sizes without
 * inflating anything.
 *
 * Reading the central directory rather than the local headers is deliberate:
 * local headers may carry zeroed sizes with the real values in a trailing data
 * descriptor, so a bomb can look empty from the front of the file.
 */
function assertSaneZip(body: Uint8Array): void {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const EOCD_SIGNATURE = 0x06054b50
  const CENTRAL_FILE_SIGNATURE = 0x02014b50
  const EOCD_MIN_BYTES = 22

  // The end-of-central-directory record sits at the tail, after an optional
  // comment of up to 64 KiB — hence the backwards scan rather than a fixed
  // offset.
  let eocd = -1
  const earliest = Math.max(0, body.byteLength - (EOCD_MIN_BYTES + 0xffff))
  for (let offset = body.byteLength - EOCD_MIN_BYTES; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new DocumentValidationError('zip has no end-of-central-directory record', 'corrupt_document')

  const entryCount = view.getUint16(eocd + 10, true)
  const directorySize = view.getUint32(eocd + 12, true)
  let cursor = view.getUint32(eocd + 16, true)

  // Zip64 uses these sentinels for values that no longer fit in 32 bits. A
  // DOCX under 10 MB has no business needing it, so refusing is both safe and
  // simpler than implementing the extended records.
  if (cursor === 0xffffffff || directorySize === 0xffffffff || entryCount === 0xffff) {
    throw new DocumentValidationError('zip64 archives are not accepted', 'corrupt_document')
  }
  if (cursor + directorySize > body.byteLength) {
    throw new DocumentValidationError('zip central directory runs past the end of the file', 'corrupt_document')
  }

  let uncompressed = 0
  let compressed = 0
  const names: string[] = []
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > body.byteLength || view.getUint32(cursor, true) !== CENTRAL_FILE_SIGNATURE) {
      throw new DocumentValidationError('zip central directory entry is malformed', 'corrupt_document')
    }
    compressed += view.getUint32(cursor + 20, true)
    uncompressed += view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    names.push(new TextDecoder('utf-8', { fatal: false }).decode(body.subarray(cursor + 46, cursor + 46 + nameLength)))
    cursor += 46 + nameLength + extraLength + commentLength

    if (uncompressed > MAX_DOCX_UNCOMPRESSED_BYTES) {
      throw new DocumentValidationError(
        `zip expands to over ${MAX_DOCX_UNCOMPRESSED_BYTES} bytes`,
        'archive_bomb',
      )
    }
  }

  // Ratio is checked on the total rather than per entry: a single highly
  // compressible entry is normal (XML), while a whole archive that expands
  // 150x is not a document.
  if (compressed > 0 && uncompressed / compressed > MAX_DOCX_COMPRESSION_RATIO) {
    throw new DocumentValidationError(
      `zip compression ratio ${Math.round(uncompressed / compressed)}:1 exceeds ${MAX_DOCX_COMPRESSION_RATIO}:1`,
      'archive_bomb',
    )
  }

  // A zip that is not an OOXML word document is not a DOCX, whatever its magic
  // bytes say — this is what separates a real upload from a renamed archive
  // that merely happens to start with PK.
  if (!names.includes('[Content_Types].xml') || !names.some((name) => name.startsWith('word/'))) {
    throw new DocumentValidationError('zip is not a WordprocessingML package', 'media_type_mismatch')
  }
}

function assertSanePdf(body: Uint8Array): void {
  // Backstop, not the guard. A polyglot works because PDF *viewers* scan for
  // `%PDF-` rather than requiring it at offset 0, so the same bytes read as an
  // archive to one reader and a document to another. What actually closes that
  // here is `file-type`, which only reports `application/pdf` when the magic is
  // at offset 0 — measured, and pinned by a test, because this validator would
  // otherwise inherit a hole if that ever loosened. This line is therefore
  // unreachable today and kept deliberately: it is the check that has to still
  // be true if the sniffer is ever replaced.
  const header = new TextDecoder('latin1').decode(body.subarray(0, 5))
  if (header !== '%PDF-') {
    throw new DocumentValidationError('pdf does not begin with %PDF-', 'corrupt_document')
  }
  const tail = new TextDecoder('latin1').decode(body.subarray(Math.max(0, body.byteLength - 4096)))
  if (!tail.includes('%%EOF')) {
    throw new DocumentValidationError('pdf has no %%EOF marker in its trailing bytes', 'corrupt_document')
  }
  // Cheap early reject. `document-extraction.ts` is authoritative — pdfjs
  // raises a password exception on a real encrypted document — but refusing
  // here avoids handing the parser a file we already know it cannot read.
  if (tail.includes('/Encrypt')) {
    throw new DocumentValidationError('pdf trailer declares an encryption dictionary', 'encrypted_document')
  }
}

function assertSaneText(body: Uint8Array): void {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    // A NUL in "plain text" means it is not plain text — most commonly a binary
    // renamed to `.txt`, which `file-type` cannot catch because text has no
    // magic bytes to sniff.
    if (text.includes('\u0000')) {
      throw new DocumentValidationError('text contains NUL bytes', 'media_type_mismatch')
    }
  } catch (error) {
    if (error instanceof DocumentValidationError) throw error
    throw new DocumentValidationError('text is not valid UTF-8', 'media_type_mismatch')
  }
}

/**
 * Validates the real bytes against everything the client claimed about them.
 * Throws `DocumentValidationError`; the caller stores `error.code` as the
 * document's `rejection_code`.
 */
export async function validateDocument(params: {
  originalName: string
  declaredMediaType: string
  declaredBytes: number
  declaredSha256: string
  body: Uint8Array
}): Promise<ValidatedDocument> {
  const { body } = params

  if (body.byteLength === 0) {
    throw new DocumentValidationError('file is empty', 'empty_file')
  }
  if (body.byteLength > MAX_DOCUMENT_BYTES) {
    throw new DocumentValidationError(
      `file is ${body.byteLength} bytes, above the ${MAX_DOCUMENT_BYTES}-byte limit`,
      'too_large',
    )
  }
  if (body.byteLength !== params.declaredBytes) {
    throw new DocumentValidationError(
      `declared ${params.declaredBytes} bytes but the object holds ${body.byteLength}`,
      'size_mismatch',
    )
  }

  const allowed = KIND_BY_MEDIA_TYPE[params.declaredMediaType]
  if (!allowed) {
    throw new DocumentValidationError(`${params.declaredMediaType} is not an accepted format`, 'unsupported_media_type')
  }
  if (!allowed.extensions.includes(extensionOf(params.originalName))) {
    throw new DocumentValidationError(
      `extension does not match ${params.declaredMediaType}`,
      'extension_mismatch',
    )
  }

  const sha256 = sha256Hex(body)
  if (sha256 !== params.declaredSha256.toLowerCase()) {
    throw new DocumentValidationError('sha256 does not match the uploaded bytes', 'checksum_mismatch')
  }

  // `file-type` reads magic bytes only; it returns undefined for text, which
  // has none. Absent detection is therefore only acceptable for TXT.
  const detected = await fileTypeFromBuffer(body)
  if (allowed.kind === 'txt') {
    if (detected) {
      throw new DocumentValidationError(
        `declared text/plain but the bytes are ${detected.mime}`,
        'media_type_mismatch',
      )
    }
    assertSaneText(body)
  } else if (allowed.kind === 'pdf') {
    if (detected?.mime !== PDF_MEDIA_TYPE) {
      throw new DocumentValidationError(
        `declared a pdf but the bytes are ${detected?.mime ?? 'unrecognised'}`,
        'media_type_mismatch',
      )
    }
    assertSanePdf(body)
  } else {
    // `file-type` reports a DOCX as either the OOXML type or, for archives it
    // cannot classify further, plain `application/zip`. Both are acceptable at
    // this stage precisely because `assertSaneZip` then proves it is a
    // WordprocessingML package rather than trusting the sniff.
    if (detected?.mime !== DOCX_MEDIA_TYPE && detected?.mime !== 'application/zip') {
      throw new DocumentValidationError(
        `declared a docx but the bytes are ${detected?.mime ?? 'unrecognised'}`,
        'media_type_mismatch',
      )
    }
    assertSaneZip(body)
  }

  return { kind: allowed.kind, mediaType: params.declaredMediaType, sha256, bytes: body.byteLength }
}
