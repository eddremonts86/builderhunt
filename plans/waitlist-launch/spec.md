# Launch Checklist (formerly "Waitlist & Launch")

> **Status**: `pending`
> **Depends on**: [`production-infrastructure`](../production-infrastructure/spec.md), [`legal-and-compliance`](../legal-and-compliance/spec.md), [`public-landing-pages`](../public-landing-pages/spec.md), [`content-marketing`](../content-marketing/spec.md), [`status-and-trust`](../status-and-trust/spec.md), [`pricing-and-billing`](../pricing-and-billing/spec.md)
> **Blocks**: nothing
> **Reality check**: There is **zero waitlist code** in `src/` (grep "waitlist" → no matches)
> and auth is open email/password signup (`src/routes/auth/sign-up.tsx`, better-auth). The
> launch surface already exists: redesigned landing (`src/routes/_landing/index.tsx` →
> `HomePage.tsx`), `/pricing`, `/blog` (3 posts in `content/posts/`), `/explore`, `/status`,
> `/changelog`, `/roadmap`, `/legal/*`, sitemap/robots, OG images, Coolify deploy on Hetzner.

## Decision: no waitlist (2026-07-19)

The original plan (viral waitlist, referral codes, queue positions) was written before the
product was built. Reality today: the app is fully usable, signup is open, and every public
page a launch needs is live. Adding a waitlist now would mean _removing_ working signup to
manufacture scarcity — friction with no audience to leverage it. **This plan is repurposed as
the launch checklist**: verify production readiness, finish launch content, execute
distribution, monitor. The waitlist/referral mechanic is dropped (revisit only if a future
gated beta for a specific feature needs it).

## Problem

BuilderHunt is built and deployed but has never been announced. Zero external users means no
feedback loop, no social proof, and no momentum.

## Goal

Execute a public launch: pre-launch verification of the production app, launch-day
distribution across dev channels, and a first-week monitoring loop. Target: 200 signups and
one useful feedback thread in the first 30 days (honest targets for an unaudienced solo
launch; the old "1000 in 30 days" assumed a viral loop we no longer build).

## Non-goals

- No waitlist, referral codes, queue positions, or launch-gating of signup (see Decision).
- No paid ads, influencer partnerships, or press outreach.
- No new product features as launch prerequisites beyond the launch-blocking fixes already
  tracked in sibling plans (pricing display bug, legal deletion worker).
- No Product Hunt launch automation — launch day is manual.

## Launch prerequisites (owned by sibling plans, listed here as the gate)

| Prerequisite                                    | Owner                               | State       |
| ----------------------------------------------- | ----------------------------------- | ----------- |
| `/pricing` shows real prices (not `$undefined`) | `pricing-and-billing` Phase 1       | pending     |
| Account-deletion purge worker live              | `legal-and-compliance` Phase 1      | pending     |
| Sitemap includes `/pricing` + `/blog`           | `public-landing-pages` Phase 1      | pending     |
| DB backup cron verified on the VPS              | `production-infrastructure` Phase 1 | pending     |
| 5 published blog posts                          | `content-marketing`                 | 3 of 5 done |
| Legal pages, status page, changelog live        | delivered                           | done        |

## Launch sequence

1. **T-7 days — production verification**: smoke-test every public route and the core funnel
   (sign up → onboarding → search → track → export) on the production domain; submit sitemap
   to Google Search Console and Bing; verify OG previews render on X/LinkedIn/Slack.
2. **T-2 days — content freeze**: final 2 blog posts published; changelog seeded with the
   real shipping history; roadmap seeded with the actual plans/ backlog (public-friendly).
3. **T-0 — distribution** (one channel per day, not all at once):
   - Show HN: honest "Show HN: BuilderHunt — find active developers across 12 sources".
   - dev.to cross-post of the founder-story post (canonical → builderhunt.dev).
   - X/Twitter thread + LinkedIn post (B2B recruiter angle).
   - Reddit (r/webdev or r/ExperiencedDevs — pick one, follow sub rules).
   - Indie Hackers milestone post.
4. **T+1..30 — monitoring loop**: daily check of `/admin/metrics` (signups, searches),
   Search Console impressions, and feedback replies; weekly changelog entry.

## Success metrics

- Primary: signups in first 30 days (target 200; measured via `/admin/metrics` / `auth_users`).
- Secondary: activation — % of signups that complete onboarding or first tracked builder
  (`onboarding_progress.completed`, `builders` rows).
- Tertiary: ≥1 organic backlink or HN/Reddit thread with real feedback.
- Guardrail: production uptime during launch week (no red on `/status`).

## Resolved questions

- **Waitlist still relevant?** No — dropped (see Decision).
- **Launch threshold?** None. Launch when the prerequisite table above is green; earlier is
  better than polished.
- **Signup emails?** Resend is configured but optional (`RESEND_API_KEY` in env.ts); launch
  does not depend on email sequences.
