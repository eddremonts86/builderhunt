import { createFileRoute } from '@tanstack/react-router'
import { SITE_URL as SITE } from '~/shared/lib/site-url'

export const Route = createFileRoute('/robots.txt')({
  component: () => null,
  server: {
    handlers: {
      GET: async () => {
        const body = `# BuilderHunt robots.txt
User-agent: *
Allow: /
Allow: /explore
Allow: /builders/
Allow: /changelog
Allow: /roadmap
Allow: /status
Allow: /legal/

Disallow: /api/
Disallow: /auth/
Disallow: /dashboard/
Disallow: /_dashboard/
Disallow: /settings/
Disallow: /onboarding/
Disallow: /me/

# AI bots (explicit allow — we want them to crawl our public content)
User-agent: GPTBot
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: Google-Extended
Allow: /

# Sitemap
Sitemap: ${SITE}/sitemap.xml
`
        return new Response(body, {
          status: 200,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=3600, s-maxage=3600',
          },
        })
      },
    },
  },
})
