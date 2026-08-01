import { createRootRoute, Outlet } from '@tanstack/react-router'
import { RootDocument, RootErrorBoundary } from './-root-components'
import { NotFoundPage } from '~/components/composite/NotFoundPage'
import appCss from '~/shared/styles/globals.css?url'
import { SITE_URL } from '~/shared/lib/site-url'

const SITE_NAME = 'BuilderHunt'
const SITE_DESC = 'Discover active open-source builders across GitHub, Reddit, Hacker News, DEV.to and more. Save searches, get alerts, and track the people shipping the work — not just the repos.'
const OG_IMAGE = `${SITE_URL}/brand/og-image.png`
const LOGO = `${SITE_URL}/brand/logo-mark.png`

export const Route = createRootRoute({
  head: (ctx) => {
    const leafMatch = ctx.matches[ctx.matches.length - 1]
    const pathname = leafMatch?.pathname ?? '/'
    const canonicalUrl = pathname === '/' ? SITE_URL : `${SITE_URL}${pathname}`
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
              'Multi-source builder discovery (GitHub, GitLab, Codeberg, SourceHut, Hacker News, Reddit, DEV.to, Hashnode, Stack Overflow, npm, Hugging Face, Lobsters, Devpost, Product Hunt, Bluesky)',
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
                  text: 'Yes. BuilderHunt is free to use during the public beta. Sign up with your email to start tracking builders.',
                },
              },
              {
                '@type': 'Question',
                name: 'Do I need API tokens for the sources?',
                acceptedAnswer: {
                  '@type': 'Answer',
                  text: 'No. BuilderHunt works without any API tokens, though you can optionally add a GitHub token to lift rate limits on bigger searches.',
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
