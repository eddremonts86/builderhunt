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
