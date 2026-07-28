# Performance and QA Release Gate

> **Status**: `partially-implemented`
> **Depends on**: [`public-landing-pages`](../44-public-landing-pages/spec.md)
> **Blocks**: [`audit-trust`](../51-audit-trust/spec.md), [`audit-visual-system`](../49-audit-visual-system/spec.md)
> **Reality check**: The active hero is `src/modules/landing/components/HomePage.tsx`, not
> `src/routes/_landing/index.tsx`, and it renders `public/images/search-desktop.png` (983 KiB,
> 2774×2110) plus `search-mobile.png` (749 KiB, 1212×2380). Both have dimensions and loading
> hints, and Google Fonts already uses `display=swap`; Playwright is installed but there is no
> `playwright.config.ts`, QA script, Lighthouse config, or pre-deploy quality job.
> Fresh verification on 2026-07-20 also finds `pnpm type-check` failing with 11 invalid
> `PLAN_PRICING` field accesses in `src/routes/_landing/pricing.tsx`, while
> `pnpm exec eslint . --quiet` reports one error: the unused `url` variable in
> `test/test-landing-redesign.mjs`.

## Problem

The production UI has useful one-off browser scripts under `test/`, but no deterministic PR
gate. The landing page sends an almost 1 MiB PNG for its likely LCP element, depends on a
third-party font stylesheet, and has no checked-in Web Vitals budgets. The only GitHub workflow,
`.github/workflows/deploy.yml`, can deploy `master` without running lint, type-check, unit tests,
browser tests, or Lighthouse.

The old audit targeted the unused `dashboard_mockup.jpg`, proposed a nonexistent waitlist test,
and treated a Google stylesheet preload as a font preload. Those are not implementation goals.
The current static-analysis failures are release-gate prerequisites, not an acceptable baseline to
grandfather into CI.

## Outcome

Create a reproducible release gate that:

- serves responsive modern versions of the screenshots actually rendered above the fold;
- removes the Google Fonts network dependency while retaining the existing system-font fallback;
- exercises critical anonymous and authenticated routes in Chromium;
- measures a production build with fixed Lighthouse conditions; and
- prevents deployment when static, unit, browser, asset, or performance gates fail.

## Scope and non-goals

In scope: `/`, `/pricing`, `/explore`, `/legal/privacy`, `/status`, sign-up navigation, a seeded
authenticated dashboard smoke path, internal-link integrity, image delivery, and deploy gating.

Out of scope: inventing a waitlist, testing third-party sites, requiring every external source to
be healthy, promising identical Lighthouse numbers on developer laptops, or changing product UI.
Performance telemetry/APM belongs to `production-infrastructure`; this plan supplies deterministic
CI and post-deploy smoke evidence.

## Technical contract

### Asset pipeline

`scripts/optimize-images.ts` uses pinned `sharp` to generate deterministic, stripped-metadata
assets from the two active screenshots:

- `public/images/search-desktop-{640,1280,1920}.{avif,webp}`
- `public/images/search-mobile-{360,720}.{avif,webp}`

`HomePage.tsx` uses `<picture>` with AVIF then WebP sources and keeps the original PNG only as a
fallback. The desktop image retains its verified 2774:2110 ratio, `loading="eager"`,
`fetchPriority="high"`, and `decoding="async"`; the decorative mobile crop remains lazy and is
not fetched below the `lg` breakpoint. `scripts/check-performance-budgets.mjs` fails when a
generated file is missing, dimensions drift, or any encoded file exceeds its budget:

- desktop 640/1280/1920: AVIF ≤ 90/180/300 KiB; WebP ≤ 130/250/420 KiB;
- mobile 360/720: AVIF ≤ 55/100 KiB; WebP ≤ 80/150 KiB;
- total initial image transfer on a 390 px viewport ≤ 150 KiB and on 1440 px ≤ 300 KiB.

Generated files are committed so production builds do not require native image tooling. CI reruns
the generator and fails on a dirty diff, proving source and generated assets agree.

### Fonts

Replace the remote stylesheet in `src/routes/__root.tsx` with locally emitted WOFF2 assets from
`@fontsource-variable/inter` and `@fontsource/jetbrains-mono` imported by
`src/shared/styles/globals.css`. Load only Inter 400–800 and JetBrains Mono 400/500, declare
`font-display: swap`, and preload only the Inter Latin file used above the fold. Browser tests
assert that `/` makes no request to `fonts.googleapis.com` or `fonts.gstatic.com`.

### Browser and Lighthouse harness

`playwright.config.ts` starts `pnpm preview --host 127.0.0.1 --port 4173` against a completed
production build. `e2e/critical-paths.spec.ts` verifies page status, the primary sign-up route,
native FAQ toggling, no console/page errors, and all same-origin anchors. It skips `mailto:`,
fragments, downloads, logout/mutation links, and external origins; it uses GET rather than HEAD so
TanStack routes are tested as users load them. `e2e/dashboard.smoke.spec.ts` uses a deterministic
seed account created by existing DB tooling and never production credentials.

`.lighthouserc.cjs` runs three times against `/` using the production preview and median results.
CI budgets are: performance ≥ 0.90, accessibility ≥ 0.95, LCP ≤ 2.5 s, CLS ≤ 0.10, INP/TBT proxy
≤ 200 ms, and total transfer ≤ 900 KiB on Lighthouse mobile throttling. The release objective is
p75 production LCP ≤ 2.5 s, CLS ≤ 0.10, and INP ≤ 200 ms; CI lab results are a regression proxy,
not a claim about field percentiles.

### Security, privacy, and AI isolation

Tests use `.env.test` placeholders, a disposable database, non-personal fixture profiles, and
intercept outbound email/source traffic. CI must never read production secrets. It runs with
`AI_DISABLED=true` once that flag exists; no test may invoke Chrome AI or MiniMax, record prompts,
or include real profile data in screenshots/traces. Playwright traces are retained only on failure
for seven days and must not contain session cookies in uploaded logs.

## Acceptance criteria

- `pnpm qa` runs lint, type-check, unit tests, asset budgets, build, Chromium E2E, and Lighthouse
  from a clean checkout with documented local prerequisites.
- The active hero selects a responsive AVIF/WebP and satisfies the byte/viewport budgets above.
- Browser evidence shows no Google Fonts requests, unexpected console errors, broken same-origin
  links, horizontal overflow, or failed critical navigation.
- Pull requests run quality checks; `master` deployment cannot start unless the same gates pass.
- After deploy, `/api/health`, `/`, `/pricing`, and `/auth/sign-up` return expected status/content;
  a failure marks the deployment failed without mutating user data.

## Success measures

- 100% of releases are gated by the quality job and post-deploy smoke test.
- Median CI Lighthouse meets every declared budget for three consecutive runs.
- Critical browser tests have no retries in the merge gate; retry-only passes are visible and fail
  until the source of flakiness is removed.
- The optimized desktop image cuts its current 983 KiB transfer by at least 65% at 1440 px.
