# Feature: Public Landing Pages (SEO)

## Problem

BuilderHunt hoy es una SPA. La página de búsqueda requiere JavaScript y auth para mostrar valor. Google indexa 0 páginas. Resultado:

1. **No SEO traffic** — los devs no nos encuentran buscando "react developers" en Google
2. **No social sharing** — compartir un link no muestra preview porque no hay OG tags
3. **No backlinks** — sin contenido público, nada que enlazar
4. **No shareable radar pages** — un user con saved searches no puede compartir "mi radar de Rust async"

## Goal

Páginas públicas estáticas (SSR) para queries populares + cada saved search pública. Cada una:

- **SSR'd** (server-side render) para que Google las indexe
- **Has unique meta tags** (title, description, OG image)
- **Shows 10-20 builder cards** (real data, not mock)
- **CTA to sign up** to save the search
- **Schema.org structured data** for rich results

## Non-goals

- **No es una página por cada builder.** Eso es `/builders/:id` (ya existe).
- **No es un blog.** Eso es `content-marketing` (otro plan).
- **No es un marketplace indexable.** No exponemos saved searches privadas.
- **No es un A/B testing framework.** v1: same page for everyone.

## User stories

1. **Como Google bot**, quiero indexar 1000+ páginas: "react developers", "rust async developers", "AI engineers", etc.
2. **Como dev que busca en Google**, quiero ver una landing page relevante con builders reales
3. **Como founder**, quiero compartir mi radar en Twitter y que se vea un preview bonito
4. **Como user con saved search**, quiero una URL pública de mi radar para compartir con mi equipo
5. **Como visitante anónimo**, quiero ver "esta es la app, aquí está lo que hace" sin tener que registrarme

## URL design

```
/explore/rust-async-runtime     → SSR page for "rust async runtime" search
/explore/ai-engineers           → SSR page for "ai engineers"
/r/[userId]/[searchSlug]        → Public radar (user's saved search)
/developers/react               → SSR page for "react" (broader)
/topics/typescript              → SSR page for "typescript" tag
```

**Or, simpler v1**: just `/explore/[slug]` and `/r/[id]`

## UX layout

```
┌──────────────────────────────────────────────────────┐
│  BuilderHunt                                          │
│  Find active developers across 12 sources.            │
│  [ Try a search → ]  [ Sign up free → ]              │
├──────────────────────────────────────────────────────┤
│  Rust async runtime developers                        │
│  Last updated: 2 hours ago · 47 builders              │
│  Sources: GitHub, HN, Reddit, DEV.to, SO, npm, HF     │
├──────────────────────────────────────────────────────┤
│  [Card] [Card] [Card] [Card]                         │
│  [Card] [Card] [Card] [Card]                         │
│  [Card] [Card] [Card] [Card]                         │
│  [Card] [Card] [Card] [Card]                         │
│  [Card] [Card] [Card] [Card]                         │
│                                                       │
│  [See all 47 →]                                      │
│                                                       │
│  ┌─────────────────────────────────────────────┐    │
│  │  Save this radar to get daily updates.      │    │
│  │  [ Sign up free ]                            │    │
│  └─────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

## Pages

### 1. `/explore/[slug]` — discovery page

**Slug format**: `kebab-case(query + sources)`
- `/explore/rust-async-runtime` — query="rust async runtime", sources=all
- `/explore/react-github` — query="react", sources=github

**Or simpler**: just `/explore?q=...&sources=...` (query string, server-rendered)

**Server logic**:
- Parse query from URL
- Run `searchBuilders` (cached for 6h)
- Render top 20 builders
- Render full page (SSR)

**Meta**:
- Title: "47 React developers — BuilderHunt"
- Description: "Top 47 active React developers across GitHub, HN, Reddit, DEV.to. Updated daily. Save searches to get alerts."
- OG image: dynamically generated, shows top 3 builder avatars + query
- OG title: same as title
- Schema.org: `ItemList` with `ListItem` per builder

**Frequency**: re-render every 6h via cron (so Google sees fresh data on each crawl)

### 2. `/r/[id]` — public radar

For each saved search that the user has marked public (or all by default v1):
- Title: `{user.name}'s radar: {search.name}`
- Description: same
- Renders the same way as `/explore` but with the user's branding
- "Saved by {N} people" social proof

### 3. `/topics/[topic]` — topic hub

For each top-100 popular topic (rust, typescript, kubernetes, etc.):
- Landing page with all builders in that topic
- Generated from `builders.topics` aggregate
- "Builders who work with rust" semantic

**v1 skip** — this is a big project on its own. Start with `/explore` only.

## SEO requirements

### Sitemap

`/sitemap.xml`: lists all public pages
- Static pages (`/`, `/pricing`, `/about`)
- All `/explore` pages (pre-computed list of top 100 queries)
- All `/r/:id` pages for public radars

**Cron**: regenerate daily

### Robots

`/robots.txt`:
- Allow all on `/`, `/explore/*`, `/r/*`
- Disallow on `/dashboard`, `/settings`, `/me`, `/api/*`
- Sitemap: `https://builderhunt.dev/sitemap.xml`

### Meta tags per page

- `<title>{title}</title>`
- `<meta name="description" content="{description}">`
- `<meta property="og:title" content="{title}">`
- `<meta property="og:description" content="{description}">`
- `<meta property="og:image" content="{ogImageUrl}">`
- `<meta property="og:type" content="website">`
- `<meta name="twitter:card" content="summary_large_image">`
- `<link rel="canonical" href="{canonicalUrl}">`

### OG image generation

For each public page, generate a 1200×630 PNG:
- Background: dark theme
- Big query text (e.g., "Rust async runtime")
- Top 3 builder avatars
- BuilderHunt logo

**Tools**: `@vercel/og` (works without Vercel) or `satori` + `resvg`

**Files**:
- `src/routes/api/og/[type].ts`: dynamic OG image
- Cached for 24h

### Structured data (JSON-LD)

```json
{
  "@context": "https://schema.org",
  "@type": "ItemList",
  "name": "Rust async runtime developers",
  "numberOfItems": 47,
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "url": "https://builderhunt.dev/builders/123", "name": "Shepmaster" }
  ]
}
```

## Server-side rendering (SSR)

TanStack Start supports SSR. For public pages, we want them SSR'd by default (no client-side JS needed for the initial render).

**File**: `src/routes/explore/index.tsx` (new)

```tsx
export const Route = createFileRoute('/explore/')({
  component: ExplorePage,
  loader: async ({ search }) => {
    const q = search.q || ''
    const results = await searchBuilders({ keywords: [q], sources: search.sources?.split(',') })
    return { results, query: q }
  },
})
```

The `loader` runs on the server for SSR.

## Performance

- LCP < 1.5s
- TTFB < 300ms
- Each `/explore` page is cached 6h in Redis (per query)
- CDN cache for HTML (1h) with revalidation

## Data model

**New table: `public_radars`** (track which saved searches are public)

```sql
CREATE TABLE public_radars (
  saved_query_id text PRIMARY KEY REFERENCES saved_queries(id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE,
  created_at timestamp with time zone DEFAULT now()
);
```

Default: all saved searches are private. Users can opt-in to public via "Share this radar" button (already exists in Dashboard, but make it public).

## Out of scope (v1)

- Per-builder public pages (already exists as `/builders/:id`, but not SEO-optimized)
- Per-tag pages (`/topics/typescript`)
- Per-user profile pages
- Blog
- Backlinks / directory submissions
- Paid backlinks / HARO

## Open questions

- **How many landing pages to create?** Start with top 100 queries. Add more based on search analytics.
- **Public radars default opt-in or opt-out?** Opt-in for v1 (privacy). Add "Make this radar public" button.
- **OG image generation cost**: 1 image per cached page. 100 pages × 1 image = 100. Negligible.
- **CDN cache for HTML**: balance freshness vs perf. 1h is good.

## Dependencies

- New package: `@vercel/og` or `satori` + `resvg`
- New table: `public_radars`
- Schema migration: 1 new table
- No new env vars (uses APP_URL)

## Estimated effort

| Phase | Effort |
|-------|--------|
| 1 — `/explore` page with SSR | M (4-6h) |
| 2 — Meta tags + canonical | S (2-3h) |
| 3 — Sitemap + robots | S (2-3h) |
| 4 — OG image generation | M (4-6h) |
| 5 — Public radars | M (3-4h) |
| 6 — Schema.org structured data | S (2-3h) |
| **Total** | **~3-4 days** |
