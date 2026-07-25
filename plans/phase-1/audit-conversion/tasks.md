# Tasks: Evidence-led conversion audit

> **Status**: `partially-implemented`
> **Depends on**: [`public-landing-pages`](../public-landing-pages/spec.md), [`legal-and-compliance`](../legal-and-compliance/spec.md)
> **Blocks**: nothing
> **Reality check**: Real screenshots, `/explore`, open signup, and footer trust links are shipped. There is no analytics implementation, the hero omits guest exploration, signup drops the guest `next` intent, and the anonymous quote/inert email control in `HomePage.tsx` are not acceptable evidence or functionality.

- [x] **Show real product screenshots**
  - Files: `src/modules/landing/components/HomePage.tsx`, `public/images/search-desktop.png`, `public/images/search-mobile.png`
  - Do: Preserve the shipped real screenshots and their explicit dimensions; do not replace them
    with a generated mockup.
  - Verify: `test -f public/images/search-desktop.png && test -f public/images/search-mobile.png && rg -n 'search-(desktop|mobile)\.png' src/modules/landing/components/HomePage.tsx`.

- [x] **Provide open signup and guest search routes**
  - Files: `src/routes/auth/sign-up.tsx`, `src/modules/auth/components/SignUpPage.tsx`, `src/routes/_landing/explore/index.tsx`
  - Do: Keep open email/password signup and unrestricted guest `/explore` as the two supported entry
    paths.
  - Verify: Start `pnpm dev`, then confirm `/auth/sign-up` and `/explore` return 200 and render their
    primary forms.

- [ ] **Create the claim and funnel baseline inventory**
  - Files: `docs/conversion-baseline.md`, `src/routes/__root.tsx`, `src/modules/landing/components/HomePage.tsx`, `src/shared/components/Footer.tsx`, `src/routes/_landing/explore/index.tsx`
  - Do: List every quantitative/product/customer claim, exact evidence path, owner, and review date;
    record funnel definitions, eligibility, unknown baseline values, minimum sample/time gate, and
    guardrails before editing the experience.
  - Verify: A reviewer can trace every retained claim to current code or dated operational evidence;
    unknown metrics are labeled unknown rather than zero.

- [ ] **Define closed conversion event and metric contracts**
  - Files: `src/shared/lib/conversion-events.ts`, `src/shared/lib/conversion-events.test.ts`
  - Do: Implement the zod union from the spec, reject unknown keys and forbidden PII/content fields,
    deduplicate event identities, and implement aggregate rates plus 95% confidence intervals with
    explicit insufficient-sample output.
  - Verify: `pnpm test -- src/shared/lib/conversion-events.test.ts` covers valid events, unknown keys,
    bad timestamps, duplicates, zero denominators, and insufficient samples.

- [ ] **Add privacy-minimized event storage**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0001_conversion_events.sql`, `drizzle/meta/_journal.json`, `drizzle/meta/0001_snapshot.json`
  - Do: Add an append-only `conversion_events` table containing event name, surface, random session
    UUID, variant, server day, and timestamps only; add the idempotency unique index and indexes used
    by aggregate reports/expiry. Do not store user id, email, IP, query, referrer, or user agent.
  - Verify: `pnpm db:migrate` applies on a copy of current schema; rerunning is safe; schema inspection
    shows only allowlisted columns and constraints.

- [ ] **Implement consent-aware non-blocking ingestion**
  - Files: `src/routes/api/analytics/conversion.ts`, `src/shared/lib/conversion-client.ts`, `src/shared/lib/conversion-client.test.ts`, `src/shared/lib/rate-limit.ts`, `src/shared/components/CookieBanner.tsx`, `src/routes/_landing/legal/cookies.tsx`, `src/routes/_landing/legal/privacy.tsx`, `src/shared/lib/env.ts`
  - Do: Add `CONVERSION_EVENTS_ENABLED`; emit only after explicit analytics consent; validate the
    closed schema, timestamp window, idempotency, and rate limit server-side. Telemetry failures are
    swallowed after local diagnostic logging and never block product actions. Update disclosures
    before enabling collection.
  - Verify: Unit/integration tests prove opt-in writes once, essential-only writes never, malformed
    and over-limit requests fail, and navigation proceeds when the endpoint returns 500/disabled.

- [ ] **Add retention and aggregate reporting**
  - Files: `src/shared/lib/conversion-retention.ts`, `src/shared/lib/conversion-retention.test.ts`, `src/routes/api/admin/analytics/run-retention.ts`, `src/routes/api/admin/metrics/conversion.ts`, `src/routes/_dashboard/admin/metrics.tsx`
  - Do: Delete raw events older than 30 days through an authenticated admin HTTP-cron endpoint;
    expose admin-only aggregates with raw counts, rates, confidence intervals, date/variant filters,
    and insufficient-sample state. Never render raw session IDs.
  - Verify: Tests cover admin/non-admin access, boundary dates, idempotent repeated cleanup, aggregate
    math, empty ranges, and absence of raw identifiers in API/UI responses.

- [ ] **Instrument the baseline without changing UX**
  - Files: `src/modules/landing/components/HomePage.tsx`, `src/routes/_landing/explore/index.tsx`, `src/modules/auth/components/SignUpPage.tsx`, `src/shared/lib/conversion-client.ts`
  - Do: Emit the spec events from stable semantic actions with `variant='baseline'`; count one landing
    view per session and successful server-confirmed outcomes only. Do not count impressions before
    analytics consent or duplicate StrictMode/hydration effects.
  - Verify: `pnpm test:conversion -- --grep "baseline events"` matches an exact expected event list
    for both journeys and produces no duplicates after reload/hydration.

- [ ] **Collect and approve the real baseline**
  - Files: `docs/conversion-baseline.md`
  - Do: After at least 14 days/1,000 eligible sessions (or four weeks at lower traffic), record UTC
    window, commit, consent-eligible sessions, raw numerator/denominator, rate, confidence interval,
    missing-event health, and exclusions. If insufficient, mark it inconclusive and continue
    collecting without inventing targets.
  - Verify: Independent recomputation from admin aggregates matches the document.

- [ ] **Expose the guest-value path in the hero without coercion**
  - Files: `src/modules/landing/components/HomePage.tsx`, `test/test-conversion.mjs`
  - Do: Keep one visually primary signup CTA, add a visible secondary link/button to `/explore`, and
    demote any in-page explainer to tertiary text. Preserve DOM/focus order and equivalent access at
    375px and desktop.
  - Verify: `pnpm test:conversion -- --grep "hero hierarchy"` checks destinations, labels, focus
    order, target size, and both variants.

- [ ] **Remove unsupported and dead conversion surfaces**
  - Files: `src/modules/landing/components/HomePage.tsx`, `src/routes/__root.tsx`, `src/shared/components/Footer.tsx`, `docs/conversion-baseline.md`, `test/test-conversion.mjs`
  - Do: Remove the anonymous paid-for-it quote, inert `Join Alerts` email control, unsupported
    aggregate rating JSON-LD, stale public `/search` structured-data URL, and inaccurate source
    claims. Replace only with evidence-backed product proof and existing links; add no waitlist or
    invented customer names/logos.
  - Verify: `rg -n 'paid for itself|Beta user|aggregateRating|Join Alerts|urlTemplate.*\/search' src`
    returns no matches and the browser smoke finds no email capture on `/`.

- [ ] **Preserve guest search intent safely through signup**
  - Files: `src/routes/auth/sign-up.tsx`, `src/modules/auth/components/SignUpPage.tsx`, `src/routes/_landing/explore/index.tsx`, `src/shared/lib/safe-next.ts`, `src/shared/lib/safe-next.test.ts`, `test/test-conversion.mjs`
  - Do: Parse an allowlisted internal `next`, carry it through successful signup/onboarding, and
    restore the authenticated `/search` query. Reject absolute, protocol-relative, encoded, and
    non-allowlisted paths to prevent open redirects.
  - Verify: Unit tests cover allowed/rejected targets; runtime smoke proves `/explore?q=rust` reaches
    the matching authenticated search and malicious `next` falls back to onboarding.

- [ ] **Optimize screenshot delivery without fabricating proof**
  - Files: `src/modules/landing/components/HomePage.tsx`, `public/images/search-desktop.png`, `public/images/search-mobile.png`, `test/test-conversion.mjs`
  - Do: Generate responsive optimized variants through the repository's normal image tooling,
    declare intrinsic sizes/srcset, eagerly load only the actual LCP image, and keep truthful alt
    text. Do not commit a generated dashboard mockup as product evidence.
  - Verify: Browser assertions confirm no layout shift from missing dimensions and the performance
    audit stays within `plans/audit-performance-qa/spec.md` budgets.

- [ ] **Add fixed experiment assignment and treatment instrumentation**
  - Files: `src/shared/lib/conversion-variant.ts`, `src/shared/lib/conversion-variant.test.ts`, `src/modules/landing/components/HomePage.tsx`, `src/shared/lib/env.ts`
  - Do: Add `VITE_LANDING_CONVERSION_VARIANT`, stable per-session random assignment, explicit
    baseline/treatment overrides for tests, and the same event semantics in both arms. Never use
    identity, protected traits, acquisition data, or query text for assignment.
  - Verify: Tests prove stability, configured allocation, deterministic override, and no variant
    change after navigation/reload within a session.

- [ ] **Add conversion browser smoke and CI gate**
  - Files: `test/test-conversion.mjs`, `package.json`, `.github/workflows/quality.yml`
  - Do: Add `test:conversion`; run both variants and consent modes against a built preview with
    fixture DB. Check hero/final CTAs, guest search, signup, preserved intent, event payloads,
    telemetry-failure resilience, responsive layout, accessibility, and flag rollback.
  - Verify: `pnpm lint && pnpm type-check && pnpm test && pnpm build && pnpm test:conversion` exits 0
    locally and in the pull-request workflow.

- [ ] **Run controlled rollout and record the decision**
  - Files: `docs/conversion-baseline.md`, `plans/audit-conversion/spec.md`, `plans/audit-conversion/plan.md`, `plans/audit-conversion/tasks.md`
  - Do: Release instrumentation-only, then treatment at 10%, 50%, and (only after the decision gate)
    100%. Record checkpoint dates, revisions, counts, intervals, guardrails, incidents, final choice,
    and flag state. Stop immediately on a privacy, signup, accessibility, or search guardrail breach.
  - Verify: The final report is independently reproducible from aggregate endpoints and the chosen
    flag state passes the full staging runtime smoke.
