# Content Marketing (Blog + Cross-Posting)

> **Status**: `partially-implemented`
> **Depends on**: [`public-landing-pages`](../44-public-landing-pages/spec.md) (blog SEO plumbing: OG endpoint + sitemap entries)
> **Blocks**: [`waitlist-launch`](../53-waitlist-launch/spec.md)
> **Reality check**: Blog infrastructure is live: file-based posts in `content/posts/`
> (3 published), loader `src/shared/lib/blog.ts` (+ `blog.test.ts`), public routes
> `src/routes/_landing/blog/{index,$slug}.tsx`, Atom feed `src/routes/blog/atom[.]xml.ts`.
> No authors pages, no subscriber list, no cross-post automation — and none are planned.

## Problem

Without content there is no SEO surface, no inbound discovery, and nothing to share at
launch. The blog _engine_ is built; what's missing is most of the content and a sustainable
publishing routine.

## Goal

A lean, realistic content pipeline: 5 published posts by launch (3 exist), then a steady
2 posts/month cadence, each manually cross-posted with canonical URLs. Content tasks are
writing tasks — concrete title, angle, and target keyword — not code.

## Non-goals

- **No cross-posting automation** (`scripts/blog/cross-post.ts` from the old plan is dropped —
  at 2 posts/month, pasting into dev.to with a `canonical_url` takes 5 minutes).
- **No email subscribers / `blog_subscribers` table** — the Atom feed is the subscription
  mechanism; revisit only with real demand.
- **No author pages** — single author; the byline in the post header is enough.
- **No CMS, no comments, no translations, no 1-post-per-week pace** (unsustainable solo).
- OG images and sitemap inclusion are owned by `public-landing-pages` Phase 1, not here.

## Delivered (audited 2026-07-19)

- **Content store**: `content/posts/*.md` with frontmatter (title, description, slug, date,
  tags, author). Published:
  1. `why-i-built-builderhunt.md` (founder story, 2026-07-15)
  2. `12-sources-developer-search.md` (listicle/SEO)
  3. `cold-emails-devs-reply.md` (value-first outreach guide)
- **Loader**: `src/shared/lib/blog.ts` — `getAllPosts` (sorted desc, frontmatter-parsed),
  `getPostBySlug`, `getRelatedPosts` (tag overlap); tests in `tests/unit/shared/lib/blog.test.ts`.
- **Routes**: `/blog` list + `/blog/$slug` (SSR, meta tags, `BlogPosting` JSON-LD at
  `$slug.tsx:42`, related posts), Atom feed at `/blog/atom.xml`.
- **Footer/blog discoverability**: footer links `/blog` (`src/shared/components/Footer.tsx:41`).

## Remaining work

1. **Two more posts to reach 5 by launch** (concrete briefs in tasks.md):
   - "How to find developers as a solo founder in 2026" — the highest-intent SEO keyword.
   - "How I built a 12-source developer search engine with TanStack Start" — technical/HN bait,
     doubles as the Show HN companion piece.
2. **Post-launch pipeline** (2/month, briefs below) — tracked as a rolling backlog, not 67
   micro-tasks: each post gets one task with title, angle, keyword, CTA.
3. **Manual distribution checklist** per post (dev.to + Hashnode with canonical URL, X thread,
   LinkedIn) — a repeatable routine, not code.

## Post structure (house style)

1000-2000 words; problem-first intro; 3-5 h2 sections; 1-2 screenshots or code blocks;
1-2 internal links to other posts or `/explore` queries; CTA to sign up; frontmatter complete
(title ≤60 chars, description 140-160 chars, 2-4 tags). First-person founder voice.

## Backlog briefs (post-launch, 2/month)

| Title (working)                                            | Angle                                                              | Target keyword                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------- |
| The solo founder's guide to technical sourcing             | Step-by-step process piece, tool-agnostic, BuilderHunt as one tool | "technical sourcing guide"      |
| What I learned indexing 10,000 developer profiles          | Lessons-learned/technical, dedup + scoring war stories             | "developer data aggregation"    |
| Saved searches as a hiring radar: a setup tutorial         | Product tutorial with screenshots, feeds `/explore` internal links | "developer hiring alerts"       |
| How the BuilderHunt activity score works                   | Transparency/technical, explains `src/lib/score.ts` heuristics     | "measure developer activity"    |
| Case study: how {first real team} sources with BuilderHunt | Only when a real customer exists                                   | "developer sourcing case study" |

## Success metrics

- 5 posts by launch; 2/month for 3 months after (11 total by +90d).
- Blog pages indexed in Search Console within 2 weeks of the sitemap fix.
- ≥10% of signups with a blog page in their referrer chain by +90d (server logs / UTM).
- Guardrail: ≤6h writing time per post — if consistently over, shorten the format.

## Resolved questions

- Cadence: 2/month (not weekly). Voice: first-person founder. Length: 1000-2000 words.
- Cross-posting: manual, dev.to + Hashnode, always with canonical URL to builderhunt.dev.
