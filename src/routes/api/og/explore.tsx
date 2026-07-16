import { createFileRoute } from '@tanstack/react-router'
import { searchBuilders } from '~/lib/search'
import type { ScoredBuilder } from '~/lib/search'

// Generate a simple OG image as SVG (no extra deps, no @vercel/og).
// 1200×630, dark background, query + top 3 builder handles.

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
      <stop offset="0%" stop-color="#0a0e17" />
      <stop offset="100%" stop-color="#101729" />
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#6366f1" />
      <stop offset="100%" stop-color="#06b6d4" />
    </linearGradient>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)" />

  <!-- Logo + brand -->
  <g transform="translate(80, 80)">
    <rect width="56" height="56" rx="14" fill="url(#accent)" />
    <text x="76" y="38" font-family="Inter, system-ui, sans-serif" font-size="32" font-weight="700" fill="#f3f4f6">BuilderHunt</text>
  </g>

  <!-- Big query -->
  <text x="80" y="280" font-family="Inter, system-ui, sans-serif" font-size="64" font-weight="800" fill="#f3f4f6">
    ${safeQuery}
  </text>
  <text x="80" y="340" font-family="Inter, system-ui, sans-serif" font-size="28" font-weight="500" fill="#9ca3af">
    ${builders.length > 0 ? `${builders.length}+ active developers found` : 'Explore active open-source builders'}
  </text>

  <!-- Top 3 builder chips -->
  <g transform="translate(80, 410)">
    ${top3
      .map(
        (b, i) => `
      <g transform="translate(${i * 360}, 0)">
        <rect width="320" height="120" rx="20" fill="#1a1f2e" stroke="#2a3142" />
        <circle cx="50" cy="60" r="32" fill="#2a3142" />
        <text x="100" y="56" font-family="Inter, system-ui, sans-serif" font-size="22" font-weight="600" fill="#f3f4f6">
          ${escapeXml(truncate(b.displayName ?? b.username, 18))}
        </text>
        <text x="100" y="86" font-family="Inter, system-ui, sans-serif" font-size="16" font-weight="500" fill="#9ca3af">
          @${escapeXml(truncate(b.username, 20))} · ${b.followersCount ?? 0} followers
        </text>
      </g>`,
      )
      .join('')}
  </g>

  <!-- Footer -->
  <text x="80" y="600" font-family="Inter, system-ui, sans-serif" font-size="18" font-weight="500" fill="#6b7280">
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
        const q = url.searchParams.get('q') ?? ''
        let builders: ScoredBuilder[] = []
        if (q.trim().length >= 2) {
          try {
            builders = await searchBuilders({
              keywords: q.split(/\s+/).filter(Boolean),
              perPage: 20,
              page: 1,
            })
          } catch (err) {
            console.error('og explore search error:', err)
          }
        }
        const svg = renderOgsSvg(q, builders)
        // Cache headers (24h) — but in dev, just fresh
        return new Response(svg, {
          status: 200,
          headers: {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'public, max-age=3600, s-maxage=3600',
          },
        })
      },
    },
  },
})
