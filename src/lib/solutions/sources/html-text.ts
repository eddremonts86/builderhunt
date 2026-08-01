/**
 * Turning a feed's HTML into catalog prose.
 *
 * One decoder shared by every feed adapter. Two of them had their own before this existed, and they had
 * diverged in a way that mattered: one replaced numeric entities with a space instead of decoding them, so
 * `&#x26;` became a gap rather than `&`.
 *
 * The order of operations is the load-bearing part, so it lives in one function rather than being
 * reassembled correctly by each caller.
 */

/**
 * Named entities that actually appear in these feeds' job descriptions.
 *
 * A curated list, not a complete HTML entity table. The complete table is over two thousand entries, and
 * the ones missing here are ones no job posting has used — adding an entry when one shows up is a smaller
 * risk than shipping a table nobody has read. Numeric entities are decoded generally below, which covers
 * everything else a publisher might emit.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'",
  hellip: '…', mdash: '—', ndash: '–', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç',
  uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß',
  aring: 'å', oslash: 'ø', aelig: 'æ',
  Uuml: 'Ü', Ouml: 'Ö', Auml: 'Ä',
  Aring: 'Å', Oslash: 'Ø', AElig: 'Æ',
  euro: '€', pound: '£', deg: '°', middot: '·',
})

/** An out-of-range code point would throw and take a whole batch down over one bad escape. */
function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return ''
  // Surrogate halves are not characters and `fromCodePoint` rejects them.
  if (code >= 0xd800 && code <= 0xdfff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/**
 * Decodes HTML entities.
 *
 * `&amp;` is decoded **last**, so `&amp;lt;` yields the literal text `&lt;` rather than a `<` that a later
 * tag strip would treat as markup. Getting that order wrong is how escaped example code in a job
 * description turns into silently removed text.
 */
export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-zA-Z]{2,10});/g, (match, name: string) => NAMED_ENTITIES[name] ?? match)
    .replace(/&amp;/g, '&')
}

/**
 * Turns an HTML (or double-escaped HTML) description into plain prose.
 *
 * **Entities are decoded before tags are stripped, and that order is the whole point.** Several of these
 * feeds double-escape their bodies, so a description arrives as `&lt;p&gt;&lt;strong&gt;Location: ...`.
 * Stripping first and decoding second leaves `<p><strong>Location: </strong>Munich</p>` as literal text in
 * the catalog — markup rendered as content, in a field the composer quotes back to a user. Decoding first
 * turns those entities into real tags, which the strip then removes.
 *
 * Applied twice, because one pass is not enough for a body that was escaped twice: the first pass yields
 * markup with entities still inside it, and the second resolves those.
 */
export function htmlToPlainText(value: string, limit: number): string | null {
  let text = decodeHtmlEntities(value)
  text = text.replace(/<[^>]+>/g, ' ')
  text = decodeHtmlEntities(text).replace(/<[^>]+>/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > 0 ? text.slice(0, limit) : null
}
