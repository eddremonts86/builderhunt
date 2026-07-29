# Plan: Public Landing Pages (SEO)

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: [`waitlist-launch`](../54-waitlist-launch/spec.md), [`content-marketing`](../46-content-marketing/spec.md)
> **Reality check**: Explore/OG/sitemap/robots/JSON-LD/landing all live (see spec
> "Delivered"). Remaining: two small SEO fixes (launch-blocking) and the public-radars
> feature (post-launch).

## Phases

### Phase 0 — Delivered (2026-07)

Landing redesign, SSR `/explore` with meta + JSON-LD, PNG OG endpoint, sitemap, robots,
site-wide structured data. No re-work.

### Phase 1 — SEO fixes (launch-blocking, ~2h)

1. Add `/pricing`, `/blog`, and every published post to `sitemap.xml` (posts via
   `getAllPosts()` from `src/shared/lib/blog.ts`, using each post's date as lastmod).
2. Blog OG images: add a `title`-based OG endpoint variant and wire `og:image` +
   `twitter:card` into `blog/$slug.tsx` and the blog index.

### Phase 2 — Public radars (post-launch, ~1 day)

Schema (`public_radars`) → share/unshare API on saved queries → `/r/$slug` SSR route reusing
the explore rendering + OG → sitemap inclusion. Strictly opt-in; see spec privacy rules.

## Risks

| Risk                                             | Likelihood | Mitigation                                                                                                        |
| ------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| Sitemap grows stale vs published posts           | Low        | Entries generated from `getAllPosts()` at request time (route is dynamic, 1h cache)                               |
| Public radar leaks private data                  | Low        | Render only query text + owner name; explicit allowlist of fields in the loader; test asserts notes/alerts absent |
| `/r/$slug` hammers external sources via crawlers | Medium     | Same Redis cache as `/explore`; radars also inherit the existing rate limiting on search                          |

## Rollback

Phase 1 is additive meta/sitemap output — revert commit. Phase 2: dropping the `/r` route and
the `public_radars` table removes the feature cleanly (cascade delete, no other table
references it).
