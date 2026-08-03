# Tasks: Evidence-led conversion audit

> **Status**: `partially-implemented` — full instrumentation stack + real UX fixes shipped
> 2026-07-26; real baseline collection and staged rollout explicitly not started (see below).
> **Depends on**: [`public-landing-pages`](../45-public-landing-pages/spec.md), [`legal-and-compliance`](../04-legal-and-compliance/spec.md)
> **Blocks**: nothing
> **Reality check (2026-07-26)**: The anonymous quote/inert email/aggregateRating items were
> already removed by `audit-trust` earlier this session (commit `bdf77f1`) — re-verified absent,
> not re-done. What was actually still true of this plan's reality check: no analytics
> implementation existed, the hero omitted guest exploration, signup silently dropped the guest
> `next` intent, and both the hero copy and the root JSON-LD's `SearchAction` still made a
> narrower/broken claim than the real product. All fixed this pass.

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

- [x] **Create the claim and funnel baseline inventory**
  - Files: `docs/conversion-baseline.md`
  - Do: Full claim inventory (7 rows, each with evidence/review date), funnel definitions for both
    journeys, the event→surface map, metric list, and the explicit "baseline unknown, not yet
    collected" status.
  - Verify: reviewer-traceable; every retained claim links to code or a dated fix in this pass.

- [x] **Define closed conversion event and metric contracts**
  - Files: `src/shared/lib/conversion-events.ts`, `tests/unit/shared/lib/conversion-events.test.ts`
  - Do: `parseConversionEvent` — `.strict()` zod schema (rejects unknown keys) plus a `(name,
    surface)` → allowed-surfaces map (a plain union can't express "this action is invalid from that
    position," so this is enforced separately); `isWithinClockSkewWindow` (±5 min);
    `computeConversionRate` — Wilson score 95% CI, `insufficientSample` below n=30 (raw rate still
    reported).
  - Verify: `pnpm vitest run tests/unit/shared/lib/conversion-events.test.ts` — 19/19 passing (valid
    events, unknown keys, invalid name/surface combos, bad timestamps, bad variant, PII-shaped
    extra fields, clock-skew edges, CI math at extreme proportions and small/large samples).

- [x] **Add privacy-minimized event storage**
  - Files: `src/shared/lib/db/schema.ts` (`conversionEvents` table), `drizzle/0061_sleepy_ma_gnuci.sql` (create), `drizzle/0062_conversion_events_grants.sql` (custom GRANT migration)
  - Do: `id, name, surface, session_id, variant, occurred_at, server_day, created_at` only — no user
    id/email/IP/query/referrer/UA. Unique `(session_id, name, surface, variant)` for idempotency;
    check constraints mirroring the app-level enums. `builderhunt_app` gets INSERT-only,
    `builderhunt_worker` gets SELECT+DELETE (retention), `builderhunt_platform` gets SELECT
    (aggregate reporting) — confirmed via `psql \dp conversion_events`.
  - Verify: `pnpm db:migrate` applied cleanly; `node scripts/db/verify-migration-integrity.mjs
    --write` → 63 migrations; grants confirmed live.

- [x] **Implement consent-aware non-blocking ingestion**
  - Files: `src/routes/api/analytics/conversion.ts`, `tests/unit/routes/api/analytics/conversion.test.ts`, `src/shared/lib/conversion-client.ts`, `tests/unit/shared/lib/conversion-client.test.ts`, `src/shared/lib/env.ts` (`CONVERSION_EVENTS_ENABLED`, default `false`), `.env.example`, `src/shared/components/CookieBanner.tsx`
  - Do: `trackConversionEvent` reads `CookieBanner`'s own `bh_cookie_consent` record — no second
    consent store — and no-ops without explicit `analytics: true`. Server validates schema, clock
    skew, and rate-limits by `getRateLimitId` (IP/UA-derived, never persisted) before writing;
    every failure path (disabled flag, malformed body, DB error) returns `200 {recorded: false}`,
    never a 5xx, so a dropped event never blocks the page. Cookie banner's Analytics toggle
    description updated to state what it *would* record (still off by default) — the legal
    cookies/privacy pages weren't touched since they already truthfully say analytics isn't
    currently in use, which stays true with the flag off.
  - Verify: `pnpm vitest run tests/unit/routes/api/analytics/conversion.test.ts` (6/6: disabled flag,
    invalid event, clock skew, rate limit, write failure, happy path) and
    `conversion-client.test.ts` (9/9: consent gating, session id stability, dedup, swallowed
    rejection).

- [x] **Add retention and aggregate reporting**
  - Files: `src/shared/lib/conversion-retention.ts`, `tests/unit/shared/lib/conversion-retention.test.ts`, `src/routes/api/admin/analytics/run-retention.ts`, `src/routes/api/admin/metrics/conversion.ts`, `src/shared/lib/repositories/conversion-events.ts`, `tests/unit/shared/lib/repositories/conversion-events.test.ts`
  - Do: `runConversionEventRetention` (30-day window, named constant) → `deleteExpiredConversionEvents`,
    exposed via the same `tryCronPrincipal ?? requirePlatformAdminPrincipal` dual-auth pattern as
    `api/admin/billing/reconcile.ts`. `api/admin/metrics/conversion.ts` returns 6 named funnel
    metrics (primary + 5 secondary) with raw counts/rate/CI95/insufficientSample per
    date-range+variant query — never a raw session id.
  - Deviation: no dedicated `_dashboard/admin/metrics.tsx` UI panel added — the existing admin
    metrics page renders a different, already-large in-process/DB metrics blob
    (`api/admin/metrics/index.ts`); given the size of this plan already, a UI panel for this new
    endpoint is deferred rather than bolted on hastily. The API itself is complete and
    live-verified.
  - Verify: `pnpm vitest run tests/unit/shared/lib/repositories/conversion-events.test.ts` — 7/7 passing,
    disposable-DB integration (idempotency, distinct-session counting, day-range/variant
    separation, retention delete + idempotent re-run). `conversion-retention.test.ts` — 2/2.

- [x] **Instrument the baseline without changing UX** (folded into the hero/explore/signup tasks below — same commits)

Moved to [`plans/phase-5/01-production-readiness-audit`](../../phase-5/01-production-readiness-audit/tasks.md)
on 2026-07-29, deliberately not as a checkbox: at least 14 days of real traffic and 1,000 eligible sessions. It waits on a live
deployment and on time passing, so keeping it here made this plan permanently unfinishable while the
work it describes was complete. Phase 5 is the MVP/Beta-to-production gate and is where it belongs.


- [x] **Expose the guest-value path in the hero without coercion**
  - Files: `src/modules/landing/components/HomePage.tsx`
  - Do: Added a secondary "Try it without an account" → `/explore` link next to the existing
    primary sign-up CTA; demoted "See how it works" from a `btn-secondary` to a tertiary
    underlined text link (per spec: "keep as a text-level tertiary anchor if retained"). Both new
    and existing CTAs instrumented (`hero_signup_click`/`hero_explore_click`, surface `hero`; the
    final-CTA section's own sign-up button fires the same event with surface `final_cta`).
  - Deviation: no dedicated `tests/regression/test-conversion.mjs` Playwright script — out of scope per this
    session's standing no-new-e2e-files rule. Verified live in-browser instead (see below).

- [x] **Remove unsupported and dead conversion surfaces** — already done by `audit-trust`
  - Confirmed via `rg -n 'paid for itself|Beta user|aggregateRating|Join Alerts' src` — no matches.
  - **New this pass**: fixed the stale public `/search` structured-data URL (the plan's own
    remaining callout) — `__root.tsx`'s `SearchAction` JSON-LD pointed at `/search`, which requires
    an authenticated session; a crawler or anonymous visitor following it got nothing. Now points
    at `/explore?q={search_term_string}`. Also fixed the "GitHub, Reddit, Hacker News and DEV.to"
    phrasing (read as an exhaustive 4-source list) in `HomePage.tsx`'s hero paragraph and
    `__root.tsx`'s meta description + FAQ JSON-LD — all three now say "...and more", matching the
    honest phrasing already established on `/explore` and the bento grid's own "+ 11 more sources".

- [x] **Preserve guest search intent safely through signup**
  - Files: `src/shared/lib/safe-next.ts`, `tests/unit/shared/lib/safe-next.test.ts`, `src/shared/lib/post-onboarding-next.ts`, `tests/unit/shared/lib/post-onboarding-next.test.ts`, `src/routes/auth/sign-up.tsx` (`validateSearch`), `src/modules/auth/components/SignUpPage.tsx`, `src/routes/onboarding/welcome.tsx`, `src/routes/onboarding/search.tsx`
  - Do: `parseSafeNext` allows only an exact `/search` path (+ query string), rejecting absolute/
    protocol-relative/encoded-bypass/backslash targets. `SignUpPage.tsx` validates `next` on
    successful signup and stashes it (sessionStorage) for onboarding to consume; both onboarding
    "Skip" exit points (`welcome.tsx`, `search.tsx`) now check for and `navigate({ href })` to the
    stashed destination instead of always going to `/dashboard` (`href`, not `to` — `next` carries
    a query string). Not wired into `onboarding/save.tsx`/`success.tsx` (no `navigate({ to:
    '/dashboard' })` call sites there to begin with) — an honest scope cut, not an oversight.
  - **Real bug found and fixed**: this `next` param was already being passed by `/explore`'s
    sign-up CTA but silently dropped — `SignUpPage.tsx` never read it, so every guest-search user
    lost their query on signup regardless of what the link claimed.
  - Verify: `pnpm vitest run tests/unit/shared/lib/safe-next.test.ts tests/unit/shared/lib/post-onboarding-next.test.ts`
    (11/11, 2/2). **Live end-to-end in the real browser**: real query on `/explore` → real signup →
    real onboarding → clicked "Skip" → landed on `/search?q=<the original query>&mode=keyword`,
    confirmed via the actual URL after navigation. Also confirmed all 5 real funnel events
    (`landing_view`, `explore_search_complete`, `explore_signup_click`, `signup_submit`,
    `signup_complete`) landed in the real `conversion_events` table in the correct order, and the
    admin aggregate endpoint (`edd_admin@local.com` session) read them back correctly. Test data
    (one throwaway user/org, 5 rows) cleaned up afterward; `CONVERSION_EVENTS_ENABLED` (added to
    local `.env` only for this live check) reverted to unset/default-off.

- [x] **Optimize screenshot delivery without fabricating proof** — already done by `audit-performance-qa`
  - Confirmed: `HomePage.tsx` already serves responsive AVIF/WebP `<picture>` sources with explicit
    `width`/`height` and `fetchPriority` on the LCP image (commit `e1423b1`, earlier this session).
    Nothing left to do here.

- [x] **Add fixed experiment assignment and treatment instrumentation**
  - Files: `src/shared/lib/conversion-variant.ts`, `tests/unit/shared/lib/conversion-variant.test.ts`, `.env.example`
  - Do: `VITE_LANDING_CONVERSION_TREATMENT_PCT` (default 10) sets the random-draw allocation;
    `VITE_LANDING_CONVERSION_VARIANT=baseline|treatment` force-overrides it (manual QA /
    deterministic tests). `getStableVariant` draws once per session and caches in sessionStorage —
    stable across reload/navigation. Every tracked event carries this `variant`.
  - Deviation: the treatment *experience* itself (a second hero/copy variant to A/B) isn't built —
    correctly so: Phase A of this plan ships instrumentation with `baseline` fixed for every
    session per the spec's own phasing (`docs/conversion-baseline.md` §4), and there's no baseline
    window yet to design a treatment against. The assignment mechanism is ready for when that
    phase starts.
  - Verify: `pnpm vitest run tests/unit/shared/lib/conversion-variant.test.ts` — 5/5 passing.

- [x] **Add conversion browser smoke and CI gate** — done 2026-08-03
  - Files: `tests/regression/test-conversion.mjs` (new), `package.json` (a `test:conversion` script),
    `.github/workflows/quality.yml`
  - Do: Write the browser smoke that walks the guest-value path to signup and asserts each
    conversion event fires once, add it as `pnpm test:conversion`, and add that step to the quality
    workflow.
  - Verify: `pnpm test:conversion` passes locally and fails when an event is removed from the hero
    path; then the CI job runs it and the workflow is red on that same deliberate removal.
  **Done 2026-08-03: `tests/regression/test-conversion.mjs`, `pnpm test:conversion`, wired into
  `quality.yml` after the accessibility gate.** Both barriers named below are lifted — the maintainer
  green-lit Playwright files and workflow edits.

  Four checks, and the order is deliberate. **No consent, no telemetry comes first**: a broken funnel is a
  business problem, telemetry sent without consent is a legal one, and if only one property can hold it must be
  that one. Then `landing_view` exactly once — not "at least once", because a duplicate view doubles a
  denominator and halves every rate computed from it, which is worse than no measurement because it looks
  plausible. Then the hero CTA firing `hero_signup_click` exactly once. Then every request carrying a parseable
  body.

  It is a gate rather than more unit tests because the logic is already covered (56 tests, nine files) and the
  *wiring* is not: whether the landing page still calls `trackConversionEvent` after a refactor. That failure
  breaks no page and fails no other test — it just makes the funnel look like a product problem, weeks later,
  to someone who concludes the hero does not convert.

  **It demonstrably fails on broken instrumentation.** The first version located the CTA as
  `a[href*="/auth/sign-up"]` and matched the *navigation bar's* sign-up link — an uninstrumented element — and
  reported "fired 0×" for a hero that works. It now locates by the visible copy, which is also the stronger
  assertion: it fails if the button is renamed out from under its instrumentation.

  The CI step sits after the a11y gate because both need the preview server started earlier in that job; an
  earlier position has no server to talk to, which is where it was first placed by mistake.

  - Original reason it was open: the standing rule at the time barred new Playwright files, and editing the CI
    workflow needs the maintainer's go-ahead. Every piece of logic this would smoke-test is already
    covered by unit and integration tests (56 across 9 files) plus a live browser walkthrough, so
    this is a regression guard, not new coverage.

Moved to [`plans/phase-5/01-production-readiness-audit`](../../phase-5/01-production-readiness-audit/tasks.md)
on 2026-07-29, deliberately not as a checkbox: the conversion baseline, and real production traffic. It waits on a live
deployment and on time passing, so keeping it here made this plan permanently unfinishable while the
work it describes was complete. Phase 5 is the MVP/Beta-to-production gate and is where it belongs.

