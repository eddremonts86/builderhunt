import { createRootRoute } from '@tanstack/react-router'
import { RootDocument, RootErrorBoundary } from './-root-components'
import { NotFoundPage } from '~/components/composite/NotFoundPage'
import appCss from '~/shared/styles/globals.css?url'

const SITE_URL = 'https://builderhunt.dev'
const SITE_NAME = 'BuilderHunt'
const SITE_DESC = 'Discover active open-source builders across GitHub, Reddit, Hacker News and DEV.to. Save searches, get alerts, and track the people shipping the work — not just the repos.'
const OG_IMAGE = `${SITE_URL}/brand/og-image.png`
const LOGO = `${SITE_URL}/brand/logo-mark.png`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { name: 'color-scheme', content: 'dark' },
      { name: 'theme-color', content: '#0a0e17' },
      { name: 'generator', content: 'TanStack Start' },
      { name: 'application-name', content: SITE_NAME },
      { name: 'apple-mobile-web-app-title', content: SITE_NAME },
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
      { name: 'format-detection', content: 'telephone=no' },
      { name: 'msapplication-TileColor', content: '#0a0e17' },

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
      { property: 'og:url', content: SITE_URL },
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
      { rel: 'canonical', href: SITE_URL },
      { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
      { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' },
      { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicon-16.png' },
      { rel: 'icon', href: '/favicon.ico' },
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'stylesheet', href: appCss },
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
      { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap' },
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
              target: { '@type': 'EntryPoint', urlTemplate: `${SITE_URL}/search?q={search_term_string}` },
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
              'Multi-source builder discovery (GitHub, Reddit, Hacker News, DEV.to)',
              'Recency-weighted activity scoring',
              'Saved keyword searches',
              'Email alerts on new builder activity',
              'Private notes per builder',
              'CSV / JSON exports',
            ],
            aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.8', ratingCount: '124' },
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
                  text: 'BuilderHunt is a developer discovery tool that aggregates public activity from GitHub, Reddit, Hacker News and DEV.to, scores it for recency, and lets you save searches, get alerts, and track the people behind the work — not just the repositories.',
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
  }),
  shellComponent: RootDocument,
  errorComponent: RootErrorBoundary,
  notFoundComponent: NotFoundPage,
})
