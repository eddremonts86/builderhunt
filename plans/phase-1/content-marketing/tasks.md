# Tasks: Content Marketing

> **Status**: `phase-1-implemented`
> **Depends on**: [`public-landing-pages`](../public-landing-pages/spec.md)
> **Blocks**: [`waitlist-launch`](../waitlist-launch/spec.md)
> **Reality check**: Blog engine + 5 posts + authoring template delivered (2026-07-26). Phase 2
> (cross-posting to dev.to/Hashnode/X/LinkedIn) and Phase 3 (ongoing 2-posts/month cadence) are
> manual, recurring, external-platform work — not one-shot coding tasks — same category as
> `waitlist-launch`'s founder GTM runbook. Left unchecked below for the user to run personally;
> not part of an autonomous coding session's scope.

## Phase 0 — Delivered (audited against src, 2026-07-19)

- [x] **Content directory with frontmatter posts** — `content/posts/` (title, description,
      slug, date, tags, author)
- [x] **Blog loader lib + tests** — `src/shared/lib/blog.ts` (`getAllPosts`, `getPostBySlug`,
      `getRelatedPosts`), `src/shared/lib/blog.test.ts`
- [x] **/blog list route (SSR)** — `src/routes/_landing/blog/index.tsx`
- [x] **/blog/$slug route (meta, BlogPosting JSON-LD, related posts)** —
      `src/routes/_landing/blog/$slug.tsx`
- [x] **Atom feed** — `src/routes/blog/atom[.]xml.ts`
- [x] **Post 1: founder story** — `content/posts/why-i-built-builderhunt.md`
- [x] **Post 2: 12-sources listicle** — `content/posts/12-sources-developer-search.md`
- [x] **Post 3: cold-email guide** — `content/posts/cold-emails-devs-reply.md`

## Phase 1 — Launch content

- [x] **Post template with valid frontmatter**
  - Files: `content/posts/_TEMPLATE.md` (new; underscore prefix so `getAllPosts` ignores it —
    check `src/shared/lib/blog.ts` filters non-`.md`/underscore files, add the filter if missing)
  - Do: Frontmatter skeleton (title, description, slug, date, tags, author: edd) + house-style
    section scaffold (hook, problem, 3 h2 sections, conclusion, CTA link to `/auth/sign-up`).
  - Verify: `pnpm test blog` still passes and `/blog` does NOT list the template.

- [x] **Write post 4: "How to find developers as a solo founder in 2026"**
  - Files: `content/posts/find-developers-solo-founder.md` (new)
  - Do: 1500-1800 words. Angle: channel-by-channel guide (GitHub, HN, Stack Overflow, npm,
    dev.to, Reddit) with pros/cons and a 3-step process; BuilderHunt introduced as the
    aggregator in the final section, linking `/explore?q=…` examples. Target keyword: "find
    developers solo founder". Tags: [sourcing, guide]. Description 140-160 chars.
  - Verify: Renders at `/blog/find-developers-solo-founder` with correct meta; internal links
    resolve; appears first on `/blog` (newest date).

- [x] **Write post 5: "How I built a 12-source developer search engine with TanStack Start"**
  - Files: `content/posts/building-12-source-search-tanstack-start.md` (new)
  - Do: 1800-2200 words, technical. Architecture walk-through matching reality: one module per
    source returning `RawBuilder` (`src/lib/sources/`), dedup (`src/lib/dedup.ts`), scoring
    (`src/lib/score.ts`), Redis+memory caching (`src/lib/search.ts`), SSR routes. 3-4 real
    (sanitized) code snippets. Target keyword: "federated search TanStack Start". CTA: try
    `/explore`. This is the Show HN companion link.
  - Verify: Renders correctly incl. code blocks; snippets compile against the cited files'
    actual signatures.

**Implementation evidence (2026-07-26):**
- `blog.ts`'s file filter was `f.endsWith('.md')` only — no underscore exclusion existed yet
  (the plan's own caveat "add the filter if missing" was live). Added it, and rewrote
  `blog.test.ts`: 3 of its 4 prior tests were tautological (`expect(post === null || typeof
  post === 'object')` is true for any value) or had `else { expect(true).toBe(true) }` escape
  hatches that would have fired silently on every run once the fixture's `_`-prefixed name
  stopped loading. New tests assert real frontmatter fields and explicitly assert the
  `_TEMPLATE.md`-shaped fixture never appears in `getAllPosts()`/`getPostBySlug()`.
- Live-verified both posts at `/blog` and their `/blog/$slug` routes via the dev server: correct
  order (newest date first), template invisible, internal links (`/explore?q=…`, cross-post
  link) resolve.
- **Real bug found while verifying post 5's code blocks**: `$slug.tsx` renders post HTML inside
  `className="prose prose-invert ..."`, but `@tailwindcss/typography` was never installed —
  those classes did nothing. Combined with Tailwind's preflight (which strips default
  browser heading emphasis), every heading and code block in every post rendered as
  visually-undifferentiated body text. This had been latent since the blog shipped; it only
  surfaced now because posts 1-3 have no headings/code that needed visual distinction to read
  correctly. Fixed by installing `@tailwindcss/typography` and registering it via
  `@plugin '@tailwindcss/typography';` in `globals.css` (Tailwind v4 CSS-first plugin syntax).
  Verified via computed style on the live page: `<pre>` now gets a monospace font, dark
  background, padding, and `overflow-x: auto`; `<h2>` now renders at 24px/700 instead of
  inheriting body size/weight.

## Phase 2 — Distribution routine (run per post, starting at launch)

- [ ] **Cross-post + distribute posts 1-5** (repeat for each future post)
  - Files: none (external platforms)
  - Do: dev.to and Hashnode: paste markdown, set `canonical_url` to the builderhunt.dev URL,
    same tags. X: 5-8 tweet thread summarizing the post. LinkedIn: 150-word excerpt + link.
    Add `?utm_source=devto|hashnode|x|linkedin` to links.
  - Verify: Both mirrors show `rel=canonical` to builderhunt.dev (view-source); UTM referrers
    appear in server logs after clicks.

## Phase 3 — Steady state (2 posts/month; one task per brief from the spec table)

- [ ] **Write "The solo founder's guide to technical sourcing"**
  - Files: `content/posts/technical-sourcing-guide.md`
  - Do: Target "technical sourcing guide" with a tool-agnostic process piece using the
    validated post template and only evidence-backed BuilderHunt examples.
  - Verify: Post builds, renders at its slug, and completes the Phase 2 distribution check.

- [ ] **Write "What I learned indexing 10,000 developer profiles"**
  - Files: `content/posts/lessons-indexing-10k-developers.md`
  - Do: Target "developer data aggregation" and explain dedup/scoring trade-offs by citing
    real decisions in `src/lib/dedup.ts` and `src/lib/score.ts`; do not invent scale metrics.
  - Verify: Post builds, every quantitative statement has evidence, and Phase 2 distribution completes.

- [ ] **Write "Saved searches as a hiring radar: a setup tutorial"**
  - Files: `content/posts/saved-search-hiring-radar.md`
  - Do: Target "developer hiring alerts" with current screenshots of search → save → alert;
    ensure every route and control label matches the running app.
  - Verify: Follow the published tutorial in a seeded account end to end, then complete Phase 2 distribution.

- [ ] **Write "How the BuilderHunt activity score works"**
  - Files: `content/posts/how-activity-score-works.md`, `src/lib/score.ts`
  - Do: Target "measure developer activity" and explain the current scoring heuristics,
    limitations, and source differences without presenting the score as objective ability.
  - Verify: A reviewer maps every scoring statement to `src/lib/score.ts`; post builds and completes Phase 2 distribution.
- [ ] **Monthly content review**
  - Files: none
  - Do: Check Search Console queries/impressions per post; double down on the best-performing
    topic in the next brief; kill formats that consistently take >6h to write.
  - Verify: A one-paragraph note per month appended to this plan's spec (or the repo journal)
    with the decision taken.
