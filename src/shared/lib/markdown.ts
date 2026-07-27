// Server-only markdown rendering for platform-authored content.
//
// `marked` is imported lazily for the same reason `blog.ts` does it: these
// modules are reachable from route files, and a static import pulls the parser
// into a client chunk on a public page that does not need it.
//
// Output is HTML meant for `dangerouslySetInnerHTML`, so the renderer below is
// deliberately hardened rather than trusting the input:
//
//   - raw HTML in the source is ESCAPED, never emitted. `marked` stopped
//     sanitizing in v5 and passes raw HTML straight through, and
//     `changelog.content` is a database column — the public changelog page has
//     an explicit "raw markup must not become live elements" guarantee, with an
//     e2e test that seeds `<img src=x onerror=…>` and asserts zero live
//     elements (tests/e2e/public-content.spec.ts).
//   - link and image URLs are restricted to http(s), mailto, and same-origin
//     relative paths, so `[x](javascript:…)` cannot produce a live handler.
//
// The authors of this content are platform admins, i.e. as trusted as the code.
// The hardening is defence in depth: the column is reachable from an admin API,
// and "only an admin can write it" is one authorization bug away from untrue.

/** Only these can appear in an href/src. Anything else renders as inert text. */
const SAFE_URL = /^(https?:\/\/|mailto:|\/(?!\/)|#|\.\/)/i

/** Whitespace and C0/C1 control characters, which browsers strip from URLs. */
// Matching control characters is the entire purpose here: browsers silently
// drop them from a URL, so a crafted `java\x00script:` reaches the parser as
// `javascript:` unless stripped first. `no-control-regex` exists to catch them
// appearing by accident, which is not this.
// eslint-disable-next-line no-control-regex
const URL_NOISE = /[\s\u0000-\u001f\u007f-\u009f]/g

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeUrl(href: string | null | undefined): string | null {
  if (!href) return null
  const trimmed = href.trim()
  // Validate a copy with whitespace and control characters removed:
  // `java\tscript:alert(1)` is a working URL in a browser and would sail past a
  // prefix test on the raw string. The trimmed original is what gets emitted.
  return SAFE_URL.test(trimmed.replace(URL_NOISE, '')) ? trimmed : null
}

/** Renders a markdown string to HTML. Empty input yields an empty string. */
export async function renderPlatformMarkdown(markdown: string): Promise<string> {
  if (!markdown.trim()) return ''
  const { marked, Renderer } = await import('marked')

  const renderer = new Renderer()

  // Block-level and inline raw HTML both arrive as an `html` token.
  renderer.html = ({ text }) => escapeHtml(text)

  renderer.link = function link(token) {
    const inner = this.parser.parseInline(token.tokens ?? [])
    const href = safeUrl(token.href)
    if (!href) return inner
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
    // Off-site links open in a new tab without leaking a referrer; relative
    // links stay in place.
    const rel = /^https?:\/\//i.test(href) ? ' target="_blank" rel="noreferrer noopener"' : ''
    return `<a href="${escapeHtml(href)}"${title}${rel}>${inner}</a>`
  }

  renderer.image = ({ href, title, text }) => {
    const src = safeUrl(href)
    if (!src) return escapeHtml(text ?? '')
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text ?? '')}"${titleAttr} loading="lazy" />`
  }

  return marked.parse(markdown, { renderer, async: false }) as string
}

/**
 * Plain-text projection for list excerpts and meta descriptions, where markup
 * would be shown literally. Strips the constructs our content actually uses:
 * headings, emphasis, links, images, inline code, list markers, table pipes and
 * any raw tags.
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/!\[(.*?)\]\(.+?\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim()
}
