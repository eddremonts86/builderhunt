# Plan: Content Marketing

> **Status**: `partially-implemented`
> **Depends on**: [`public-landing-pages`](../45-public-landing-pages/spec.md)
> **Blocks**: [`waitlist-launch`](../54-waitlist-launch/spec.md)
> **Reality check**: Blog engine delivered (`content/posts/`, `src/shared/lib/blog.ts` +
> tests, `/blog` routes, Atom feed). Remaining work is almost entirely writing, plus one tiny
> template file. No new packages, tables, or env vars.

## Phases

### Phase 0 — Delivered (2026-07)

File-based blog with loader + tests, list/detail routes with meta + JSON-LD, Atom feed,
3 published posts. No re-work.

### Phase 1 — Launch content (writing, ~2 days)

Post 4 ("How to find developers as a solo founder in 2026") and post 5 ("How I built a
12-source developer search engine with TanStack Start"), plus a `TEMPLATE.md` so every future
post starts with valid frontmatter. Blocks the launch checklist's content freeze.

### Phase 2 — Distribution routine (per post, ongoing)

Manual checklist executed for every post from #4 onward: dev.to + Hashnode cross-post with
`canonical_url`, X thread, LinkedIn. First run doubles as the launch distribution
(coordinated with `waitlist-launch` Phase 4).

### Phase 3 — Steady state (2 posts/month)

Work through the backlog briefs table in the spec, one task per post, keeping the ≤6h/post
guardrail. Review topic performance monthly via Search Console and write more of what ranks.

## Risks

| Risk                                        | Likelihood | Mitigation                                                                                                                          |
| ------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Cadence collapses after launch              | High       | 2/month (not weekly); briefs pre-written in spec; guardrail allows shortening format                                                |
| Posts don't rank (new domain, no backlinks) | High       | Launch distribution seeds initial links; internal links to `/explore` pages spread equity; measure at +90d before changing strategy |
| Cross-post duplicates outrank the origin    | Medium     | Always set `canonical_url` on dev.to/Hashnode                                                                                       |

## Rollback

Not applicable — content-only. A bad post gets edited or unpublished by deleting its file
from `content/posts/` (loader picks up the change on next request).
