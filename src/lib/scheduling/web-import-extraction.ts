/**
 * Turns a fetched page into plain evidence text (plan:
 * calendar-scheduling-interview-intelligence, Phase 6; spec.md: "JavaScript is not executed. Raw HTML
 * is parsed in isolation, scripts/styles/forms/iframes and active content are removed, visible text
 * plus title/headings/canonical URL are normalized, then the response body is discarded").
 *
 * ## Removing content, not just tags
 *
 * The order below is the whole correctness argument. Stripping tags first and *then* worrying about
 * `<script>` leaves the script's body behind as text — a page's minified JavaScript would land in the
 * evidence a model reads, which is both useless and the most obvious place to hide an instruction
 * aimed at that model. So every element whose *contents* are not prose is removed complete with its
 * contents, before a single tag is stripped.
 *
 * ## No DOM, deliberately
 *
 * This does not build a document tree. A parser would be more precise about malformed markup, and it
 * would also be a new dependency processing attacker-controlled bytes on the server. Text extraction
 * does not need the precision: the failure mode of a slightly over-eager strip is a missing sentence,
 * while the failure mode of a parser is a parser bug. The one thing this must not do — leave active
 * content in the output — is handled by removing whole elements rather than by parsing them.
 *
 * ## The output is untrusted evidence
 *
 * Nothing here sanitizes for display, because the result is never rendered as markup. It is plain
 * text that gets stable source ids before any AI use. Callers must keep treating it as something a
 * stranger wrote.
 */

/** Elements removed with their contents: not prose, and in several cases executable. */
const STRIPPED_ELEMENTS = [
  'script', 'style', 'noscript', 'template', 'svg', 'math',
  'iframe', 'object', 'embed', 'applet', 'canvas', 'audio', 'video',
  'form', 'button', 'select', 'textarea', 'input', 'nav', 'footer',
] as const

/** Tags whose boundaries are a line break in the extracted text. */
const BLOCK_ELEMENTS = [
  'p', 'div', 'section', 'article', 'header', 'main', 'aside', 'br', 'hr',
  'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'tr', 'td', 'th', 'table',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'figure', 'figcaption',
] as const

export const EXTRACTION_VERSION = '1'

/** Well above any candidate portfolio page, and a hard bound on what reaches a model. */
export const MAX_IMPORT_TEXT_CHARS = 200_000

export interface WebImportExtraction {
  title: string | null
  canonicalUrl: string | null
  headings: readonly string[]
  text: string
  extractionVersion: string
  truncated: boolean
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™',
}

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const codePoint = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      // Surrogates and out-of-range values would throw or produce a lone surrogate that breaks
      // later JSON encoding; an undecodable reference is left as written rather than guessed at.
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) return match
      return String.fromCodePoint(codePoint)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * Matches a tag, respecting quoted attribute values.
 *
 * `<[^>]*>` is the obvious version and it stops early on `<a title="a > b">`, leaving `b">` behind as
 * text. Cosmetic rather than dangerous — every element that could carry active content is already
 * gone by this point — but the alternative is evidence text with fragments of markup in it.
 */
const TAG_PATTERN = /<\/?[a-zA-Z][^\s/>]*(?:\s+(?:"[^"]*"|'[^']*'|[^>"'])*)?\/?>/g

function removeElementWithContents(html: string, tag: string): string {
  // Non-greedy up to the matching close tag, or to the end of input when the page never closes it —
  // an unclosed <script> must swallow the rest of the document, not be given up on.
  const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:</${tag}\\s*>|$)`, 'gi')
  const selfClosing = new RegExp(`<${tag}\\b[^>]*/?>`, 'gi')
  return html.replace(paired, ' ').replace(selfClosing, ' ')
}

function collapse(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Plain text for one HTML fragment, with every element removed. */
function fragmentText(fragment: string): string {
  return collapse(decodeEntities(fragment.replace(TAG_PATTERN, ' ')))
}

export function extractWebImportText(html: string): WebImportExtraction {
  // 1. Comments first: a commented-out `<script>` would otherwise confuse the element removal below,
  //    and comment bodies are never prose.
  let working = html.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
  // Declarations and processing instructions. `TAG_PATTERN` requires a letter after `<`, so these
  // are invisible to it — which is how `<!DOCTYPE html>` was surviving into the evidence text.
  working = working.replace(/<[!?][^>]*>/g, ' ')

  // 2. Metadata read *before* anything is removed, since <title> lives in a <head> whose siblings are
  //    about to be deleted.
  const titleMatch = working.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)
  const title = titleMatch ? fragmentText(titleMatch[1]).slice(0, 300) || null : null

  const canonicalMatch = working.match(
    /<link\b(?=[^>]*\brel\s*=\s*["']?canonical["']?)[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/i,
  )
  let canonicalUrl: string | null = null
  if (canonicalMatch) {
    const candidate = decodeEntities(canonicalMatch[1]).trim()
    // Only an absolute https URL is worth recording. A relative or `javascript:` canonical is not a
    // location, and resolving it here would mean inventing a base the page did not give us.
    canonicalUrl = /^https:\/\//i.test(candidate) ? candidate.slice(0, 2048) : null
  }

  // 3. Whole elements, contents included. This is what keeps script bodies out of the evidence.
  for (const tag of STRIPPED_ELEMENTS) working = removeElementWithContents(working, tag)
  working = working.replace(/<head\b[^>]*>[\s\S]*?(?:<\/head\s*>|$)/gi, ' ')

  const headings: string[] = []
  for (const match of working.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) {
    const heading = fragmentText(match[2])
    if (heading) headings.push(heading.slice(0, 300))
    if (headings.length >= 200) break
  }

  // 4. Block boundaries become line breaks, so paragraphs do not run together into one sentence.
  for (const tag of BLOCK_ELEMENTS) {
    working = working.replace(new RegExp(`</?${tag}\\b[^>]*>`, 'gi'), '\n')
  }

  const body = collapse(decodeEntities(working.replace(TAG_PATTERN, ' ')))
  const truncated = body.length > MAX_IMPORT_TEXT_CHARS
  const text = truncated ? body.slice(0, MAX_IMPORT_TEXT_CHARS) : body

  return {
    title,
    canonicalUrl,
    headings,
    text,
    extractionVersion: EXTRACTION_VERSION,
    truncated,
  }
}
