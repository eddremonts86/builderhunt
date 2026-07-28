# Tasks: Launch Checklist

> **Status**: `non-actionable for an autonomous coding session` — every task here is a manual
> go-to-market action (posting to Show HN/Reddit/X/LinkedIn/Indie Hackers as the founder,
> submitting to Google Search Console/Bing Webmaster Tools under the founder's own account,
> monitoring prod analytics day-to-day). None of it is code. Reviewed 2026-07-25 and left
> as-is — this plan is the founder's own launch runbook to execute, not an implementation
> task queue.
> **Depends on**: [`production-infrastructure`](../02-production-infrastructure/spec.md), [`legal-and-compliance`](../03-legal-and-compliance/spec.md), [`public-landing-pages`](../44-public-landing-pages/spec.md), [`content-marketing`](../45-content-marketing/spec.md), [`status-and-trust`](../46-status-and-trust/spec.md), [`pricing-and-billing`](../30-pricing-and-billing/spec.md)
> **Blocks**: nothing
> **Reality check**: No waitlist is built or planned. These are execution/verification tasks
> against the already-deployed app; the only "Files" entries are checklists run against prod.

## Phase 1 — Prerequisite gate

- [ ] **Verify launch-blocking fixes from sibling plans are merged**
  - Files: none (review task)
  - Do: Confirm merged: pricing price-field fix (`pricing-and-billing` Phase 1), deletion
    purge worker (`legal-and-compliance` Phase 1), sitemap `/pricing`+`/blog` entries
    (`public-landing-pages` Phase 1), backup cron verified (`production-infrastructure`
    Phase 1), 5th blog post published (`content-marketing`).
  - Verify: Each owning plan's tasks.md shows those tasks checked; spot-check on prod
    (`/pricing` shows $19, `/sitemap.xml` contains `/blog`).

## Phase 2 — Production verification (T-7)

- [ ] **Smoke-test every public route on prod**
  - Files: none (manual, against `https://builderhunt.dev`)
  - Do: Load `/`, `/pricing`, `/explore`, `/explore?q=react`, `/blog`, each of the 3+ post
    slugs, `/status`, `/changelog`, `/roadmap`, `/legal/terms|privacy|cookies|imprint`,
    `/sitemap.xml`, `/robots.txt`, `/api/status`. Check no 500s, no `$undefined`, cookie
    banner appears once, dark theme renders.
  - Verify: All routes 200 with correct content; note failures as issues before proceeding.

- [ ] **Smoke-test the core authed funnel on prod**
  - Files: none (manual)
  - Do: Fresh email → sign up → land on `/onboarding/welcome` → complete the 3-step tour →
    run a search → track 3 builders → `/exports` CSV download → request upgrade on `/pricing`
    → verify it appears in `/admin/plan-requests` → delete the test account from
    `/settings/privacy` and cancel the deletion.
  - Verify: Every step succeeds; the plan request and deletion request rows appear and behave.

- [ ] **Submit sitemap and verify OG previews**
  - Files: none (external tools)
  - Do: Add the property in Google Search Console + Bing Webmaster Tools, submit
    `/sitemap.xml`. Paste `/`, `/pricing`, `/explore?q=react`, and one blog URL into the
    X card validator / LinkedIn post inspector / a Slack DM; confirm the PNG OG image renders
    (endpoint: `src/routes/api/og/explore.tsx`).
  - Verify: GSC shows sitemap "Success"; all 4 URLs show image + title + description previews.

## Phase 3 — Content freeze (T-2)

- [ ] **Seed changelog with real shipped history**
  - Files: none (via `/admin/changelog` UI → `src/routes/api/admin/changelog/index.ts`)
  - Do: Create 6-10 entries from real git history (federated search, tracking + exports,
    smart alerts, claimable profiles, onboarding, billing, legal/GDPR, status page, landing
    redesign), dated to when they shipped.
  - Verify: `/changelog` lists them newest-first; each `/changelog/$slug` renders.

- [ ] **Seed public roadmap**
  - Files: none (via `/admin/roadmap` UI → `src/routes/api/admin/roadmap/index.ts`)
  - Do: Add 5-8 public-friendly items from `plans/` (semantic search, AI outreach drafts,
    team accounts, more sources, portfolio pages) in planned/in-progress columns. No internal
    jargon, no dates promised.
  - Verify: `/roadmap` renders the items; vote button works signed-in.

## Phase 4 — Distribution (T-0, one channel per day)

- [ ] **Show HN post**
  - Files: none
  - Do: "Show HN: BuilderHunt – find active developers across 12 sources (GitHub, HN,
    Stack Overflow…)". First comment: honest write-up — what it does, stack (TanStack Start +
    Postgres, single Hetzner VPS), what feedback is wanted (search relevance, sources to add).
    Post morning US time, stay available all day to reply.
  - Verify: Post live; every top-level comment answered within 2h; feedback captured as issues.

- [ ] **dev.to cross-post + X thread + LinkedIn + one subreddit + Indie Hackers**
  - Files: none
  - Do: dev.to: cross-post "Why I built BuilderHunt" (`content/posts/why-i-built-builderhunt.md`)
    with `canonical_url` set to the builderhunt.dev URL. X: 6-8 tweet thread (problem → 12
    sources screenshot → tracking/alerts → link). LinkedIn: recruiter-angle summary. Reddit:
    r/ExperiencedDevs or r/webdev per sub self-promo rules. Indie Hackers: launch milestone.
    Stagger one per day after HN.
  - Verify: Each post live with working links; UTM-tagged links (`?utm_source=devto` etc.) so
    referrers show in analytics/server logs.

## Phase 5 — Monitoring (T+1..30)

- [ ] **Daily launch-week monitoring, then weekly**
  - Files: none
  - Do: Check `/admin/metrics` (signups, searches, errors), `/status`, Search Console
    impressions; reply to every feedback comment; file real bugs/requests into `plans/` or
    issues; publish a weekly changelog entry.
  - Verify: 30-day review written up: signups vs 200 target, activation rate
    (`onboarding_progress.completed` / signups), top 3 feedback themes, next-plan decision.
