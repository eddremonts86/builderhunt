import { describe, expect, it } from 'vitest'
import { markdownToPlainText, renderPlatformMarkdown } from '~/shared/lib/markdown'

describe('renderPlatformMarkdown', () => {
  it('renders the markdown our changelog entries actually use', async () => {
    const html = await renderPlatformMarkdown(
      '## Heading\n\nA **bold** word and `code`.\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n',
    )
    expect(html).toContain('<h2>Heading</h2>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<table>')
  })

  it('returns an empty string for empty or whitespace input', async () => {
    expect(await renderPlatformMarkdown('')).toBe('')
    expect(await renderPlatformMarkdown('   \n  ')).toBe('')
  })

  // These four are the reason this module exists rather than a bare
  // `marked.parse`. `marked` removed sanitizing in v5 and passes raw HTML
  // through, and the output here is fed to dangerouslySetInnerHTML on a public
  // page whose e2e contract is "raw markup must not become live elements"
  // (tests/e2e/public-content.spec.ts → hostile changelog content).
  it('escapes raw HTML instead of emitting it', async () => {
    const html = await renderPlatformMarkdown('<img src=x onerror=alert(1)> hostile **content**')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    // The markdown around it still renders.
    expect(html).toContain('<strong>content</strong>')
  })

  it('escapes a raw script block', async () => {
    const html = await renderPlatformMarkdown('<script>window.__x=1</script>\n\ntext')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
  })

  it('drops a javascript: link but keeps its text', async () => {
    const html = await renderPlatformMarkdown('[click me](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('click me')
    expect(html).not.toContain('<a ')
  })

  it('drops a javascript: URL obfuscated with a control character', async () => {
    // Browsers strip tabs and newlines from URLs before dispatching them, so a
    // prefix check on the raw string is not enough.
    const html = await renderPlatformMarkdown('[x](java\tscript:alert(1))')
    expect(html).not.toContain('<a ')
  })

  it('drops a data: image but keeps the alt text', async () => {
    const html = await renderPlatformMarkdown('![alt text](data:text/html;base64,PHNjcmlwdD4=)')
    expect(html).not.toContain('<img')
    expect(html).toContain('alt text')
  })

  it('keeps the links and images our own content relies on', async () => {
    const relative = await renderPlatformMarkdown('[pricing](/pricing) and ![shot](/images/blog/search.webp)')
    expect(relative).toContain('<a href="/pricing">pricing</a>')
    expect(relative).toContain('<img src="/images/blog/search.webp" alt="shot"')

    const absolute = await renderPlatformMarkdown('[docs](https://example.com/x)')
    expect(absolute).toContain('href="https://example.com/x"')
    // Off-site only: a relative link must not get target/rel.
    expect(absolute).toContain('rel="noreferrer noopener"')
    expect(relative).not.toContain('rel=')
  })

  it('escapes a quote inside a link title rather than breaking out of the attribute', async () => {
    const html = await renderPlatformMarkdown('[x](/a "ti\\"tle")')
    expect(html).not.toMatch(/title="[^"]*"[^>]*"/)
  })
})

describe('markdownToPlainText', () => {
  it('produces a single-line excerpt without markup', async () => {
    const text = markdownToPlainText(
      '## Heading\n\nA **bold** word, a [link](/pricing), `code`, and an ![image](/x.png).\n\n- item one\n- item two\n',
    )
    expect(text).toBe('Heading A bold word, a link, code, and an image. item one item two')
  })

  it('drops table rows, which would otherwise read as a wall of pipes', () => {
    const text = markdownToPlainText('Before\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter')
    expect(text).toBe('Before After')
  })

  it('strips raw tags so an excerpt cannot leak markup into a meta description', () => {
    expect(markdownToPlainText('<img src=x onerror=alert(1)> text')).toBe('text')
  })
})
