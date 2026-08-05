import { createRootRoute, Outlet } from '@tanstack/react-router'
import { RootDocument, RootErrorBoundary } from './-root-components'
import { NotFoundPage } from '~/components/composite/NotFoundPage'
import appCss from '~/shared/styles/globals.css?url'
import { SITE_URL } from '~/shared/lib/site-url'
import { canonicalUrlFor } from '~/shared/lib/page-meta'

const SITE_NAME = 'BuilderHunt'
const SITE_DESC = 'Discover active open-source builders across GitHub, Reddit, Hacker News, DEV.to and more. Save searches, get alerts, and track the people shipping the work — not just the repos.'
const OG_IMAGE = `${SITE_URL}/brand/og-image.png`
const LOGO = `${SITE_URL}/brand/logo-mark.png`

export const Route = createRootRoute({
  head: (ctx) => {
    const leafMatch = ctx.matches[ctx.matches.length - 1]
    const pathname = leafMatch?.pathname ?? '/'
    // The pathname alone is not the page's identity everywhere: `/explore` is a
    // different page for every `?q=`. `canonicalUrlFor` appends the
    // identity-bearing search params (allowlisted, so no tracking param can leak
    // into a canonical) and is the single owner of this URL — a route that emits
    // its own `<link rel="canonical">` produces *two* canonical tags, which
    // search engines discard rather than reconcile.
    const canonicalUrl = canonicalUrlFor(pathname, leafMatch?.search)
    return {
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { name: 'color-scheme', content: 'light dark' },
      { name: 'theme-color', content: '#ececf0' },
      { name: 'generator', content: 'TanStack Start' },
      { name: 'application-name', content: SITE_NAME },
      { name: 'apple-mobile-web-app-title', content: SITE_NAME },
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
      { name: 'format-detection', content: 'telephone=no' },
      { name: 'msapplication-TileColor', content: '#ececf0' },

      // Primary SEO
      { title: `${SITE_NAME} — Discover Active Builders Across the Open Web` },
      { name: 'description', content: SITE_DESC },
      { name: 'keywords', content: 'developer discovery, open source contributors, GitHub users, Reddit developers, Hacker News, DEV.to, talent sourcing, builder radar, OSS scouts, recruiter tool, dev talent' },
      { name: 'author', content: SITE_NAME },
      { name: 'robots', content: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1' },
      { name: 'googlebot', content: 'index, follow' },
      { name: 'rating', content: 'general' },
      { name: 'referrer', content: 'strict-origin-when-cross-origin' },

      // Open Graph
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: SITE_NAME },
      { property: 'og:title', content: `${SITE_NAME} — Discover Active Builders Across the Open Web` },
      { property: 'og:description', content: SITE_DESC },
      { property: 'og:url', content: canonicalUrl },
      { property: 'og:image', content: OG_IMAGE },
      { property: 'og:image:width', content: '1920' },
      { property: 'og:image:height', content: '1080' },
      { property: 'og:image:alt', content: 'BuilderHunt — discover active builders across the open web' },
      { property: 'og:image:type', content: 'image/png' },
      { property: 'og:locale', content: 'en_US' },

      // Twitter
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: `${SITE_NAME} — Discover Active Builders Across the Open Web` },
      { name: 'twitter:description', content: SITE_DESC },
      { name: 'twitter:image', content: OG_IMAGE },
      { name: 'twitter:image:alt', content: 'BuilderHunt — discover active builders across the open web' },
    ],
    links: [
      { rel: 'canonical', href: canonicalUrl },
      { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
      { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' },
      { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicon-16.png' },
      { rel: 'icon', href: '/favicon.ico' },
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'stylesheet', href: appCss },
      // Self-hosted fonts (see src/shared/styles/globals.css @font-face). Preload
      // the above-fold Inter face; JetBrains Mono is below-fold (code blocks).
      { rel: 'preload', href: '/fonts/inter-latin-wght-normal.woff2', as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
    ],
    scripts: [
      {
        type: 'application/ld+json',
        children: JSON.stringify([
          {
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            '@id': `${SITE_URL}#website`,
            url: SITE_URL,
            name: SITE_NAME,
            description: SITE_DESC,
            inLanguage: 'en-US',
            publisher: { '@id': `${SITE_URL}#organization` },
            potentialAction: {
              '@type': 'SearchAction',
              // `/search` requires an authenticated session — a crawler or
              // anonymous visitor following this SearchAction must land
              // somewhere that actually works, so this points at the public
              // guest-search route instead (plan: audit-conversion).
              target: { '@type': 'EntryPoint', urlTemplate: `${SITE_URL}/explore?q={search_term_string}` },
              'query-input': 'required name=search_term_string',
            },
          },
          {
            '@context': 'https://schema.org',
            '@type': 'Organization',
            '@id': `${SITE_URL}#organization`,
            name: SITE_NAME,
            url: SITE_URL,
            logo: LOGO,
            description: SITE_DESC,
            sameAs: [
              'https://github.com/builderhunt',
              'https://twitter.com/builderhunt',
            ],
          },
          {
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            name: SITE_NAME,
            applicationCategory: 'DeveloperApplication',
            applicationSubCategory: 'Talent Discovery',
            operatingSystem: 'Web',
            description: SITE_DESC,
            url: SITE_URL,
            image: OG_IMAGE,
            offers: {
              '@type': 'Offer',
              price: '0',
              priceCurrency: 'USD',
              availability: 'https://schema.org/InStock',
            },
            featureList: [
              // Exactly the keys in IMPLEMENTED_SEARCH_CONNECTORS, under the labels from
              // `source-presentation.ts`. This listed SourceHut and Hashnode until 2026-08-05,
              // months after both connectors were retired (drizzle/0143, drizzle/0144) — a public
              // structured-data claim about a capability the product had removed. The test in
              // tests/unit/modules/landing/components/trust-claims.test.ts now derives the expected
              // set from the registry, so retiring a source fails the build until this line follows.
              'Multi-source builder discovery (GitHub, GitLab, Codeberg, Hacker News, Reddit, DEV.to, Stack Overflow, npm, Hugging Face, Lobsters, Devpost, Product Hunt, Bluesky)',
              'Recency-weighted activity scoring',
              'Saved keyword searches',
              'Email alerts on new builder activity',
              'Private notes per builder',
              'CSV / JSON exports',
            ],
            // Deliberately no review-rating field here — BuilderHunt has no
            // review corpus to report, and an unsourced number is exactly
            // the kind of runtime-unbacked structured-data claim this app
            // must not publish. See tests/unit/modules/landing/components/trust-claims.test.ts,
            // which also checks featureList's export claim against the real capability registry.
          },
          {
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: [
              {
                '@type': 'Question',
                name: 'What is BuilderHunt?',
                acceptedAnswer: {
                  '@type': 'Answer',
                  text: 'BuilderHunt is a developer discovery tool that aggregates public activity from GitHub, Reddit, Hacker News, DEV.to and more, scores it for recency, and lets you save searches, get alerts, and track the people behind the work — not just the repositories.',
                },
              },
              {
                '@type': 'Question',
                name: 'Is BuilderHunt free?',
                acceptedAnswer: {
                  '@type': 'Answer',
                  text: 'BuilderHunt has a Free plan that stays free: 3 saved searches, 50 saved builders, and full access to the public explore and blog pages, with no credit card required. Paid plans (Pro, Pro Max, Team) add smart alerts, semantic search, AI sourcing sprints and a monthly credit grant.',
                },
              },
              {
                '@type': 'Question',
                name: 'Do I need API tokens for the sources?',
                acceptedAnswer: {
                  '@type': 'Answer',
                  // This answer used to close by inviting the reader to supply their own GitHub
                  // credential to lift rate limits — the same fabricated claim
                  // plans/phase-1/52-audit-trust removed from the landing copy, since no UI
                  // anywhere accepts one. The regression guard read only HomePage and FAQSection,
                  // so it survived here, in structured data: the one surface where a stale claim
                  // outlives the page it came from. The guard now covers this file too, and it
                  // matches raw source, so do not restate the retired wording in a comment.
                  text: 'No. Every source works out of the box with no setup on your end — there is nothing for you to configure or supply.',
                },
              },
              {
                '@type': 'Question',
                name: 'How is the activity score calculated?',
                acceptedAnswer: {
                  '@type': 'Answer',
                  text: 'The score is a recency-weighted blend of stars, forks, upvotes, karma, and posts. Recent activity is worth much more than old activity, so the top of your results are the people shipping now.',
                },
              },
            ],
          },
        ]),
      },
    ],
    }
  },
  component: Outlet,
  shellComponent: RootDocument,
  errorComponent: RootErrorBoundary,
  notFoundComponent: NotFoundPage,
})
