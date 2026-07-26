# Conversion baseline — claim inventory and funnel definitions

Plan: `plans/phase-1/audit-conversion`. Created 2026-07-26, instrumentation-only phase
(Phase A — `baseline` fixed for every session, `CONVERSION_EVENTS_ENABLED=false` by default).

## 1. Claim inventory

Every quantitative/product/customer claim on the landing journey, its evidence, and review date.

| Claim | Where | Evidence | Reviewed |
|---|---|---|---|
| Real product screenshots (desktop/mobile) | `HomePage.tsx` hero | `public/images/search-desktop*.{avif,webp,png}` exist and are wired via `<picture>` | 2026-07-26 |
| "12 sources, one search" | `onboarding/welcome.tsx`, `onboarding/search.tsx`, `onboarding/success.tsx` | `src/lib/sources/types.ts` `SOURCE_NAMES` has 15 entries; `/explore`'s visible source chips + "and more" copy is the honest subset — kept as-is, not re-litigated this pass | 2026-07-26 |
| "GitHub, Reddit, Hacker News, DEV.to and more" | `HomePage.tsx` hero paragraph, `__root.tsx` meta description + FAQ JSON-LD | **Fixed this pass** — previously read as an exhaustive 4-source list (no "and more"), contradicting the bento grid's own "+ 11 more sources" a few hundred pixels below it | 2026-07-26 |
| Public `SearchAction` JSON-LD points at `/explore` | `__root.tsx` | **Fixed this pass** — previously pointed at `/search`, which requires an authenticated session; a crawler or anonymous visitor following it got nothing | 2026-07-26 |
| No anonymous/unverifiable testimonial | `HomePage.tsx` | Removed in an earlier pass this session (`audit-trust`, commit `bdf77f1`) — re-verified absent via `rg 'paid for itself|Beta user' src`, still true | 2026-07-26 |
| No unsupported `aggregateRating` JSON-LD | `__root.tsx` | Removed in `audit-trust`; re-verified via `src/modules/landing/components/trust-claims.test.ts` (regression-tested, still passing) | 2026-07-26 |
| No inert "Join Alerts" email capture | `HomePage.tsx` | Removed in `audit-trust`; re-verified absent via `rg 'Join Alerts' src` | 2026-07-26 |
| Guest search intent (`?q=...`) is preserved through signup to the real authenticated search | `explore/index.tsx` → `sign-up.tsx` → `SignUpPage.tsx` → onboarding | **Fixed this pass** — `next` was accepted by the explore CTA's link but silently dropped by `SignUpPage.tsx`; now validated (`safe-next.ts`) and restored after onboarding (`post-onboarding-next.ts`) | 2026-07-26 |

## 2. Funnel definitions

### Signup-first journey
`/` (hero/final CTA) → `/auth/sign-up` → `signup_complete` → `/onboarding/welcome`.

### Value-first journey
`/` (hero secondary link) → `/explore` → `explore_search_complete` → `explore_signup_click` →
`/auth/sign-up?next=/search?...` → `signup_complete` → onboarding → restored `/search?...`.

### Eligibility
A session is **eligible** for every funnel metric below only if the user gave explicit analytics
consent (`bh_cookie_consent.analytics === true`) — essential-only users are excluded from both
numerator and denominator, per the spec's non-goal against coercive consent UI. No event is ever
recorded for a session that declined or hasn't yet answered the cookie banner.

### Event → surface map (enforced by `conversion-events.ts`'s closed schema)

| Event | Valid surface(s) | Fired from |
|---|---|---|
| `landing_view` | `hero` | `HomePage.tsx` mount |
| `hero_signup_click` | `hero`, `final_cta` | Both sign-up CTAs on `/` |
| `hero_explore_click` | `hero` | The hero's secondary `/explore` link |
| `explore_search_complete` | `explore` | `/explore` once per distinct completed query |
| `explore_signup_click` | `explore` | The `/explore` results page's "Sign up free" CTA |
| `signup_submit` | `signup` | `SignUpPage.tsx` form submit |
| `signup_complete` | `signup` | `SignUpPage.tsx` on a successful account creation |

## 3. Metrics (computed by `api/admin/metrics/conversion.ts`)

- **Primary**: `landing_to_signup` = `signup_complete` / `landing_view` (eligible sessions).
- **Secondary**: `hero_signup_ctr`, `hero_explore_ctr`, `explore_search_completion`,
  `explore_to_signup_ctr`, `signup_completion`.
- Each metric reports raw numerator/denominator counts, a rate, and a 95% Wilson score
  confidence interval (`computeConversionRate` in `conversion-events.ts`) — `insufficientSample:
  true` below 30 sessions, in which case the raw rate is still shown but no CI claim is made.

## 4. Baseline status

**Unknown — not yet collected.** `CONVERSION_EVENTS_ENABLED` defaults to `false`; no events have
been recorded in production. Per the spec, no uplift number is accepted as a baseline before at
least 14 full days and 1,000 eligible landing sessions (or four weeks if traffic is lower).

**This pass shipped instrumentation only** (Phase A: `variant` is always `'baseline'` — no
treatment cohort exists yet, since there is nothing to compare against until the flag is turned
on and a real baseline window has run). Turning on collection, running the baseline window, and
any subsequent staged treatment rollout (10% → 50% → decision) are explicitly **not done this
pass** — see `plans/phase-1/audit-conversion/tasks.md` for what's deferred and why.

## 5. Guardrails (to monitor once collection is live)

- Signup server error rate: no more than +1 percentage point vs. baseline.
- Guest search completion: no more than -5% relative vs. baseline.
- Zero new axe critical/serious failures on `/`, `/explore`, `/auth/sign-up`.
- Performance budgets: see `plans/phase-1/audit-performance-qa/spec.md` (already has a running
  budget checker from that plan's own pass this session).
