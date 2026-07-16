# Feature: Content Marketing (Blog + Cross-posting)

## Problem

Sin content marketing:
1. **No SEO traffic** — Google no tiene qué indexar
2. **No inbound leads** — devs no descubren el producto
3. **No thought leadership** — la marca es invisible
4. **No social shareable content** — sin posts, no hay links
5. **Compounding growth** = 0. La distribución es 100% manual

## Goal

- **Blog** en `builderhunt.dev/blog/[slug]`
- **5-10 posts** cross-posteados a dev.to, Medium, Hashnode
- **Topics**: founder story, technical deep-dives, SEO keywords
- **Target**: 1 post/semana steady state

## Non-goals (v1)

- **No es un CMS rico.** Markdown files in repo, rendered server-side
- **No es multi-author.** Solo tú escribes (o 1-2 personas)
- **No es un newsletter propio.** Use Substack o Beehiiv for that
- **No es SEO-optimized al pixel.** v1: good content, basic SEO
- **No es un podcast / YouTube.** Eso es otro plan

## Why this matters

- 1 blog post per week × 52 weeks = 52 pieces of content indexed
- Each post compounds: linkable, shareable, ranks for long-tail keywords
- Posts drive 30-50% of organic signups for dev tools (per Buffer, Stripe data)
- Founder stories convert 2-3x better than product pages (per Copyblogger)

## Topics to cover (10 posts in v1)

### Founder story
1. **"Why I built BuilderHunt"** — personal, vulnerability, motivation
2. **"Building a 12-source developer search engine in TanStack Start"** — technical founder

### SEO keywords (long-tail)
3. **"How to find good developers as a solo founder"** — value-first, mentions BuilderHunt
4. **"The 12 sources I use to find developers in 30 seconds"** — listicle
5. **"How to write cold emails that devs actually reply to"** — value-first
6. **"What I learned indexing 10,000 developers"** — technical, lessons learned
7. **"Building a verification flow for claimed profiles"** — technical

### Tutorial / how-to
8. **"The solo founder's guide to technical sourcing"** — guide
9. **"How to set up saved searches for tech recruiting"** — tutorial

### Case study
10. **"How X team uses BuilderHunt to source developers"** (once we have one)

## Each post structure

- 1000-2000 words
- 1-2 screenshots / code blocks
- Clear intro (problem)
- 3-5 sections with h2 headings
- Conclusion with CTA (sign up, try it)
- Internal links: 1-2 to other blog posts
- External links: 1-2 to relevant docs (HN API, etc.)
- SEO: title 50-60 chars, meta description 150-160 chars, slug 3-5 words

## Cross-posting

Each post is cross-posted to:
- **dev.to** (primary, 100k+ dev audience)
- **Medium** (B2B / professional audience)
- **Hashnode** (dev audience, since we already have it as a source)
- **LinkedIn** (B2B, recruiters)

Use the canonical URL pointing back to `builderhunt.dev/blog/[slug]` for SEO.

## Distribution

Each post is shared:
- **Twitter/X** thread (5-8 tweets)
- **LinkedIn** (full post or excerpt)
- **Hacker News** (only for technical deep-dives, every 4-6 weeks)
- **Reddit** (relevant subreddits: r/programming, r/webdev, r/ExperiencedDevs)
- **Indie Hackers** (founder story angle)
- **dev.to** (cross-posted)

## URL design

```
/blog                                    → list of all posts
/blog/why-i-built-builderhunt            → individual post
/blog/atom.xml                           → RSS feed
```

## Data model

**Posts stored as markdown files** in repo, NOT in DB:
- `content/posts/why-i-built-builderhunt.md`
- Frontmatter: title, description, date, tags, slug, ogImage

**Why files, not DB**:
- Version-controlled (every edit is a git commit)
- No CMS needed
- Easy to backup (just git)
- Type-safe with TypeScript
- Same workflow as code changes

**Build step**:
- At build time, scan `content/posts/`
- Parse frontmatter + content
- Generate static page routes

## Implementation

### Markdown rendering

Use `marked` or `remark` to parse:
```ts
import { marked } from 'marked'
const html = marked.parse(markdownContent)
```

Or `react-markdown` for JSX rendering with components.

**Choice**: `marked` for speed + simplicity, render as HTML on server.

### File structure

```
content/
  posts/
    why-i-built-builderhunt.md
    how-to-find-good-developers.md
    12-sources-developer-search.md
    ...
  authors/
    edd.md  # author bio + avatar
```

### Frontmatter format

```yaml
---
title: Why I built BuilderHunt
description: The story of how 12 sources and a single email made me realize the problem.
slug: why-i-built-builderhunt
date: 2026-07-20
tags: [founder-story, product]
author: edd
ogImage: /blog/why-i-built-builderhunt/og.png  # auto-generated
---
```

### Routes

File: `src/routes/blog/index.tsx` (new, public)

- [ ] List of all posts (newest first)
- [ ] Each: title, description, date, tags, author
- [ ] Pagination (10 per page)

File: `src/routes/blog/$slug.tsx` (new, public)

- [ ] Render markdown as HTML
- [ ] Meta tags: title, description, OG image, canonical
- [ ] JSON-LD: BlogPosting
- [ ] Author bio at bottom
- [ ] Related posts (3 by tag overlap)
- [ ] Share buttons (Twitter, LinkedIn, copy link)
- [ ] "Subscribe to updates" form (just email → notify when new post)

File: `src/routes/blog/atom[.]xml.ts`

- [ ] RSS/Atom feed of all posts
- [ ] Auto-generated at request time

### Build-time post loading

File: `src/lib/blog.ts` (new)

- [ ] `getAllPosts()` — list of all posts with frontmatter
- [ ] `getPostBySlug(slug)` — single post
- [ ] `getRelatedPosts(post, limit)` — by tag overlap
- [ ] Reads from `content/posts/*.md`
- [ ] Uses `gray-matter` for frontmatter parsing

### Author page

File: `src/routes/blog/authors/$slug.tsx` (new)

- [ ] Author bio
- [ ] All posts by this author
- [ ] Avatar + links (Twitter, GitHub, LinkedIn)

## SEO

Each blog post:
- `<title>{post.title} | BuilderHunt Blog</title>`
- `<meta name="description" content="{post.description}">`
- `<meta property="og:title" content="{post.title}">`
- `<meta property="og:type" content="article">`
- `<meta property="article:published_time" content="{post.date}">`
- `<meta property="article:author" content="{post.author}">`
- `<link rel="canonical" href="https://builderhunt.dev/blog/{slug}">`
- JSON-LD `BlogPosting` schema

## OG image generation

Each post has an auto-generated OG image:
- 1200×630
- Title (large, bold)
- Author + date (small)
- BuilderHunt branding

Generated at build time (using `satori` + `resvg`):
- `scripts/blog/generate-og.ts` — runs in CI, generates og.png for each post
- Stored in `public/blog/{slug}/og.png`
- Referenced in frontmatter

## Analytics

Track each post:
- `blog_view` (slug, referrer, timeOnPage)
- `blog_share` (slug, platform)
- `blog_cta_click` (slug, ctaType) — sign-up click from a blog post
- `blog_subscribe` (email)

## Cross-posting automation

For each post, auto-publish to:
- **dev.to** (via their public API, free)
- **Hashnode** (via their GraphQL API, we have it as a source)
- **Medium** (no public API; manual via Buffer)
- **LinkedIn** (no public API; manual)

**Tool**: `scripts/blog/cross-post.ts`
- Reads frontmatter `crossPostTo: ['devto', 'hashnode']`
- Calls respective APIs
- Logs URLs returned

## Editorial calendar

File: `docs/content-calendar.md`

Track planned posts:
```
2026-07-20  Why I built BuilderHunt          [ ] [ ] [ ] [ ]
2026-07-27  12 sources developer search       [ ] [ ] [ ] [ ]
2026-08-03  How to find good developers       [ ] [ ] [ ] [ ]
...
```

`[ ]` = draft / review / published / distributed

## Success metrics

- **Primary**: # of posts published. Target: 10 in 90 days, 1/week steady
- **Secondary**: Total organic traffic. Target: 1k visitors/month from blog after 6 months
- **Tertiary**: Signups attributed to blog. Target: 20% of all signups after 6 months
- **Guardrail**: Time to write each post < 6 hours. If longer, simplify or split

## Out of scope (v1)

- Comments (use dev.to's comment system via cross-post)
- Newsletter (use Substack or Beehiiv)
- Multi-author (you + 1-2 people max)
- Translation (English only v1)
- Audio / podcast version
- Video version
- Sponsored posts

## Open questions

- **Frequency**: 1/week is doable but exhausting. 2/month is sustainable. Pick one.
- **Length**: 1000-2000 words? Or shorter (500-800) for more posts? Or longer (3000+) for SEO depth?
- **Voice**: first-person founder? Or third-person "we at BuilderHunt"? Pick one and stay consistent.

## Dependencies

- New package: `gray-matter` (frontmatter), `marked` (markdown)
- New content dir: `content/posts/`
- New routes: 3 (blog list, blog post, author)
- New env vars: none
- New accounts: dev.to API key (for cross-posting), Hashnode (already have)
- New build script: `scripts/blog/generate-og.ts`

## Estimated effort

| Phase | Effort |
|-------|--------|
| 1 — Blog infrastructure (file loading, routes) | S (3-4h) |
| 2 — First 3 posts (write + publish) | L (2-3 days) |
| 3 — OG image generation | S (2-3h) |
| 4 — Cross-posting automation | M (3-4h) |
| 5 — Email subscribe form | XS (1-2h) |
| 6 — Steady state: 1 post/week | 30min each |
| **Total** | **~3-4 days initial, then ongoing** |
