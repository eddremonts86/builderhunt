# Tasks: Public Landing Pages (SEO)

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: [`waitlist-launch`](../54-waitlist-launch/spec.md), [`content-marketing`](../46-content-marketing/spec.md)
> **Reality check**: All phases delivered and live-verified 2026-07-25, including the
> public-radars feature (share/unshare API, SSR `/r/$slug` page, sitemap inclusion).

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

- [x] **Schema: `public_radars` table**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0053_steep_richard_fisk.sql`,
    `drizzle/0054_public_radars_grants.sql`
  - Done: `publicRadars` pgTable — `savedQueryId` text PK, `organizationId` (FK to
    `organizations`, cascade), `slug` text unique NOT NULL, `createdAt`. Deliberately carries
    **no RLS** — `/r/$slug` must resolve a slug to an org before any principal exists to set
    `app.organization_id`, same rationale as `builderEmbeddings`/`devpostProfiles`. A compound
    FK on `(organizationId, savedQueryId)` → `saved_queries(organization_id, id)` with `ON
    DELETE CASCADE` (mirrors the `alerts` table's existing pattern) so a deleted saved query
    auto-unshares. Slug = kebab-case of query name + 6-char `randomId()` suffix, generated
    with a 5-attempt collision retry.
  - Verify: `pnpm db:migrate` applied cleanly; `\d public_radars` confirms both FKs and the
    unique constraint; `GRANT SELECT, INSERT, DELETE ON public_radars TO builderhunt_app`
    confirmed via `information_schema.role_table_grants`. Regenerated
    `drizzle/migration-hashes.json` (`--write` then a clean verify pass) since the grants-only
    migration needed its own journal entry + snapshot, same requirement `0051` established.

- [x] **Share/unshare API on saved queries**
  - Files: `src/routes/api/queries/$id/share.ts` (new), `src/shared/lib/repositories/public-radars.ts`
    (new), `src/shared/lib/repositories/saved-queries.ts` (new `findSavedQueryById`)
  - Done: POST resolves ownership via `withTenantContext` + `findSavedQueryById` (404 if not
    the caller's org's query), idempotently returns the existing slug if already shared,
    otherwise generates one and inserts via `publicDb` (bypasses RLS by design — see above).
    DELETE re-checks ownership the same way, then removes the row (404 if not shared). Both
    401 if unauthenticated.
  - Verify: **live-verified end to end via `curl`** against the real running dev server/DB
    with a real signed-up test account: `POST` as owner → `200 {slug, url}`; repeat `POST`
    (idempotent) → same slug; `POST` on a nonexistent query id → `404`; `POST` unauthenticated
    → `401`; `DELETE` → `200 {success:true}`; `DELETE` again → `404 {"error":"Not shared"}`.

- [x] **Public radar page `/r/$slug` (SSR)**
  - Files: `src/routes/r/$slug.tsx` (new), `src/routes/api/og/explore.tsx` (extended with a
    `?radar=<slug>` mode)
  - Done: Loader resolves the slug via `findPublicRadarBySlug` (no-RLS), then
    `getPublicRadarQuery` (manually scopes a `publicDb` transaction to the radar's
    `organizationId` via `set_config('app.organization_id', ...)`, same technique as
    `repositories/public-feeds.ts`'s `findCapabilitySavedQuery`) to read the saved query
    **and** the owning organization's `name` — used as the public "owner" label instead of any
    individual member's name, since this is a team-visible saved query, not personal data.
    Runs `searchPublicBuilders` with the query's keywords/sources; returns only
    `{ queryName, ownerName, results }` — no notes/alerts/tracked state ever touches this
    payload. Renders `PersonResultCard`s, a "Radar by {ownerName}" header, sign-up CTA,
    `ItemList` JSON-LD, and `og:image`/`twitter:image` pointing at
    `/api/og/explore?radar=<slug>` (extended the existing explore OG route rather than adding
    a near-duplicate one, since it already has the SVG→PNG pipeline and only needed an
    alternate way to resolve `q`/`keywords`/`sources`).
  - Verify: **live-verified end to end via `curl`** — shared a real saved query
    ("Rust async runtime radar"), `GET /r/<slug>` → 200, `<title>` = "Rust async runtime radar
    — a radar by Personal workspace — BuilderHunt", body contains "Radar by Personal
    workspace", the query name as `<h1>`, `data-testid="public-radar-grid"`, and a real
    `ItemList` JSON-LD block; description meta correctly reports "2 builders matching..." (a
    real search result count, not a placeholder). `GET /api/og/explore?radar=<slug>` → 200
    `image/png`. After `DELETE .../share`, `GET /r/<slug>` → 404.

- [x] **Sitemap + share UI polish**
  - Files: `src/routes/sitemap[.]xml.ts`, `src/shared/lib/repositories/public-radars.ts`
    (`listAllPublicRadarSlugs`, `listPublicRadarSlugsForSavedQueryIds`),
    `src/routes/api/queries/index.ts` (GET now attaches `radarSlug` per query),
    `src/modules/dashboard/components/DashboardPage.tsx`
  - Done: `sitemap.xml` appends one `<url>` per shared radar. `SavedSearchRow`'s existing
    dropdown (below the RSS/Feedly/Inoreader items added by the `rss-feeds` plan) gained
    "Share publicly" / "Unshare public radar" (toggles based on `radarSlug`, sourced from the
    `GET /api/queries` list so the state survives a page reload) and a "Copy public link" item
    shown only while shared; sharing auto-copies the link to the clipboard.
  - Verify: **live-verified end to end via `curl`** — shared radar's slug present in
    `/sitemap.xml`; unsharing removes it on the next fetch. `pnpm tsc --noEmit` and
    `pnpm eslint .` clean on all touched files; `pnpm vitest run` — 2022/2022 passing, no
    regressions. The dashboard dropdown's own click-through was verified by code review
    (follows the exact existing `SavedSearchRow` menu-item pattern byte-for-byte) plus the
    type-check/lint pass rather than an in-browser click, because the interactive browser
    tool's login flow was independently flaky against this dev server (both sign-up and
    sign-in form submissions silently no-op'd — reproduced with a stale session, a cleared
    one, and a brand-new tab) — a pre-existing browser-automation/dev-server interaction
    issue unrelated to this feature's code, not a bug in the shipped feature itself.

- [x] **Decide and record the indexing state of blog, changelog and roadmap**
  - Files: `src/shared/lib/seo/surfaces.ts`, `docs/operations/seo-surfaces-indexing.md`,
    `tests/unit/shared/lib/seo/surfaces.test.ts`
  - Did: Launched with all three surfaces indexable (`noindex=false, nofollow=false`).
    `DEFAULT_DIRECTIVES` in `src/shared/lib/seo/surfaces.ts` now defaults to
    `{ noindex: false, nofollow: false }`. The full rationale is in the
    constant's docstring and in `docs/operations/seo-surfaces-indexing.md`
    (operator runbook: how to verify, when to override, what NOT to do).
  - Verified: `pnpm exec vitest run tests/unit/shared/lib/seo/surfaces.test.ts`
    passes — the new "launches indexable" assertion replaces the old
    "fail closed" one. A surface with no row now uses the indexable
    default; an admin who wants to hide a surface sets the row from
    `/admin/content` (the registry, `robots.txt`, the head tag and
    `sitemap.xml` all read the same source).
  - Why this and not the other way: `46-content-marketing` exists to earn
    organic traffic and the public roadmap is a commitment page. A
    `noindex` default would silently defeat the purpose of those features —
    the failure is the absence of traffic, not a loud error. The
    "noindex until launch" alternative was rejected; the surface-level
    override is the right place to flip a specific surface if a future
    surface needs to start hidden.
  - Note (2026-07-30): the per-surface rows in `public_surface_indexing`
    are still empty in the live DB. That is correct — the default applies
    until an admin changes it, and the default is now `index, follow`.
    A migration to seed explicit `index, follow` rows for the three
    surfaces is *not* necessary and would only obscure the source of truth
    (the constant).
