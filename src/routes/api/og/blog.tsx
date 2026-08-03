import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { getPostBySlug } from '~/shared/lib/blog'

// Render the OG image as SVG, then rasterize to PNG via @resvg/resvg-js —
// same pipeline as api/og/explore.tsx. Title (wrapped, max 3 lines), date +
// author, BuilderHunt branding.

const WIDTH = 1200
const HEIGHT = 630

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '&': return '&amp;'
      case "'": return '&apos;'
      case '"': return '&quot;'
      default: return c
    }
  })
}

// Greedy word-wrap into at most `maxLines` lines of roughly `maxChars` each,
// truncating the final line with an ellipsis if the title overflows.
function wrapTitle(title: string, maxChars: number, maxLines: number): string[] {
  const words = title.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  let i = 0
  while (i < words.length && lines.length < maxLines) {
    const word = words[i]
    const next = current ? `${current} ${word}` : word
    if (next.length > maxChars && current) {
      lines.push(current)
      current = ''
    } else {
      current = next
      i++
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current)
  }
  const overflow = i < words.length
  if (overflow && lines.length > 0) {
    const last = lines.length - 1
    const truncated = lines[last].length > maxChars - 1 ? lines[last].slice(0, maxChars - 1) : lines[last]
    lines[last] = `${truncated}…`
  }
  return lines
}

function renderBlogOgSvg(title: string, date: string, author: string): string {
  const lines = wrapTitle(title, 24, 3)
  const formattedDate = new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ececf0" />
      <stop offset="100%" stop-color="#f1f1f3" />
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#e07338" />
      <stop offset="100%" stop-color="#ca5d25" />
    </linearGradient>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)" />

  <!-- Logo + brand -->
  <g transform="translate(80, 80)">
    <rect width="56" height="56" rx="14" fill="url(#accent)" />
    <text x="76" y="38" font-family="Inter, system-ui, sans-serif" font-size="32" font-weight="700" fill="#18181b">BuilderHunt</text>
  </g>
  <text x="80" y="168" font-family="Inter, system-ui, sans-serif" font-size="20" font-weight="600" letter-spacing="2" fill="#ca5d25">BLOG</text>

  <!-- Title (wrapped, up to 3 lines) -->
  <text font-family="Inter, system-ui, sans-serif" font-size="58" font-weight="800" fill="#18181b">
    ${lines.map((line, i) => `<tspan x="80" y="${260 + i * 68}">${escapeXml(line)}</tspan>`).join('')}
  </text>

  <!-- Footer -->
  <text x="80" y="560" font-family="Inter, system-ui, sans-serif" font-size="22" font-weight="500" fill="#52525b">
    ${escapeXml(formattedDate)} · By ${escapeXml(author)}
  </text>
  <text x="80" y="600" font-family="Inter, system-ui, sans-serif" font-size="18" font-weight="500" fill="#71717a">
    builderhunt.dev/blog
  </text>
</svg>`
}

export const Route = createFileRoute('/api/og/blog')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        const url = new URL(request.url)
        const slug = url.searchParams.get('slug') ?? ''
        const post = slug ? await getPostBySlug(slug) : null
        if (!post) {
          return Response.json({ error: 'Post not found' }, { status: 404 })
        }

        const svg = renderBlogOgSvg(post.title, post.date, post.author)

        try {
          const { Resvg } = await import('@resvg/resvg-js')
          const png = new Resvg(svg, {
            fitTo: { mode: 'width', value: WIDTH },
            font: { loadSystemFonts: true },
          })
            .render()
            .asPng()
          return new Response(new Uint8Array(png), {
            status: 200,
            headers: {
              'Content-Type': 'image/png',
              'Cache-Control': 'public, max-age=86400',
            },
          })
        } catch (err) {
          console.error('og blog rasterize error:', err)
          return new Response(svg, {
            status: 200,
            headers: {
              'Content-Type': 'image/svg+xml; charset=utf-8',
              'Cache-Control': 'public, max-age=86400',
            },
          })
        }
      },
    },
  },
})
