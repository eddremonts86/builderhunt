/**
 * The public surfaces whose search-engine indexing a platform admin can toggle
 * at runtime, from `/admin/content`, without a deploy.
 *
 * Pure and client-safe: the admin UI, the API validator, the public route heads,
 * `robots.txt` and `sitemap.xml` all read this one registry, so a surface cannot
 * be hidden in one of those places and exposed in another.
 *
 * Adding a surface = one entry here plus one row (the sync in
 * `scripts/db/sync-platform-content.ts` does not own this table; a row appears
 * on first write, and until then `DEFAULT_DIRECTIVES` applies).
 */

export const SEO_SURFACES = ['blog', 'changelog', 'roadmap'] as const
export type SeoSurface = (typeof SEO_SURFACES)[number]

export interface RobotsDirectives {
  noindex: boolean
  nofollow: boolean
}

export interface SeoSurfaceDefinition {
  surface: SeoSurface
  /** Shown in the admin panel. */
  label: string
  /** The public paths this surface governs, for robots.txt and for operator clarity. */
  paths: readonly string[]
  /** One line explaining what flipping it affects, shown in the admin panel. */
  scope: string
}

export const SEO_SURFACE_DEFINITIONS: Record<SeoSurface, SeoSurfaceDefinition> = {
  blog: {
    surface: 'blog',
    label: 'Blog',
    paths: ['/blog'],
    scope: 'The blog index, every post page, and the Atom feed.',
  },
  changelog: {
    surface: 'changelog',
    label: 'Changelog',
    paths: ['/changelog'],
    scope: 'The changelog index and every entry page.',
  },
  roadmap: {
    surface: 'roadmap',
    label: 'Roadmap',
    paths: ['/roadmap'],
    scope: 'The public roadmap board.',
  },
}

/**
 * What applies when the surface has no row yet, or when the lookup fails.
 *
 * Fails CLOSED — hidden. A database blip must not be the reason a page we chose
 * to keep out of the index gets crawled, and an un-indexed page is recoverable
 * while an indexed one takes weeks to walk back.
 */
export const DEFAULT_DIRECTIVES: RobotsDirectives = { noindex: true, nofollow: true }

export function isSeoSurface(value: unknown): value is SeoSurface {
  return typeof value === 'string' && (SEO_SURFACES as readonly string[]).includes(value)
}

/**
 * The `content` value for `<meta name="robots">`.
 *
 * Returns `null` when nothing needs saying — the absence of a robots meta tag is
 * the same instruction as `index, follow`, and emitting the positive form adds
 * bytes to every page for no behavioural difference.
 */
export function robotsMetaContent(directives: RobotsDirectives): string | null {
  const tokens: string[] = []
  if (directives.noindex) tokens.push('noindex')
  if (directives.nofollow) tokens.push('nofollow')
  return tokens.length > 0 ? tokens.join(', ') : null
}

/**
 * `<meta>` descriptors for a TanStack Router `head()`, or nothing.
 *
 * Emits BOTH `robots` and `googlebot`. `__root.tsx` sets a page-wide
 * `googlebot: index, follow` alongside its generic `robots` directive, and
 * Google honours its own named tag over the generic one — so overriding only
 * `robots` would leave the exact crawler we care about most still indexing the
 * page. TanStack dedupes head meta by `name` with the deepest route winning,
 * which is what makes overriding the root's values here work at all.
 *
 * Returns nothing when neither directive is set, so an indexable surface keeps
 * the root's richer `max-image-preview` / `max-snippet` values instead of having
 * them flattened to a bare `index, follow`.
 */
export function robotsMetaTag(directives: RobotsDirectives): Array<{ name: string; content: string }> {
  const content = robotsMetaContent(directives)
  if (!content) return []
  return [
    { name: 'robots', content },
    { name: 'googlebot', content },
  ]
}

/** True when the surface should be kept out of sitemap.xml entirely. */
export function isHiddenFromSitemap(directives: RobotsDirectives): boolean {
  // Only `noindex` governs sitemap membership: a `nofollow`-but-indexable page
  // is still a page we want crawled and listed.
  return directives.noindex
}
