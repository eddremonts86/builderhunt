# Public Landing Pages (SEO)

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: [`waitlist-launch`](../54-waitlist-launch/spec.md), [`content-marketing`](../46-content-marketing/spec.md)
> **Reality check**: The public SEO surface is largely live: redesigned landing
> (`src/routes/_landing/index.tsx` → `src/modules/landing/components/HomePage.tsx`), SSR
> `/explore` with meta + `ItemList` JSON-LD (`src/routes/_landing/explore/index.tsx`), PNG OG
> images (`src/routes/api/og/explore.tsx`, resvg), `sitemap.xml`/`robots.txt` routes, site-wide
> `WebSite`+`Organization` JSON-LD (`src/routes/__root.tsx:75-94`), `/pricing`, `/blog`.
> **Public radars are built** (`publicRadars` pgTable, `src/shared/lib/db/schema.ts:376`, per
> `tasks.md`'s "Schema: `public_radars` table" task — this line said "not built" long after it
> shipped; corrected 2026-07-31).

## Problem

Without indexable public pages Google sends zero traffic, shared links have no previews, and
there is nothing to backlink. Mostly solved; the remaining gaps are sitemap omissions, blog OG
images, and the still-unbuilt shareable public radar pages.

## Goal

Every public page indexable with correct meta/OG/structured data, a complete sitemap, and
(phase 2) opt-in public radar pages (`/r/$slug`) so users can share a saved search.

## Non-goals

- No per-topic hub pages (`/topics/*`) — revisit only if Search Console shows demand.
- No per-builder SEO pages beyond the existing `/builders/$builderId`.
- No blog content production (that is [`content-marketing`](../46-content-marketing/spec.md));
  this plan owns the blog's _SEO plumbing_ (OG endpoint, sitemap entries).
- No CDN/Cloudflare HTML caching layer for v1 (single VPS + Redis cache is enough).

## Delivered (audited 2026-07-19)

- **Landing redesign** — `src/modules/landing/components/HomePage.tsx`, `FAQSection.tsx`,
  `BrandIcons.tsx`; shared `Header`/`Footer` (`src/shared/components/`); footer links every
  public page.
- **`/explore`** — `src/routes/_landing/explore/index.tsx`: SSR loader runs `searchBuilders`
  (Redis+memory cached, `src/lib/search.ts`), per-query `<title>`/description/OG meta
  (`head:` at line 39), `ItemList` JSON-LD (line 119), sign-up CTA.
- **OG images** — `src/routes/api/og/explore.tsx`: 1200×630 SVG rasterized to PNG via
  `@resvg/resvg-js` (raw SVG OG images silently fail on X/LinkedIn/Slack — solved).
- **`sitemap.xml`** — `src/routes/sitemap[.]xml.ts`: home, `/explore`, changelog, roadmap,
  status, legal pages + one entry per `POPULAR_QUERIES` explore query; 1h cache headers.
- **`robots.txt`** — `src/routes/robots[.]txt.ts`: allows public routes, disallows
  api/auth/dashboard/onboarding, explicitly allows AI crawlers (GPTBot, ClaudeBot,
  PerplexityBot), sitemap pointer.
- **Structured data** — site-wide `WebSite` + `Organization` JSON-LD in
  `src/routes/__root.tsx:75-94`; `BlogPosting` JSON-LD on posts
  (`src/routes/_landing/blog/$slug.tsx:42`).
- **`/pricing`, `/blog`, `/blog/$slug`, `/blog/atom.xml`** — live (see sibling plans).

## Remaining work (each gap cited)

1. **Sitemap omissions**: `src/routes/sitemap[.]xml.ts:79-89` lists home, explore, changelog,
   roadmap, status, legal — but **not `/pricing`, `/blog`, or the blog post URLs** (grep
   "blog" in that file → no matches), even though those pages exist and are the main SEO
   content.
2. **Blog posts have no OG image**: `src/routes/_landing/blog/$slug.tsx:13-25` sets
   `og:title/description/type/url` but no `og:image` (grep confirms), and the only OG
   generator is `api/og/explore.tsx`. Shared posts render without preview images.
3. **Public radars are built**: the `public_radars` table exists (`src/shared/lib/db/schema.ts:376`)
   per `tasks.md`. This line said "not built" long after that shipped; corrected 2026-07-31.

## Public radars design (phase 2)

- New table `public_radars` (`saved_query_id` PK → `saved_queries.id` cascade, `slug` unique,
  `created_at`). Opt-in via a "Share publicly" action on a saved search; deleting the saved
  query or toggling private removes the row (404 afterwards).
- Route `/r/$slug` (public, SSR): loads the saved query, runs the same cached
  `searchBuilders` as `/explore`, renders "{userName}'s radar: {queryName}" with the explore
  card layout, sign-up CTA, `ItemList` JSON-LD, OG image via a `radar` variant of the OG
  endpoint. Public radars are appended to the sitemap.
- Privacy: only the query text/filters and the owner's display name are public — never notes,
  alerts, or tracked-builder state (`builders` rows are per-user and stay private).

## Success metrics

- Search Console: sitemap accepted, blog + pricing pages indexed within 2 weeks of launch.
- OG previews render for `/`, `/pricing`, `/explore?q=*`, and every blog post.
- ≥1 public radar shared by a real user in the first month (validates phase 2).

## Resolved questions

- Explore URL shape: query-string (`/explore?q=…`) — shipped, keep; no slug pages.
- OG library: `@resvg/resvg-js` (already a dependency) — shipped.
- Radars default visibility: private; explicit opt-in.
