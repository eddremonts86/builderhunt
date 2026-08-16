/**
 * The `<head>` of a segment page (plan: phase-2/06-landing-segmentada).
 *
 * Separate from `segment-pages.ts` on purpose. That module is content and nothing else, which is
 * what lets a Playwright spec — a plain Node process with no `.env` loaded — import it to check the
 * copy it is asserting against. This one reaches `site-url.ts` and therefore `env.ts`, so keeping
 * the two apart is the difference between a spec that imports content and a spec that boots the
 * environment.
 *
 * ## One builder, three routes
 *
 * The three routes hand-rolled `title` / `description` / `og:*` and left out `twitter:*`, which is
 * exactly the drift `pageMeta` exists to prevent: a page that looks correct in a browser tab and in
 * Google, and previews as the homepage on X. Building all of it in one place also means the JSON-LD
 * cannot describe a different page from the meta tags.
 *
 * ## No canonical tag here
 *
 * The root route owns `<link rel="canonical">` and `og:url`, derived from the pathname via
 * `canonicalUrlFor`. A route that emits its own produces *two* canonical tags, which search engines
 * discard rather than reconcile. `?goal=` is not in `CANONICAL_SEARCH_PARAMS`, so every shared link
 * carrying a hint already canonicalises to the bare path — which is the correct answer, because the
 * hint changes nothing a crawler can see.
 *
 * ## What the structured data claims, and what it does not
 *
 * `WebPage` and `BreadcrumbList`: the page itself, and where it sits in the site. Both describe
 * something that is true of every request.
 *
 * Deliberately **no `FAQPage`**, although each page renders exactly one question and answer. That
 * type says the page *is* a list of questions, and these pages are not — the objection is one block
 * among five. Marking it up anyway would be describing the page as something it is not in order to
 * qualify for a rich result, which is the same move as a claim with no evidence behind it.
 */
import { pageMeta } from '~/shared/lib/page-meta'
import { SITE_URL } from '~/shared/lib/site-url'
import type { SegmentPageContent } from '~/modules/landing/content/segment-pages'

/** Same local constant as `__root.tsx` and the other public routes. */
const SITE_NAME = 'BuilderHunt'

export interface SegmentPageHead {
  meta: Array<Record<string, string>>
  scripts: Array<{ type: string; children: string }>
}

export function segmentPageHead(page: SegmentPageContent): SegmentPageHead {
  const url = `${SITE_URL}${page.path}`

  return {
    meta: pageMeta({
      title: `${page.title} · ${SITE_NAME}`,
      description: page.metaDescription,
    }),
    scripts: [
      {
        type: 'application/ld+json',
        children: JSON.stringify([
          {
            '@context': 'https://schema.org',
            '@type': 'WebPage',
            '@id': `${url}#webpage`,
            url,
            name: page.title,
            description: page.metaDescription,
            inLanguage: 'en-US',
            // The `@id`s the root route already published, so this page joins that graph rather
            // than declaring a second site and a second publisher of its own.
            isPartOf: { '@id': `${SITE_URL}#website` },
            publisher: { '@id': `${SITE_URL}#organization` },
            breadcrumb: { '@id': `${url}#breadcrumb` },
          },
          {
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            '@id': `${url}#breadcrumb`,
            itemListElement: [
              { '@type': 'ListItem', position: 1, name: SITE_NAME, item: SITE_URL },
              { '@type': 'ListItem', position: 2, name: page.heading, item: url },
            ],
          },
        ]),
      },
    ],
  }
}
