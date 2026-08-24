/**
 * Builds real PDF and DOCX bytes rather than committing binary fixtures.
 *
 * Two reasons. A committed `.docx` is opaque in review — nobody can see from a
 * diff whether the fixture proving "zip bombs are rejected" actually declares
 * an inflated size, so the test can rot into asserting nothing. And the hostile
 * cases here (a bomb, a polyglot, a truncated archive) are constructed by
 * *changing one field* from the valid fixture, which only works if the valid
 * fixture is itself constructed.
 *
 * The zip writer is deliberately hand-rolled: it is what lets a fixture declare
 * an uncompressed size unrelated to its actual contents, which no zip library
 * will let you do.
 */
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  name: string
  content: string
  /**
   * Overrides the uncompressed size written into the headers. A real zip
   * library derives this from the data; a bomb lies about it, which is exactly
   * what the archive-bomb check has to catch.
   */
  declaredUncompressedSize?: number
}

export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.from(entry.content, 'utf8')
    const deflated = deflateRawSync(raw)
    const crc = crc32(raw)
    const uncompressed = entry.declaredUncompressedSize ?? raw.byteLength

    const local = Buffer.alloc(30 + name.byteLength)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(deflated.byteLength, 18)
    local.writeUInt32LE(uncompressed, 22)
    local.writeUInt16LE(name.byteLength, 26)
    name.copy(local, 30)
    locals.push(local, deflated)

    const central = Buffer.alloc(46 + name.byteLength)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(deflated.byteLength, 20)
    central.writeUInt32LE(uncompressed, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)

    offset += local.byteLength + deflated.byteLength
  }

  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.byteLength, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, directory, eocd])
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

/**
 * Escaped the way Word escapes it. Without this, fixture text containing `<`
 * would produce malformed XML and the resulting failure would look like a
 * parser bug rather than a broken fixture — which matters most for the case
 * that checks a candidate's literal `<script>` survives as text.
 */
function xmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function paragraph(text: string, style?: string): string {
  const properties = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''
  return `<w:p>${properties}<w:r><w:t xml:space="preserve">${xmlText(text)}</w:t></w:r></w:p>`
}

/** `blocks` entries with a `style` become Word headings, which mammoth maps to h1-h6. */
export function buildDocx(blocks: ReadonlyArray<{ text: string; style?: string }>, options?: {
  declaredUncompressedSize?: number
  corruptDocumentXml?: boolean
}): Uint8Array {
  const body = blocks.map((block) => paragraph(block.text, block.style)).join('')
  const documentXml = options?.corruptDocumentXml
    ? '<?xml version="1.0"?><w:document><w:body><w:p>truncated'
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`

  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: RELS },
    {
      name: 'word/document.xml',
      content: documentXml,
      declaredUncompressedSize: options?.declaredUncompressedSize,
    },
  ])
}

/**
 * A minimal but genuinely valid PDF, with a real cross-reference table —
 * pdfjs can reconstruct a broken one, so a fixture with wrong offsets would
 * pass for the wrong reason and hide a regression in the corrupt-file path.
 */
export function buildPdf(pages: readonly string[], options?: { encrypted?: boolean }): Uint8Array {
  const objects: string[] = []
  const pageCount = Math.max(1, pages.length)
  // Object numbering: 1 catalog, 2 page tree, 3 font, then per page a page
  // object and its content stream.
  const pageIds = pages.map((_, index) => 4 + index * 2)

  objects.push('<</Type/Catalog/Pages 2 0 R>>')
  objects.push(`<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(' ')}]/Count ${pageCount}>>`)
  objects.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>')

  for (const [index, text] of pages.entries()) {
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET`
    objects.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents ${5 + index * 2} 0 R>>`,
    )
    objects.push(`<</Length ${stream.length}>>\nstream\n${stream}\nendstream`)
  }

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }

  const xrefOffset = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  // `/Encrypt` in the trailer is what marks a PDF as protected; the fixture
  // does not need real encryption for the code under test to refuse it.
  const encrypt = options?.encrypted ? '/Encrypt 99 0 R' : ''
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R${encrypt}>>\nstartxref\n${xrefOffset}\n%%EOF\n`

  return Buffer.from(pdf, 'latin1')
}

// ── Media fixtures for the self-managed attachment policy (plan: phase-2/07) ─────────────────
//
// Constructed rather than committed, for the same reason the document fixtures are: a binary in the
// tree is a binary nobody reads in review. These are the smallest byte sequences `file-type`
// actually recognises, and two of them are smaller than they look:
//
//   - a PNG needs a well-formed IHDR *length* before it is recognised at all; the signature alone
//     sniffs as `undefined`,
//   - an MP3 behind an ID3v2 tag is only found once the tag's synchsafe size is well formed.
//
// Both were measured, not assumed, and both are true of every real file and false of the obvious
// hand-made version. A fixture the sniffer rejects would make the policy's tests pass for the wrong
// reason — the file would be refused as a mismatch rather than accepted as valid.

const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xff)

function u32be(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

/** Signature plus one IHDR chunk. Anything less is not recognised as a PNG. */
export function buildPng(): Uint8Array {
  return concat(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    u32be(13), latin1('IHDR'), u32be(1), u32be(1), new Uint8Array([8, 6, 0, 0, 0]), u32be(0),
  )
}

export function buildJpeg(): Uint8Array {
  return concat(
    new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    latin1('JFIF'),
    new Uint8Array(20),
  )
}

export function buildWebp(): Uint8Array {
  return concat(latin1('RIFF'), new Uint8Array([0x24, 0, 0, 0]), latin1('WEBPVP8 '), new Uint8Array(20))
}

export function buildWav(): Uint8Array {
  return concat(
    latin1('RIFF'), new Uint8Array([0x24, 0, 0, 0]),
    latin1('WAVEfmt '), new Uint8Array([0x10, 0, 0, 0]), new Uint8Array(20),
  )
}

/** An ID3v2 header with a well-formed synchsafe size, then one MPEG frame. */
export function buildMp3(): Uint8Array {
  return concat(
    latin1('ID3'), new Uint8Array([3, 0, 0]), new Uint8Array([0, 0, 0, 10]), new Uint8Array(10),
    new Uint8Array([0xff, 0xfb, 0x90, 0x64]), new Uint8Array(400),
  )
}

export function buildMp4(): Uint8Array {
  return concat(new Uint8Array(4), latin1('ftypisom'), new Uint8Array(4), latin1('isomiso2avc1mp41'), new Uint8Array(20))
}
