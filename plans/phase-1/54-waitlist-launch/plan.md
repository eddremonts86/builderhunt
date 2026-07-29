# Plan: Launch Checklist

> **Status**: `pending`
> **Depends on**: [`production-infrastructure`](../02-production-infrastructure/spec.md), [`legal-and-compliance`](../04-legal-and-compliance/spec.md), [`public-landing-pages`](../45-public-landing-pages/spec.md), [`content-marketing`](../46-content-marketing/spec.md), [`status-and-trust`](../47-status-and-trust/spec.md), [`pricing-and-billing`](../31-pricing-and-billing/spec.md)
> **Blocks**: nothing
> **Reality check**: No waitlist code exists and none will be built (decision in spec). The
> product and all public marketing surfaces are live on Coolify/Hetzner; this plan is
> execution + verification, almost entirely non-code.

## Phases (dependency order)

### Phase 1 — Prerequisite gate (code, owned by sibling plans)

Wait for / verify the launch-blocking fixes tracked elsewhere: pricing display fix
(`pricing-and-billing`), deletion purge worker (`legal-and-compliance`), sitemap additions
(`public-landing-pages`), backup cron verification (`production-infrastructure`), 2 remaining
blog posts (`content-marketing`). This plan does not duplicate those tasks — it only checks
they are done before proceeding.

### Phase 2 — Production verification (T-7)

Manual + scripted smoke test of the deployed app; search-engine submission; OG preview
verification. Output: a pass/fail checklist run against `https://builderhunt.dev`.

### Phase 3 — Content freeze (T-2)

Seed `/changelog` with real shipped-feature history (admin UI exists), seed `/roadmap` with a
public-friendly subset of `plans/`, final read-through of landing/pricing/blog copy.

### Phase 4 — Distribution (T-0, staggered over ~1 week)

Show HN, dev.to cross-post, X thread, LinkedIn, one subreddit, Indie Hackers. One channel per
day so feedback is attributable and fixable between posts.

### Phase 5 — Monitoring loop (T+1..30)

Daily metrics/feedback check, weekly changelog entry, triage feedback into `plans/`.

## Risks

| Risk                                          | Likelihood | Mitigation                                                                                                                             |
| --------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| HN/Reddit traffic spike overwhelms single VPS | Low-Med    | Redis caching + rate limiting already live (`src/shared/lib/rate-limit.ts`); `/status` shows degradation; worst case is slow, not down |
| External source APIs rate-limit under load    | Medium     | Search results are cached (`src/lib/search.ts` memory+Redis); tokens configured in env raise limits                                    |
| Launch lands before legal deletion worker     | Medium     | Phase 1 gate is explicit; do not skip                                                                                                  |
| Silence (no traction)                         | High       | Staggered channels give 5 shots; feedback loop feeds `plans/` regardless                                                               |

## Rollback

Nothing to roll back — no code ships from this plan. If launch goes badly (outage, hostile
thread), post an incident on `/status`, fix, and re-approach the next channel later.
