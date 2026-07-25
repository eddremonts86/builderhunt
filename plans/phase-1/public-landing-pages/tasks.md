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

- [ ] **Add /pricing, /blog, and blog posts to the sitemap**
  - Files: `src/routes/sitemap[.]xml.ts`
  - Do: In the GET handler's `entries` array (lines 79-89) add
    `{ loc: `${SITE}/pricing`, changefreq: 'weekly', priority: 0.8 }` and
    `{ loc: `${SITE}/blog`, changefreq: 'weekly', priority: 0.8 }`. Then
    `const posts = await getAllPosts()` (from `~/shared/lib/blog`) and push
    `{ loc: `${SITE}/blog/${p.slug}`, lastmod: p.date, changefreq: 'monthly', priority: 0.7 }`
    per post.
  - Verify: `curl localhost:3000/sitemap.xml` contains `/pricing`, `/blog`, and one `<url>`
    per file in `content/posts/`; XML still validates (open in a browser, no parse error).

- [ ] **Blog OG images**
  - Files: `src/routes/api/og/blog.tsx` (new), `src/routes/_landing/blog/$slug.tsx`,
    `src/routes/_landing/blog/index.tsx`
  - Do: New OG route modeled on `api/og/explore.tsx` (same SVG→PNG resvg pipeline): input
    `?slug=…`, look up the post via `getPostBySlug`, render title (wrapped, max 3 lines),
    date + author, BuilderHunt branding; 404 for unknown slug; `Cache-Control: public,
max-age=86400`. In `blog/$slug.tsx` `head:` add
    `{ property: 'og:image', content: `${SITE}/api/og/blog?slug=${post.slug}` }` and
    `{ name: 'twitter:card', content: 'summary_large_image' }`; give the blog index a static
    OG using the same endpoint style or the site default.
  - Verify: `curl -I "localhost:3000/api/og/blog?slug=why-i-built-builderhunt"` →
    `image/png` 200; view-source of a post page shows the `og:image` tag; X card validator
    renders the image on prod.

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
