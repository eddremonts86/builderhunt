import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { savedQueries } from '~/shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { searchBuilders } from '~/lib/search'
import { env } from '~/shared/lib/env'

/**
 * Public RSS feed for a saved search.
 * GET /api/feeds/:searchId.xml
 * - No auth required. The feed is intentionally public so users can share
 *   it with teammates or in their RSS reader.
 * - The data indexed is already public (sourced from public APIs).
 * - Cache-Control: 1h (RSS readers poll aggressively).
 * - Simple in-memory rate limit: 60 req/h per IP.
 */

const RATE_BUCKET = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT = 60
const RATE_WINDOW_MS = 60 * 60 * 1000

function checkRate(ip: string): boolean {
  const now = Date.now()
  const bucket = RATE_BUCKET.get(ip)
  if (!bucket || bucket.resetAt < now) {
    RATE_BUCKET.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return true
  }
  if (bucket.count >= RATE_LIMIT) return false
  bucket.count++
  return true
}

function escapeXml(s: string | null | undefined): string {
  if (!s) return ''
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return ''
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function rfc822(d: Date): string {
  return d.toUTCString()
}

function extractIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return headers.get('x-real-ip') ?? 'unknown'
}

interface BuilderForFeed {
  id: string
  username: string
  displayName?: string | null
  bio?: string | null
  profileUrl: string
  source: string
  followersCount?: number | null
  topics?: string[] | null
  lastSeen?: string | Date | null
  score?: number | null
  metadata?: Record<string, unknown> | null
}

function buildRssXml(opts: {
  search: { id: string; name: string; keywords: string[] }
  builders: BuilderForFeed[]
  selfUrl: string
  siteUrl: string
}): string {
  const { search, builders, selfUrl, siteUrl } = opts
  const searchUrl = `${siteUrl}/search?q=${encodeURIComponent(search.keywords.join(' '))}`

  const items = builders
    .map((b) => {
      const title = `${b.displayName ?? b.username} — ${search.name}`
      const link = b.profileUrl
      const guid = `builderhunt-builder-${b.id}`
      const pubDate = b.lastSeen ? rfc822(new Date(b.lastSeen)) : rfc822(new Date())
      const descParts: string[] = []
      if (b.bio) descParts.push(`<p>${escapeXml(truncate(b.bio, 200))}</p>`)
      const topicList = (b.topics ?? []).slice(0, 5)
      if (topicList.length > 0) {
        descParts.push(
          `<p><strong>Topics:</strong> ${topicList.map(escapeXml).join(', ')}</p>`,
        )
      }
      descParts.push(`<p><strong>Source:</strong> ${escapeXml(b.source)}</p>`)
      if (b.followersCount != null && b.followersCount > 0) {
        descParts.push(
          `<p><strong>Followers/score:</strong> ${b.followersCount.toLocaleString()}</p>`,
        )
      }
      descParts.push(
        `<p>Matches keywords in your saved search "${escapeXml(search.name)}".</p>`,
      )
      const desc = descParts.join('\n')

      return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">${escapeXml(guid)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[${desc}]]></description>
    </item>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(`BuilderHunt — ${search.name}`)}</title>
    <link>${escapeXml(searchUrl)}</link>
    <description>${escapeXml(`New builders matching "${search.name}" (${search.keywords.join(', ')}). Updated daily.`)}</description>
    <language>en-us</language>
    <lastBuildDate>${rfc822(new Date())}</lastBuildDate>
    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>`
}

function buildHtmlFallback(opts: {
  search: { id: string; name: string; keywords: string[] }
  builders: BuilderForFeed[]
  selfUrl: string
  siteUrl: string
}): string {
  const { search, builders, selfUrl, siteUrl } = opts
  const itemsHtml = builders
    .slice(0, 5)
    .map((b) => {
      const topicList = (b.topics ?? []).slice(0, 5).map(escapeXml).join(', ')
      return `<li>
        <a href="${escapeXml(b.profileUrl)}" rel="noopener noreferrer" target="_blank">
          <strong>${escapeXml(b.displayName ?? b.username)}</strong>
        </a>
        <span class="meta"> · ${escapeXml(b.source)}${topicList ? ` · ${escapeXml(topicList)}` : ''}</span>
        ${b.bio ? `<div class="bio">${escapeXml(truncate(b.bio, 180))}</div>` : ''}
      </li>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>BuilderHunt RSS — ${escapeXml(search.name)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #1f2937; line-height: 1.5; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #4b5563; }
    code { background: #f3f4f6; padding: 0.1rem 0.3rem; border-radius: 4px; font-size: 0.9em; }
    .feed-url { display: flex; gap: 0.5rem; align-items: center; margin: 1.5rem 0; padding: 0.75rem; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; }
    .feed-url input { flex: 1; border: none; background: transparent; font-family: ui-monospace, monospace; font-size: 0.85rem; }
    .feed-url button { padding: 0.4rem 0.8rem; background: #6366f1; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.85rem; }
    .feed-url button:hover { background: #4f46e5; }
    .subscribe-row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 1rem 0; }
    .subscribe-row a { padding: 0.5rem 0.9rem; background: #fff; color: #1f2937; border: 1px solid #d1d5db; border-radius: 6px; text-decoration: none; font-size: 0.9rem; }
    .subscribe-row a:hover { background: #f9fafb; border-color: #9ca3af; }
    ul { list-style: none; padding: 0; }
    li { padding: 1rem 0; border-bottom: 1px solid #e5e7eb; }
    li:last-child { border-bottom: none; }
    .meta { color: #6b7280; font-size: 0.85rem; }
    .bio { color: #4b5563; font-size: 0.9rem; margin-top: 0.3rem; }
    .empty { color: #6b7280; font-style: italic; }
  </style>
</head>
<body>
  <h1>📡 ${escapeXml(search.name)}</h1>
  <p>This is a <strong>public RSS feed</strong> for the saved search <em>${escapeXml(search.name)}</em> on BuilderHunt. Anyone with this link can subscribe.</p>

  <div class="feed-url">
    <input type="text" readonly value="${escapeXml(selfUrl)}" id="feed-url" onclick="this.select()" />
    <button onclick="navigator.clipboard.writeText('${escapeXml(selfUrl)}').then(() => { this.textContent = 'Copied!' }).catch(() => { this.textContent = 'Copy failed' })">Copy</button>
  </div>

  <p>Subscribe with:</p>
  <div class="subscribe-row">
    <a href="https://feedly.com/i/subscription/feed/${encodeURIComponent(selfUrl)}" target="_blank" rel="noopener noreferrer">Feedly</a>
    <a href="https://www.inoreader.com/?add_feed=${encodeURIComponent(selfUrl)}" target="_blank" rel="noopener noreferrer">Inoreader</a>
    <a href="https://netnewswire.com/" target="_blank" rel="noopener noreferrer">NetNewsWire</a>
  </div>

  <h2 style="font-size: 1.1rem; margin-top: 2rem;">Recent matches</h2>
  ${builders.length === 0 ? '<p class="empty">No matching builders yet. New matches will appear here automatically.</p>' : `<ul>${itemsHtml}</ul>`}

  <p style="margin-top: 2rem; font-size: 0.85rem; color: #6b7280;">
    <a href="${escapeXml(siteUrl)}">BuilderHunt</a> — find active developers across GitHub, Reddit, HN, DEV.to, and more.
  </p>
</body>
</html>`
}

export const Route = createFileRoute('/api/feeds/$searchId')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const ip = extractIp(request.headers)
          if (!checkRate(ip)) {
            return new Response('Rate limit exceeded. Try again in 1 hour.', {
              status: 429,
              headers: { 'Content-Type': 'text/plain' },
            })
          }

          const { searchId } = params
          const [search] = await db
            .select()
            .from(savedQueries)
            .where(eq(savedQueries.id, searchId))

          if (!search) {
            return new Response('Feed not found', {
              status: 404,
              headers: { 'Content-Type': 'text/plain' },
            })
          }

          const sources = (search.sources ?? ['github']) as string[]
          const results = await searchBuilders({
            keywords: search.keywords,
            sources,
            language: search.language ?? undefined,
            country: search.country ?? undefined,
            perPage: 50,
          })

          const siteUrl = env.APP_URL.replace(/\/$/, '')
          const selfUrl = `${siteUrl}/api/feeds/${searchId}?format=rss`

          // Browsers (without an explicit RSS reader Accept) get HTML.
          // RSS readers send application/rss+xml or */* — give them XML.
          const accept = request.headers.get('accept') ?? ''
          const wantsHtml = accept.includes('text/html') && !accept.includes('application/rss')

          if (wantsHtml) {
            const html = buildHtmlFallback({
              search: { id: search.id, name: search.name, keywords: search.keywords },
              builders: results as BuilderForFeed[],
              selfUrl,
              siteUrl,
            })
            return new Response(html, {
              status: 200,
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'public, max-age=3600',
              },
            })
          }

          const xml = buildRssXml({
            search: { id: search.id, name: search.name, keywords: search.keywords },
            builders: results as BuilderForFeed[],
            selfUrl,
            siteUrl,
          })
          return new Response(xml, {
            status: 200,
            headers: {
              'Content-Type': 'application/rss+xml; charset=utf-8',
              'Cache-Control': 'public, max-age=3600',
            },
          })
        } catch (err) {
          console.error('RSS feed error:', err)
          return new Response('Internal error', { status: 500 })
        }
      },
    },
  },
})
