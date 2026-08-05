import { SITE_URL } from '~/shared/lib/site-url'

/**
 * Build a page's title/description together with the Open Graph and Twitter
 * copies of the same two strings.
 *
 * This exists because a route that sets only `{ title }` and
 * `{ name: 'description' }` still *looks* correct: the browser tab is right,
 * the `<meta name="description">` is right, and Google reads both. What it
 * silently keeps is the root route's `og:title` / `og:description`, so pasting
 * the URL into Slack, X or LinkedIn previews the **homepage** — same headline,
 * same blurb, whatever the page actually is.
 *
 * Found 2026-08-05 on `/pricing` and ten other public routes: every one of them
 * shared "BuilderHunt — Discover Active Builders Across the Open Web". A launch
 * post linking to /pricing would have shown a preview that says nothing about
 * pricing.
 *
 * Two things are deliberately NOT handled here:
 *
 * - **robots directives.** Several of these pages take their indexing state
 *   from the admin panel via `robotsMetaTag()`; mixing that into a helper about
 *   social previews would hide where the decision comes from.
 *   Spread `...robotsMetaTag(...)` after this call as before.
 * - **Pages that must not be previewable at all.**
 *   `schedule/$invitationId` is `noindex, nofollow, noarchive` with
 *   `referrer: no-referrer` on purpose — it is a candidate's private
 *   invitation. It keeps a bare static title and must never gain og tags.
 */
/**
 * The search params that are part of a page's *identity*, in the order they are
 * emitted, with the default that means "same page as without it".
 *
 * The root route builds `<link rel="canonical">` and `og:url` from the pathname
 * alone. For `/explore` that is always `/explore/`, so all ~50 `/explore?q=…`
 * URLs in the sitemap declared themselves duplicates of one page (found
 * 2026-08-05) — Google would have indexed one Explore page and dropped every
 * query, which is the opposite of why they are listed.
 *
 * Only identity-bearing params belong here. Tracking params (`utm_*`, `ref`,
 * `fbclid`) must never reach a canonical URL, and an allowlist is the only way
 * to be sure of that: a denylist has to guess every future one.
 *
 * `type` carries its schema default so the canonical of `/explore?q=react`
 * stays `/explore?q=react` even though the router normalises the served URL to
 * `?q=react&type=people`. That keeps canonical byte-identical to what
 * `src/routes/sitemap[.]xml.ts` emits — if either changes, so must the other.
 */
const CANONICAL_SEARCH_PARAMS: Array<{ key: string; omitWhen?: string }> = [
  { key: 'q' },
  { key: 'sources' },
  { key: 'type', omitWhen: 'people' },
]

/**
 * Absolute canonical URL for a pathname plus the identity-bearing part of its
 * search params. Trailing slashes are normalised away so `/explore/` and
 * `/explore` cannot disagree.
 */
export function canonicalUrlFor(pathname: string, search?: unknown): string {
  const path = pathname === '/' ? '' : pathname.replace(/\/+$/, '')
  const record = (search && typeof search === 'object' ? search : {}) as Record<string, unknown>

  const pairs: string[] = []
  for (const { key, omitWhen } of CANONICAL_SEARCH_PARAMS) {
    const raw = record[key]
    if (typeof raw !== 'string') continue
    const value = raw.trim()
    if (!value || value === omitWhen) continue
    pairs.push(`${key}=${encodeURIComponent(value)}`)
  }

  return `${SITE_URL}${path}${pairs.length > 0 ? `?${pairs.join('&')}` : ''}`
}

export function pageMeta(input: {
  title: string
  description: string
  /** Absolute URL, or a path that is resolved against SITE_URL. Defaults to the site's OG image. */
  image?: string
  /**
   * The page's own canonical URL, when the root route cannot derive it.
   * The root builds `og:url` from the pathname alone, so any page whose
   * identity includes a query string (`/explore?q=react`) must pass it here or
   * it declares itself a duplicate of the bare path.
   */
  url?: string
}): Array<Record<string, string>> {
  const { title, description } = input
  const image = input.image
    ? (input.image.startsWith('http') ? input.image : `${SITE_URL}${input.image}`)
    : undefined
  const url = input.url
    ? (input.url.startsWith('http') ? input.url : `${SITE_URL}${input.url}`)
    : undefined

  return [
    { title },
    { name: 'description', content: description },
    { property: 'og:title', content: title },
    { property: 'og:description', content: description },
    { name: 'twitter:title', content: title },
    { name: 'twitter:description', content: description },
    ...(image
      ? [
          { property: 'og:image', content: image },
          { name: 'twitter:image', content: image },
        ]
      : []),
    ...(url ? [{ property: 'og:url', content: url }] : []),
  ]
}
