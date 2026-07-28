# Specification: Evidence-led conversion audit

> **Status**: `partially-implemented`
> **Depends on**: [`public-landing-pages`](../44-public-landing-pages/spec.md), [`legal-and-compliance`](../03-legal-and-compliance/spec.md)
> **Blocks**: nothing
> **Reality check**: The home page already renders real desktop/mobile product screenshots from `public/images/search-desktop.png` and `public/images/search-mobile.png`, open signup at `/auth/sign-up`, and guest discovery at `/explore`. `src/modules/landing/components/HomePage.tsx` still hides `/explore` from the hero, shows an unverifiable anonymous quote, and renders a newsletter-like email control without a form handler or persistence; no conversion instrumentation exists.

## Problem

The landing journey offers real product proof and open signup, but its decision path is not measured
and contains avoidable trust/friction problems:

- the hero offers signup and an in-page explainer but not the already-shipped guest `/explore` path;
- the anonymous testimonial makes a commercial claim that cannot be verified;
- the final email input promises alerts but has no `<form>`, submit handler, API, or persistence;
- root structured data claims an aggregate rating (`4.8`, `124`) with no evidenced source;
- the home page lists only four sources in some claims while `/explore` truthfully describes twelve;
- no consent-aware event stream exists, so a promised percentage lift has no denominator or baseline.

Adding a waitlist would contradict the shipped open-signup product and the roadmap decision in
`plans/phase-1/53-waitlist-launch/spec.md`. Adding named customer quotes without written permission would be
fabricated social proof. Both are explicitly out of scope.

## Goal

Create a truthful, low-friction, measurable journey from landing page to either guest value or
account activation. Instrument the current experience first, establish a baseline, then ship a
small content/hierarchy treatment and compare it using predefined metrics and guardrails.

## Baseline

Already delivered:

- [x] Real product screenshots are used in `src/modules/landing/components/HomePage.tsx`; the assets
      exist at `public/images/search-desktop.png` and `public/images/search-mobile.png`.
- [x] Guest search is live at `src/routes/_landing/explore/index.tsx` (`/explore`).
- [x] Open email/password signup is live at `src/routes/auth/sign-up.tsx` and
      `src/modules/auth/components/SignUpPage.tsx`.
- [x] Signup from a populated guest search preserves intent through the existing
      `explore-cta-signup` link, although `SignUpPage` currently ignores its `next` search parameter.
- [x] Pricing, legal, status, changelog, and roadmap trust surfaces are linked from
      `src/shared/components/Footer.tsx`.

Unknown until instrumentation runs:

- unique eligible landing sessions;
- hero signup and guest-explore click-through rates;
- landing-to-signup completion rate;
- guest search completion and guest-search-to-signup rate;
- signup errors/abandonment by funnel step.

No uplift number is accepted as a baseline before at least 14 full days and 1,000 eligible landing
sessions (or four weeks if traffic is lower). The plan reports confidence intervals and raw counts,
not only percentages.

## User journeys

### Signup-first

`/` → hero/final CTA → `/auth/sign-up` → successful account creation →
`/onboarding/welcome`.

### Value-first

`/` → hero secondary link → `/explore` → completed guest search → contextual signup CTA →
`/auth/sign-up?next=/search?...` → account creation → onboarding → preserved search intent.

The value-first route must remain visually available, use neutral copy, and never shame or obstruct
users who prefer not to create an account.

## Treatment

- Keep one visually primary signup CTA and add a clearly visible secondary `/explore` action in the
  hero. Keep “See how it works” as a text-level tertiary anchor if retained.
- Keep the existing real screenshots; optimize their responsive delivery and ensure all displayed
  claims match actual routes/data. Do not generate a fake dashboard mockup.
- Remove the anonymous commercial testimonial. Replace it with verifiable product evidence (real
  screenshot caption, supported source count, public status/changelog links) until approved quotes
  with provenance exist.
- Remove the inert “Join Alerts” email control. Point users to the existing account/signup and
  smart-alert path with precise copy; do not create `waitlist_subscribers`.
- Remove unsupported aggregate-rating JSON-LD from `src/routes/__root.tsx` and correct any stale
  `/search` public URL or four-source claim in metadata/structured data.
- Preserve `next` through signup so the guest-search CTA leads to the intended authenticated search
  after onboarding rather than losing context.

## Measurement architecture

Use first-party, consent-aware, data-minimized events. No third-party SDK is introduced.

### Event contract

`src/shared/lib/conversion-events.ts` owns a zod discriminated union:

```ts
type ConversionEvent = {
  name:
    | "landing_view"
    | "hero_signup_click"
    | "hero_explore_click"
    | "explore_search_complete"
    | "explore_signup_click"
    | "signup_submit"
    | "signup_complete";
  surface: "hero" | "final_cta" | "explore" | "signup";
  sessionId: string; // random UUID in sessionStorage; never auth/session cookie
  variant: "baseline" | "treatment";
  occurredAt: string;
};
```

Do not accept arbitrary properties, search text, email, user id, IP, referrer URL, user agent,
notes, or profile data. The API adds a coarse UTC day server-side, rejects timestamps outside a
five-minute window, rate-limits by request origin without persisting that origin, and makes
duplicate `(sessionId, name, surface, variant)` submissions idempotent.

Persist only eligible, explicit analytics-consent events in a new `conversion_events` table in
`src/shared/lib/db/schema.ts`, introduced by a forward-only Drizzle migration. Retain raw events for
30 days, then delete them via an idempotent admin HTTP-cron endpoint following the existing worker
pattern. Update cookie/privacy copy before collection begins. Essential-only users remain fully
functional and are excluded from both numerator and denominator.

### Experiment assignment

- Phase A ships instrumentation only with `baseline` fixed for every eligible session.
- After the minimum baseline window, `VITE_LANDING_CONVERSION_VARIANT` controls `baseline` or
  `treatment`; production starts with a server-configured 10% treatment cohort, assigned randomly
  once per session and stable in sessionStorage.
- Increase to 50% only after 48 hours with no guardrail breach; run until each arm has at least 1,000
  eligible landing sessions and two full weeks. If traffic is insufficient, report inconclusive.
- Never personalize assignment using protected traits, inferred identity, query text, or source.

## Metrics

Primary:

- landing-to-account conversion = eligible `signup_complete` sessions / eligible `landing_view`
  sessions;
- landing-to-value conversion = eligible sessions with either `signup_complete` or
  `explore_search_complete` / eligible `landing_view` sessions.

Secondary:

- hero signup CTR, hero explore CTR, guest search completion rate, and guest-search-to-signup CTR;
- signup completion = `signup_complete` / `signup_submit` eligible sessions.

Guardrails:

- signup server error rate must not increase by more than 1 percentage point;
- guest search completion must not fall by more than 5% relative;
- no performance regression beyond the budgets in `plans/phase-1/48-audit-performance-qa/spec.md`;
- zero new axe critical/serious failures on `/`, `/explore`, and `/auth/sign-up`;
- analytics consent acceptance is not a conversion KPI and must not be optimized with coercive UI.

Success requires a positive primary-metric effect whose 95% confidence interval excludes zero and
no guardrail breach. Otherwise retain the simpler/truthful UX only where it has independent user
value and report the experiment as neutral or inconclusive.

## Non-goals

- A waitlist, newsletter system, marketing email capture, or new outbound-email consent purpose.
- Invented testimonials, customer logos, star ratings, urgency, scarcity, countdowns, preselected
  consent, confirm-shaming, disguised ads, or forced signup before guest search.
- Third-party analytics, cross-site tracking, fingerprinting, or storing raw acquisition URLs.
- Pricing changes, paid checkout, or redesigning the authenticated product.

## Accessibility and content requirements

- CTA hierarchy remains understandable without color; focus order follows reading order; all links
  name their destination/purpose; touch targets satisfy the accessibility audit.
- Screenshot alt text describes visible product evidence without unsupported result counts.
- Experiment variants have equivalent landmark/heading structure and pass keyboard, zoom, reduced
  motion, and screen-reader smoke tests.
- Copy uses current product facts from `_meta/app-reality.md`; every quantitative claim has a code or
  operational evidence link and review date.

## Success gates

- Instrumentation contract, consent enforcement, idempotency, rate limits, 30-day retention, and
  deletion worker pass unit/integration tests before the baseline flag is enabled.
- Baseline and treatment each meet the sample/time gate; otherwise the outcome is explicitly
  inconclusive.
- `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build`, and `pnpm test:conversion` pass in CI.
- Runtime smoke proves both journeys, consent opt-out, preserved `next`, and rollback flag behavior.
- No unsupported testimonial, rating, public `/search` link, or inert email form remains.

## Rollout and rollback constraints

The baseline collector and treatment flag deploy separately. Turning the treatment off restores
baseline copy/CTA hierarchy without a redeploy. Turning collection off stops new writes without
affecting signup or explore. The migration remains backward-compatible during rollback; retained
events expire through the deletion worker and can be deleted early under the privacy workflow.
