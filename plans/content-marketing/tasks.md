# Tasks: Content Marketing

## Phase 0 — Research

- [ ] Pick markdown parser: `marked` (fast, simple) vs `remark` (extensible)
- [ ] Pick frontmatter parser: `gray-matter`
- [ ] Sign up for dev.to API (free, 1-day approval)
- [ ] Set up cross-posting accounts: dev.to, Hashnode (already), Medium (manual)

## Phase 1 — File structure

- [ ] Create `content/posts/` directory
- [ ] Create `content/authors/edd.md` with bio + avatar
- [ ] Add 1 example post to test the pipeline

## Phase 2 — Library

File: `src/lib/blog.ts` (new)

- [ ] `getAllPosts()` — read all .md files in `content/posts/`, parse frontmatter + content
- [ ] `getPostBySlug(slug)` — single post
- [ ] `getRelatedPosts(post, limit)` — by tag overlap
- [ ] `getAuthorBySlug(slug)` — author info
- [ ] Use `gray-matter` for frontmatter, `marked` for markdown → HTML
- [ ] Sort posts by date desc
- [ ] Cache results (build-time for prod, runtime for dev)

## Phase 3 — Routes

File: `src/routes/blog/index.tsx` (new, public, SSR)

- [ ] List of all posts
- [ ] Each: title, description, date, tags, author
- [ ] Pagination (10 per page)
- [ ] "Subscribe via RSS" link

File: `src/routes/blog/$slug.tsx` (new, public, SSR)

- [ ] Render post content (HTML from markdown)
- [ ] Meta tags: title, description, OG, canonical
- [ ] JSON-LD `BlogPosting` schema
- [ ] Author bio at bottom
- [ ] Related posts (3 cards)
- [ ] Share buttons (Twitter, LinkedIn, copy link)
- [ ] "Subscribe to updates" form

File: `src/routes/blog/authors/$slug.tsx` (new, public, SSR)

- [ ] Author bio + avatar
- [ ] List of all posts by author

File: `src/routes/blog/atom[.]xml.ts`

- [ ] RSS/Atom feed of all posts
- [ ] Auto-generated

## Phase 4 — OG image generation

File: `scripts/blog/generate-og.ts` (new)

- [ ] For each post in `content/posts/`, generate `public/blog/{slug}/og.png`
- [ ] Use `satori` + `resvg` to render JSX → PNG
- [ ] 1200×630 dimensions
- [ ] Title (large), author + date (small), BuilderHunt branding
- [ ] Run in CI on `git push` (via GitHub Action)

## Phase 5 — Cross-posting

File: `scripts/blog/cross-post.ts` (new)

- [ ] Read post frontmatter: `crossPostTo: ['devto', 'hashnode']`
- [ ] For each target, call respective API
- [ ] dev.to: `POST https://dev.to/api/articles` with article data
- [ ] Hashnode: GraphQL mutation `publishPost`
- [ ] Log returned URLs (so we can update frontmatter with the canonical URL)
- [ ] Manual run: `pnpm cross-post why-i-built-builderhunt`

## Phase 6 — Email subscribe

File: `src/routes/api/blog/subscribe.ts` (new, POST)

- [ ] Body: `{ email }`
- [ ] Insert into a new `blog_subscribers` table
- [ ] Send verification email
- [ ] On verify, mark as confirmed

File: `src/shared/lib/email-templates/blog-welcome.tsx`

- [ ] "Welcome to the BuilderHunt blog"
- [ ] "We'll email you when we publish new posts"

## Phase 7 — First 3 posts

Author and publish:

### Post 1: Founder story
- Title: "Why I built BuilderHunt"
- Outline:
  - The problem: I was hiring, lost in 12 different platforms
  - The moment: I realized I was spending 4 hours per week on this
  - The build: solo, side project, 6 months, 12 sources
  - The launch: invite-only, 47 users, 80% retention
  - The ask: "Try it, tell me what sucks"
- Word count: 1500
- CTA: sign up for waitlist
- Cross-post: dev.to, Hashnode, LinkedIn

### Post 2: SEO keyword
- Title: "How to find good developers as a solo founder in 2026"
- Outline:
  - 6 channels: GitHub, HN, Reddit, DEV.to, SO, LinkedIn
  - Pros/cons of each
  - 3-step process: pick channel, search, engage
  - Tools that help (mention BuilderHunt as one of them)
  - Red flags: don't spam, be genuine
- Word count: 1800
- CTA: try BuilderHunt
- Cross-post: dev.to, Medium, Hashnode

### Post 3: Technical
- Title: "Building a 12-source developer search engine in TanStack Start"
- Outline:
  - Why 12 sources (the 80/20)
  - Architecture: 1 endpoint per source, 1 unified response
  - Deduplication across sources
  - Caching strategy (5min Redis)
  - Results: 10k builders indexed, 200ms p95 latency
  - Code snippets
- Word count: 2000
- CTA: try it
- Cross-post: dev.to, Hashnode

## Phase 8 — Templates

File: `content/posts/TEMPLATE.md`

```markdown
---
title: "[post title]"
description: "[1-sentence value prop, 50-160 chars]"
slug: "[kebab-case-slug]"
date: 2026-07-20
tags: [tag1, tag2]
author: edd
crossPostTo: [devto, hashnode]
---

# [Hook: 1 sentence that grabs attention]

[Problem: 1 paragraph why this matters]

## [Section 1]

[Content]

## [Section 2]

[Content]

## [Conclusion]

[Wrap-up]

[CTA: link to BuilderHunt]
```

## Phase 9 — Editorial calendar

File: `docs/content-calendar.md`

```
2026-07-20  Why I built BuilderHunt                [draft]
2026-07-27  12 sources developer search            [draft]
2026-08-03  How to find good developers            [planned]
2026-08-10  Solo founder technical sourcing guide  [planned]
2026-08-17  How to write cold emails devs reply to [planned]
2026-08-24  What I learned indexing 10k devs        [planned]
```

## Phase 10 — Verification

### Manual
- [ ] Visit /blog → list of 3 posts
- [ ] Click post → renders correctly with images
- [ ] View source → SEO meta tags present
- [ ] OG image: visit /blog/{slug}/og.png → PNG
- [ ] RSS feed: /blog/atom.xml → valid XML
- [ ] Subscribe form → email verification
- [ ] Cross-post: dev.to receives the post
- [ ] Cross-post: Hashnode receives the post

### Automated
- [ ] Playwright: /blog renders 3 posts
- [ ] Playwright: click post, check title
- [ ] Test cross-posting with test post
- [ ] RSS XML validates

### SEO
- [ ] Submit to Google Search Console
- [ ] Submit to Bing Webmaster
- [ ] Lighthouse: all green
- [ ] Mobile-friendly: passes

## Phase 11 — Steady state

- [ ] Set up weekly reminder (Sunday 10am): "Time to write a new post"
- [ ] Editorial review: each post reviewed by 1-2 people before publishing
- [ ] Distribution checklist: post to dev.to, share on Twitter, share on LinkedIn
- [ ] Track metrics: views, signups, shares per post
- [ ] Monthly: review top-performing post topics, write more on those

## Edge cases

- **Post with no frontmatter**: skip with warning
- **Post with future date**: don't publish until date reached
- **Post with broken image**: fallback to default OG
- **Cross-post API fails**: log, retry on next manual run
- **Markdown with HTML**: sanitize (use `marked` with `sanitize: true` option)
- **Post with code block**: render with syntax highlighting (`marked` + `prismjs`)

## Dependencies

- New packages: `gray-matter`, `marked`, `satori`, `resvg`
- New content dir: `content/posts/`, `content/authors/`
- New routes: 4 (blog list, post, author, RSS)
- New env vars: `DEVTO_API_KEY` (for cross-posting)
- New accounts: dev.to API key
- New scripts: `generate-og.ts`, `cross-post.ts`

## Estimated effort: 3-4 days initial, 30min/post steady state
