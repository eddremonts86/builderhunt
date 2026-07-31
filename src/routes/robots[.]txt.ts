import { createFileRoute } from '@tanstack/react-router'
import { SITE_URL as SITE } from '~/shared/lib/site-url'
import { SEO_SURFACE_DEFINITIONS, SEO_SURFACES } from '~/shared/lib/seo/surfaces'
import { NAV_AREAS } from '~/modules/dashboard/ui/shell/nav-config'

/** Public and not admin-toggleable. */
const ALWAYS_ALLOWED = ['/', '/explore', '/builders/', '/status', '/legal/']

/**
 * A bare prefix (`/search`) blocks both the page itself and everything under it. Only widen to a
 * trailing-slash form (`/builder/`) when the bare prefix would otherwise also swallow an allowed
 * path — `/builder` is a literal prefix of the public `/builders/` profile route.
 */
function disallowPrefixFor(route: string): string {
  const collidesWithAllowed = ALWAYS_ALLOWED.some((allowed) => allowed !== route && allowed.startsWith(route))
  return collidesWithAllowed ? `${route}/` : route
}

// Every authenticated top-level area from the dashboard's own navigation registry, so a new area
// added there is disallowed here automatically instead of relying on someone to remember this file.
// `/status` is excluded — it is deliberately public (see ALWAYS_ALLOWED).
const AUTHENTICATED_NAV_ROUTES = Array.from(new Set(NAV_AREAS.flatMap((area) => area.routes)))
  .filter((route) => route !== '/status')

/** Never crawlable by anyone — authenticated app, APIs, auth flows. */
const ALWAYS_DISALLOWED = [
  '/api/',
  '/auth/',
  '/_dashboard/',
  '/onboarding/',
  ...AUTHENTICATED_NAV_ROUTES.map(disallowPrefixFor),
]

/**
 * The AI crawlers we name explicitly. A named group REPLACES the `*` group for
 * that agent rather than adding to it, so each one has to repeat the rules —
 * previously these groups were a bare `Allow: /`, which quietly exempted them
 * from every `Disallow` above.
 */
const NAMED_AGENTS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended']

export const Route = createFileRoute('/robots.txt')({
  component: () => null,
  server: {
    handlers: {
      GET: async () => {
        // The three content surfaces are admin-toggleable at runtime
        // (/admin/content), so their Allow/Disallow lines are derived rather
        // than typed. A hidden surface is disallowed here AND carries a robots
        // meta tag on the page: robots.txt stops a crawl, the meta tag handles a
        // URL discovered some other way (a shared link), and neither alone is
        // sufficient.
        const { getSurfaceDirectives } = await import('~/shared/lib/repositories/public-surface-indexing')
        const directives = await getSurfaceDirectives()

        const surfaceRules = SEO_SURFACES.flatMap((surface) =>
          SEO_SURFACE_DEFINITIONS[surface].paths.map(
            (path) => `${directives[surface].noindex ? 'Disallow' : 'Allow'}: ${path}`,
          ),
        )

        const rules = [
          ...ALWAYS_ALLOWED.map((path) => `Allow: ${path}`),
          ...surfaceRules,
          ...ALWAYS_DISALLOWED.map((path) => `Disallow: ${path}`),
        ].join('\n')

        const groups = [
          `User-agent: *\n${rules}`,
          ...NAMED_AGENTS.map((agent) => `User-agent: ${agent}\n${rules}`),
        ].join('\n\n')

        const body = `# BuilderHunt robots.txt
# Per-surface rules for /blog, /changelog and /roadmap are generated from the
# indexing settings in the admin panel — edit them there, not here.

${groups}

# Sitemap
Sitemap: ${SITE}/sitemap.xml
`
        return new Response(body, {
          status: 200,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            // Short: a surface toggled in the admin panel must not stay
            // mis-advertised for an hour behind a CDN.
            'Cache-Control': 'public, max-age=60, s-maxage=60',
          },
        })
      },
    },
  },
})
