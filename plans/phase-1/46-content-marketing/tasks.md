# Tasks: Content Marketing

> **Status**: `implemented` — the blog engine, nine posts and four further drafts are delivered; publishing
> and distribution moved to [`plans/phase-5/03-launch-and-distribution`](../../phase-5/03-launch-and-distribution/tasks.md)
> **Depends on**: [`public-landing-pages`](../45-public-landing-pages/spec.md)
> **Blocks**: [`waitlist-launch`](../54-waitlist-launch/spec.md)
> **Reality check**: Blog engine + 5 posts + authoring template delivered (2026-07-26). Phase 2
> (cross-posting to dev.to/Hashnode/X/LinkedIn) and Phase 3 (ongoing 2-posts/month cadence) are
> manual, recurring, external-platform work — not one-shot coding tasks — same category as
> `waitlist-launch`'s founder GTM runbook. Left unchecked below for the user to run personally;
> not part of an autonomous coding session's scope.
>
> **Phase-1 scope closed 2026-08-05.** Every remaining item moved to `plans/phase-5/` on Edd's instruction — the product launches when phase-5 finishes, so a task that waits on a signature, a clock, a live deployment or a launch is not build-phase work. Prose pointers below name the phase-5 plan that owns each one; they are deliberately not checkboxes, because a box reads as pending engineering.

## Phase 0 — Delivered (audited against src, 2026-07-19)

- [x] **Content directory with frontmatter posts** — `content/posts/` (title, description,
      slug, date, tags, author)
- [x] **Blog loader lib + tests** — `src/shared/lib/blog.ts` (`getAllPosts`, `getPostBySlug`,
      `getRelatedPosts`), `tests/unit/shared/lib/blog.test.ts`
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

**Moved to [`plans/phase-5/03-launch-and-distribution`](../../phase-5/03-launch-and-distribution/tasks.md) on 2026-08-05, deliberately not as a
checkbox** — and **merged** there with plan 54's "dev.to cross-post + X thread + LinkedIn + one subreddit
+ Indie Hackers", because the two were the same task written twice: once as a launch action and once as a
per-post routine. Cross-posting before the product is live reads as spam on every channel it touches.

## Phase 3 — Steady state (2 posts/month; one task per brief from the spec table)

### "The solo founder's guide to technical sourcing"

**Written. Publication moved to [`plans/phase-5/03-launch-and-distribution`](../../phase-5/03-launch-and-distribution/tasks.md) on 2026-08-05.**
The draft is `content/posts/_draft-technical-sourcing-guide.md` (2026-08-04) — a tool-agnostic process
piece whose two BuilderHunt mentions are worked examples of a trade-off, both mapping to `src/lib/score.ts`
and `src/lib/dedup.ts`. Publishing is renaming off the `_` prefix after your edit; `blog.ts` filters
`_`-prefixed files and ignores a `draft:` frontmatter key entirely.

The writing was the engineering-adjacent half and it is done. What is left is the decision to publish,
which belongs to the launch.

### "What I learned indexing developer profiles"

**Written. Publication moved to [`plans/phase-5/03-launch-and-distribution`](../../phase-5/03-launch-and-distribution/tasks.md) on 2026-08-05.**
The draft is `content/posts/_draft-lessons-indexing-developers.md` (2026-08-04). Note the title: it does
**not** claim 10,000 profiles, because the corpus is nowhere near that and this brief's own rule was not to
invent scale metrics. Dedup and scoring trade-offs cite real decisions in `src/lib/dedup.ts` and
`src/lib/score.ts`.

### "Saved searches as a hiring radar: a setup tutorial"

**Written, screenshots taken. Publication moved to [`plans/phase-5/03-launch-and-distribution`](../../phase-5/03-launch-and-distribution/tasks.md)
on 2026-08-05.** The draft is `content/posts/_draft-saved-search-hiring-radar.md` (2026-08-05), with all
three screenshots embedded: `search-save-search.webp`, `alerts-new-radar.webp` and
`alerts-radar-with-matches.webp`, captured through `pnpm content:screenshots` against the local dev server
as the seeded admin. Their shot definitions are in `scripts/dev/capture-app-screenshots.ts`, so a redesign
refreshes them with every other blog image.

**Nothing in the third shot is seeded.** The radar was created through the real form (which needed a Pro
entitlement granted via the platform-admin endpoint — creation answers 402 on free) and its five matches are
rows the alerts worker produced by re-running the saved search against the live sources: two Lobsters, two
Hacker News, one dev.to. Hand-inserting `alert_triggers` to fill the frame would have been the fabricated
evidence `project-hygiene` spent a plan removing.

Every route, field label and dropdown option in the post is read out of `SearchPage.tsx` and `alerts.tsx`
rather than remembered — and writing it is what surfaced the radar dropdown labelling four *events the
product never detects*, fixed the same day. One thing to decide before publishing: the screenshots show
real people's public handles, the same standard as the existing search/explore images.

### "How the BuilderHunt activity score works"

**Written. Publication moved to [`plans/phase-5/03-launch-and-distribution`](../../phase-5/03-launch-and-distribution/tasks.md) on 2026-08-05.**
The draft is `content/posts/_draft-how-activity-score-works.md` (2026-08-04). Every scoring statement maps
to `src/lib/score.ts`, and the score is presented as a heuristic with named limitations, never as objective
ability.

### Monthly content review

**Moved to [`plans/phase-5/03-launch-and-distribution`](../../phase-5/03-launch-and-distribution/tasks.md) on 2026-08-05, deliberately not as a
checkbox** — it reads Search Console queries and impressions per post, which requires the sitemap submitted,
the posts indexed, and months of accumulated data. It is the last item of that plan for exactly that reason.

