import { createFileRoute } from '@tanstack/react-router'

const SITE = 'https://builderhunt.dev'

// Curated top queries that we know produce results.
const POPULAR_QUERIES = [
  'rust async runtime',
  'react server components',
  'typescript developer',
  'ai engineers',
  'kubernetes operators',
  'svelte',
  'deno runtime',
  'webassembly',
  'open source maintainers',
  'indie hackers',
  'postgres extensions',
  'edge computing',
  'python ML',
  'react performance',
  'vue 3',
  'next.js',
  'sveltekit',
  'tauri',
  'astro framework',
  'remix',
  'bun runtime',
  'golang',
  'elixir phoenix',
  'clojure',
  'clojureScript',
  'haskell',
  'lua',
  'zig',
  'crystal',
  'tailwind css',
  'prisma',
  'trpc',
  'fastapi',
  'django',
  'flask',
  'ruby on rails',
  'laravel',
  'symfony',
  'rust web',
  'axum',
  'actix',
  'rocket',
  'tokio',
  'wasm',
  'service mesh',
  'grafana',
  'observability',
  'open telemetry',
]

interface UrlEntry {
  loc: string
  lastmod?: string
  changefreq?: 'daily' | 'weekly' | 'monthly'
  priority?: number
}

function urlEntry(e: UrlEntry): string {
  const parts: string[] = []
  parts.push(`    <loc>${e.loc}</loc>`)
  if (e.lastmod) parts.push(`    <lastmod>${e.lastmod}</lastmod>`)
  if (e.changefreq) parts.push(`    <changefreq>${e.changefreq}</changefreq>`)
  if (e.priority != null) parts.push(`    <priority>${e.priority.toFixed(1)}</priority>`)
  return `  <url>\n${parts.join('\n')}\n  </url>`
}

export const Route = createFileRoute('/sitemap.xml')({
  component: () => null,
  server: {
    handlers: {
      GET: async () => {
        const today = new Date().toISOString().slice(0, 10)
        const entries: UrlEntry[] = [
          { loc: `${SITE}/`, lastmod: today, changefreq: 'weekly', priority: 1.0 },
          { loc: `${SITE}/explore`, lastmod: today, changefreq: 'weekly', priority: 0.9 },
          { loc: `${SITE}/changelog`, lastmod: today, changefreq: 'weekly', priority: 0.8 },
          { loc: `${SITE}/roadmap`, lastmod: today, changefreq: 'weekly', priority: 0.7 },
          { loc: `${SITE}/status`, lastmod: today, changefreq: 'daily', priority: 0.6 },
          { loc: `${SITE}/legal/terms`, lastmod: today, changefreq: 'monthly', priority: 0.3 },
          { loc: `${SITE}/legal/privacy`, lastmod: today, changefreq: 'monthly', priority: 0.3 },
          { loc: `${SITE}/legal/cookies`, lastmod: today, changefreq: 'monthly', priority: 0.3 },
          { loc: `${SITE}/legal/imprint`, lastmod: today, changefreq: 'monthly', priority: 0.3 },
        ]

        // /explore pages for each popular query
        for (const q of POPULAR_QUERIES) {
          entries.push({
            loc: `${SITE}/explore?q=${encodeURIComponent(q)}`,
            lastmod: today,
            changefreq: 'daily',
            priority: 0.8,
          })
        }

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map(urlEntry).join('\n')}
</urlset>
`
        return new Response(xml, {
          status: 200,
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=3600, s-maxage=3600',
          },
        })
      },
    },
  },
})
