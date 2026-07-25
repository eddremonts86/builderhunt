import { createFileRoute } from '@tanstack/react-router'
import { searchBuilders } from '~/lib/search'
import type { ScoredBuilder } from '~/lib/search'
// `~/shared/lib/repositories/public-radars` imports `publicDb`, which eagerly
// opens a real `postgres()` client at module scope — and the `postgres`
// package's own internals reference the Node-only `Buffer` global. This
// route file is part of TanStack Start's client-navigable route tree, so a
// static top-level import here would ship that whole chain into the browser
// bundle and crash on load (`ReferenceError: Buffer is not defined`) before
// React ever hydrates, even though the client never calls this GET handler.
// Imported dynamically inside the handler instead — see the matching note
// in src/lib/sources/devpost.ts, which hit the exact same failure mode.

// Render the OG image as SVG, then rasterize to PNG via @resvg/resvg-js.
// Twitter/Facebook/LinkedIn/Slack link previews don't render `og:image`
// unless it's a raster format — a raw SVG silently fails everywhere.
// 1200×630, warm-light background (matches src/shared/styles/globals.css
// tokens), query + top 3 builder handles.

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

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function renderOgsSvg(query: string, builders: ScoredBuilder[]): string {
  const top3 = builders.slice(0, 3)
  const safeQuery = truncate(escapeXml(query || 'Explore'), 60)

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

  <!-- Big query -->
  <text x="80" y="280" font-family="Inter, system-ui, sans-serif" font-size="64" font-weight="800" fill="#18181b">
    ${safeQuery}
  </text>
  <text x="80" y="340" font-family="Inter, system-ui, sans-serif" font-size="28" font-weight="500" fill="#52525b">
    ${builders.length > 0 ? `${builders.length}+ active developers found` : 'Explore active open-source builders'}
  </text>

  <!-- Top 3 builder chips -->
  <g transform="translate(80, 410)">
    ${top3
      .map(
        (b, i) => `
      <g transform="translate(${i * 360}, 0)">
        <rect width="320" height="120" rx="20" fill="#ffffff" stroke="#e4e4e7" />
        <circle cx="50" cy="60" r="32" fill="#f1f1f3" />
        <text x="100" y="56" font-family="Inter, system-ui, sans-serif" font-size="22" font-weight="600" fill="#18181b">
          ${escapeXml(truncate(b.displayName ?? b.username, 18))}
        </text>
        <text x="100" y="86" font-family="Inter, system-ui, sans-serif" font-size="16" font-weight="500" fill="#52525b">
          @${escapeXml(truncate(b.username, 20))} · ${b.followersCount ?? 0} followers
        </text>
      </g>`,
      )
      .join('')}
  </g>

  <!-- Footer -->
  <text x="80" y="600" font-family="Inter, system-ui, sans-serif" font-size="18" font-weight="500" fill="#71717a">
    builderhunt.dev/explore — Find active builders across 12 sources
  </text>
</svg>`
}

export const Route = createFileRoute('/api/og/explore')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const radarSlug = url.searchParams.get('radar') ?? ''
        let q = url.searchParams.get('q') ?? ''
        let keywords: string[] = []
        let sources: string[] | undefined
        let language: string | undefined

        if (radarSlug) {
          const { findPublicRadarBySlug, getPublicRadarQuery } = await import('~/shared/lib/repositories/public-radars')
          const radar = await findPublicRadarBySlug(radarSlug)
          const resolved = radar ? await getPublicRadarQuery(radar.organizationId, radar.savedQueryId) : null
          if (resolved) {
            q = resolved.query.name
            keywords = resolved.query.keywords
            sources = resolved.query.sources ?? undefined
            language = resolved.query.language ?? undefined
          }
        } else {
          keywords = q.split(/\s+/).filter(Boolean)
        }

        let builders: ScoredBuilder[] = []
        if (keywords.length > 0) {
          try {
            builders = await searchBuilders({
              keywords,
              sources,
              language,
              perPage: 20,
              page: 1,
            })
          } catch (err) {
            console.error('og explore search error:', err)
          }
        }
        const svg = renderOgsSvg(q, builders)

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
              'Cache-Control': 'public, max-age=3600, s-maxage=3600',
            },
          })
        } catch (err) {
          console.error('og explore rasterize error:', err)
          // Fall back to SVG rather than a hard failure — still renders
          // fine as a direct <img>, just won't be picked up by crawlers
          // that require a raster og:image.
          return new Response(svg, {
            status: 200,
            headers: {
              'Content-Type': 'image/svg+xml; charset=utf-8',
              'Cache-Control': 'public, max-age=3600, s-maxage=3600',
            },
          })
        }
      },
    },
  },
})
