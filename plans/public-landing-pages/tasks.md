# Tasks: Public Landing Pages (SEO)

## Phase 0 — Research

- [ ] Check TanStack Start SSR support for the routes we'll add
- [ ] Pick OG image library: `@vercel/og` (simpler) vs `satori` + `resvg` (more flexible)
- [ ] Read existing `/routes/_landing` for inspiration
- [ ] Read `src/lib/search.ts` to understand caching for SSR

## Phase 1 — `/explore` route

File: `src/routes/explore/index.tsx` (new, SSR)

- [ ] Accept `?q=...&sources=...` query string
- [ ] Server-side `loader`: parse params, call `searchBuilders`, return results
- [ ] Render top 20 builder cards
- [ ] Add "Save this radar" CTA at the bottom
- [ ] Cache results in Redis 6h, keyed by `(q, sources)`
- [ ] Add server-side meta tags (title, description, OG)
- [ ] Add JSON-LD structured data

## Phase 2 — Discover popular queries

File: `scripts/seed-explore-pages.ts`

- [ ] Static list of top 50-100 queries (rust async, indie hackers, AI engineers, etc.)
- [ ] For each, create an `/explore?q=...` entry in a generated sitemap
- [ ] Track which queries are most-visited → promote to "popular searches" on landing page

## Phase 3 — Sitemap & robots

File: `src/routes/sitemap[.]xml.ts`

- [ ] Generate `sitemap.xml` server-side
- [ ] Include: home, pricing, about, all `/explore` pages, all public radars
- [ ] Last-modified timestamp per page
- [ ] Cached 24h

File: `src/routes/robots[.]txt.ts`

- [ ] Allow: `/`, `/explore/*`, `/r/*`
- [ ] Disallow: `/dashboard`, `/settings`, `/me`, `/api/*`
- [ ] Sitemap URL: `https://builderhunt.dev/sitemap.xml`

## Phase 4 — OG image generation

File: `src/routes/api/og/explore.tsx` (new)

- [ ] Use `@vercel/og` to render JSX → PNG
- [ ] 1200×630 dimensions
- [ ] Input: query, top 3 builder usernames + avatars, "BuilderHunt" branding
- [ ] Output: PNG
- [ ] Cache in Redis 24h
- [ ] Content-Type: image/png

File: `src/routes/api/og/radar.tsx` (new)

- [ ] Same as explore but for public radars
- [ ] Include user name + search name

## Phase 5 — Public radars

File: `src/routes/r/$radarId.tsx` (new, SSR)

- [ ] Fetch public radar by id
- [ ] Render same as `/explore` but with "by {userName}" branding
- [ ] "Subscribe to this radar" CTA (RSS)
- [ ] "Save a similar radar" CTA (requires sign-in)
- [ ] 404 if radar is private

Data model:
- [ ] Add `public_radars` table to schema
- [ ] Generate + apply migration
- [ ] `POST /api/queries/:id/share` makes a radar public, returns `/r/{id}` URL

## Phase 6 — SEO polish

- [ ] Add `lang="en"` to `<html>` (or auto-detect)
- [ ] Add `<link rel="alternate" hreflang="..." />` (skip, English only v1)
- [ ] Add `<meta name="robots" content="index, follow, max-image-preview:large">`
- [ ] Add `JSON-LD` structured data to all public pages:
  - Home: `Organization` + `WebSite`
  - Pricing: `Product` with offers
  - Explore: `ItemList` with `ListItem` per builder
  - Radar: `ProfilePage` + `ItemList`
- [ ] Test with Google Rich Results tool: `https://search.google.com/test/rich-results`

## Phase 7 — Performance

- [ ] Lighthouse: home, pricing, explore pages all > 90
- [ ] LCP < 1.5s, FID < 100ms, CLS < 0.1
- [ ] Cache HTML in Cloudflare 1h with revalidation
- [ ] Test with slow 3G: explore page still loads < 3s

## Phase 8 — Verification

### Manual
- [ ] Visit `/explore?q=react` → 20 builder cards, meta tags present
- [ ] View source: see SSR'd HTML (not just an empty `<div id="root">`)
- [ ] OG image: visit `/api/og/explore?q=react` → PNG renders correctly
- [ ] Sitemap: `/sitemap.xml` lists all expected pages
- [ ] Robots: `/robots.txt` correct
- [ ] Google Search Console: submit sitemap, see pages indexed within 1 week

### Automated
- [ ] Playwright: visit `/explore?q=react`, count cards (should be > 0)
- [ ] Test OG image: GET, check Content-Type is `image/png`
- [ ] Sitemap validation: parse XML, count URLs, verify structure

### SEO
- [ ] Mobile-friendly test: all pages pass
- [ ] Core Web Vitals: all green
- [ ] Submit to Google Search Console
- [ ] Submit to Bing Webmaster Tools
- [ ] Backlink strategy: list 30 directories to submit to (BetaList, ProductHunt, etc.)

## Phase 9 — Rollout

- [ ] Deploy with `ENABLE_PUBLIC_PAGES=true`
- [ ] Submit sitemap to Google Search Console
- [ ] Monitor: impressions, clicks, position in GSC
- [ ] Iterate on top queries based on actual search traffic

## Edge cases

- **Query with no results**: render "No builders found" + suggest similar queries
- **Query with profanity**: filter out (e.g., drop and show 0 results)
- **OG image with broken avatar URL**: skip avatar, show initials
- **Sitemap too large (>50k URLs)**: split into multiple sitemaps
- **CDN cache stale**: revalidate via Cloudflare API
- **User opts in to public radar but then changes mind**: add "Make private" button

## Dependencies

- New package: `@vercel/og` or `satori` + `resvg`
- New table: `public_radars`
- Schema migration: 1 new table
- New env vars: none
- New services: Google Search Console, Bing Webmaster

## Estimated effort: 3-4 days
