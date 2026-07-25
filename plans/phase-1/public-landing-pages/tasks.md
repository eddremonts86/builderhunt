# Tasks: Public Landing Pages (SEO)

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: [`waitlist-launch`](../waitlist-launch/spec.md), [`content-marketing`](../content-marketing/spec.md)
> **Reality check**: Core SEO surface delivered (checked below). Remaining: sitemap
> additions, blog OG images, and the public-radars feature.

## Phase 0 — Delivered (audited against src, 2026-07-19)

- [x] **Landing page redesign** — `src/modules/landing/components/HomePage.tsx`,
      `FAQSection.tsx`, `src/shared/components/Header.tsx`, `Footer.tsx`
- [x] **SSR /explore with per-query meta + ItemList JSON-LD** —
      `src/routes/_landing/explore/index.tsx` (head at line 39, JSON-LD at line 119), backed by
      cached `searchBuilders` (`src/lib/search.ts`)
- [x] **PNG OG image endpoint (1200×630, resvg)** — `src/routes/api/og/explore.tsx`
- [x] **sitemap.xml route (static pages + popular explore queries, 1h cache)** —
      `src/routes/sitemap[.]xml.ts`
- [x] **robots.txt (public allow, private disallow, AI-bot allow, sitemap pointer)** —
      `src/routes/robots[.]txt.ts`
- [x] **Site-wide WebSite + Organization JSON-LD** — `src/routes/__root.tsx:75-94`
- [x] **BlogPosting JSON-LD on posts** — `src/routes/_landing/blog/$slug.tsx:42`

## Phase 1 — SEO fixes

- [x] **Add /pricing, /blog, and blog posts to the sitemap**
  - Files: `src/routes/sitemap[.]xml.ts`
  - Done: Added `/pricing` and `/blog` static entries, plus one `<url>` per post from
    `getAllPosts()` (`lastmod` = post date, `monthly`/0.7).
  - Verify: **live-verified** — `sitemap.xml` in the browser contains `/pricing`, `/blog`,
    and all 3 `content/posts/*.md` slugs; XML parses with no error banner.

- [x] **Blog OG images**
  - Files: `src/routes/api/og/blog.tsx` (new), `src/routes/_landing/blog/$slug.tsx`
  - Done: New OG route (SVG→PNG via `@resvg/resvg-js`, same pipeline as `api/og/explore.tsx`):
    `?slug=…` → `getPostBySlug`, greedy word-wrapped title (max 3 lines, ellipsis truncation
    only when words actually overflow), date + author, BuilderHunt branding; unknown slug →
    404 JSON; `Cache-Control: public, max-age=86400`. `blog/$slug.tsx` now sets
    `og:image`/`twitter:image` to `/api/og/blog?slug=…`. Blog index needed no change — it
    already inherits the root's default `og:image`/`twitter:card` via TanStack Router's head
    merge (verified by reading `__root.tsx`, which sets both site-wide).
  - Verify: **live-verified** — `curl`'d the endpoint for all 3 real posts: correct PNG
    (`image/png`, 200) for each, unknown slug → 404 JSON; one-line title renders with no
    stray ellipsis (caught and fixed a real bug where the wrap function appended "…" even
    when the title fit on one line); 3-line wrap confirmed clean with no clipping on the
    longest real title. `view-source`-equivalent (`javascript_tool` reading
    `document.querySelector`) on `/blog/why-i-built-builderhunt` confirms the real `og:image`
    and `twitter:card`/`twitter:image` tags are present with the correct URL.

## Phase 2 — Public radars (post-launch)

- [ ] **Schema: `public_radars` table**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/` (generated migration)
  - Do: `publicRadars` pgTable: `savedQueryId` text PK referencing `saved_queries.id` ON
    DELETE CASCADE, `slug` text unique NOT NULL, `createdAt` timestamptz default now. Slug =
    kebab-case of query name + 6-char random suffix (reuse `randomId()` from `src/lib/utils.ts`
    truncated).
  - Verify: `pnpm db:generate && pnpm db:migrate` applies cleanly; `\d public_radars` shows
    the FK cascade.

- [ ] **Share/unshare API on saved queries**
  - Files: `src/routes/api/queries/$id/share.ts` (new), `src/shared/lib/db/schema.ts` (read)
  - Do: POST (auth required, must own the saved query) → upsert `public_radars` row, return
    `{ slug, url: `/r/${slug}` }`. DELETE → remove the row. Zod-validate params; 404 if not
    owner.
  - Verify: `curl -X POST /api/queries/<id>/share` as owner returns slug; as another user
    returns 404; DELETE then GET `/r/$slug` → 404.

- [ ] **Public radar page `/r/$slug` (SSR)**
  - Files: `src/routes/r/$slug.tsx` (new)
  - Do: Loader: resolve slug → saved query + owner display name; run `searchBuilders` with the
    query's keywords/sources (same cache as explore); return ONLY `{ ownerName, queryName,
results }` — never notes/alerts/tracked state. Render explore-style cards, "radar by
    {ownerName}" header, sign-up CTA, `ItemList` JSON-LD, `og:image` via a `?slug=` variant
    added to `api/og/explore.tsx`. 404 when no `public_radars` row.
  - Verify: Share a search, open `/r/$slug` logged-out — renders cards and meta; toggling
    private 404s; view-source contains no note/alert data.

- [ ] **Sitemap + share UI polish**
  - Files: `src/routes/sitemap[.]xml.ts`, `src/routes/_dashboard/dashboard/index.tsx` (or the
    saved-search list component under `src/modules/dashboard/`)
  - Do: Append all `public_radars` slugs to the sitemap; add a "Share publicly" toggle with
    copy-link on each saved search row calling the share API.
  - Verify: Shared radar appears in `/sitemap.xml`; toggle round-trips (share → link works →
    unshare → 404).
