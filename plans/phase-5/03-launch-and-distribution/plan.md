# Launch and distribution (plan)

## Delivery order

The sequence in [`spec.md`](./spec.md) is the plan. Two things about it are load-bearing rather than
stylistic.

**Indexing before sitemap.** `/blog`, `/changelog` and `/roadmap` each serve
`<meta name="robots" content="noindex, nofollow">` today — verified from production's own HTML, not
inferred. It is deliberate configuration, not a fault: a *failed* lookup would have hidden `/pricing`
too, because `getSurfaceDirectives` fails closed. Somebody set them. The switch is
`/admin/content` → the Indexing panel (platform-admin only, PATCHes `/api/admin/seo`), and the decision
itself lives as its own task in [`01-production-readiness-audit`](../01-production-readiness-audit/tasks.md).
Submitting the sitemap first wastes the crawl and teaches the wrong thing about the site.

**One channel per day.** The distribution tasks are written as separate items on purpose. Posting
everywhere at once produces one day of traffic and no conversations, and the Show HN task's own Verify
line — every top-level comment answered within two hours — is unmeetable if the same person is also
running four other threads.

## What is already done, so nobody redoes it

- **The four posts are written.** `content/posts/_draft-*.md`, drafted 2026-08-04/05, each verified
  against the running app rather than remembered. The hiring-radar tutorial carries three real
  screenshots taken 2026-08-05, including one showing five genuine matches the alerts worker produced
  from Lobsters, Hacker News and dev.to. Publishing is renaming off the `_` prefix.
- **The changelog and roadmap are seeded** — 23 entries and 32 items, committed as markdown under
  `content/` and upserted on every deploy by orchestrator step 9, because an entry typed into the admin
  panel lived in exactly one environment and did not survive a restore onto a fresh volume.
- **OG previews are verified.** `/api/og/explore` returns 200 `image/png` 1200×630 and its bytes differ
  per query; `/`, `/pricing`, `/explore?q=…` and a blog URL each carry `og:title`, `og:description`,
  `og:image`, `og:url` and `twitter:card`. Two defects were found and fixed getting there: eleven public
  routes were serving the homepage's `og:title`/`og:description`, and the canonical URL dropped the
  query string, which made every `/explore?q=…` sitemap entry declare itself a duplicate of one page.
- **The public surface answers.** All 13 public routes return 200 and `/api/status` reports
  `db: ok, redis: ok`.

So the remaining work is genuinely the maintainer pressing publish and then reading what happens.

## Verification

Nothing here is verified by a test run. Each task names the external artifact that proves it — a live
URL, a Search Console status, a written review. The one repo-side check worth keeping is that a
published post still builds and renders at its slug, which `pnpm test:e2e` covers through
`tests/e2e/public-content.spec.ts`.
