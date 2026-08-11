# Tasks: Performance and QA Release Gate

> **Status**: `implemented` — asset pipeline done; tests/e2e/Lighthouse/CI-gate tasks explicitly
> out of scope for this session (see notes below), not attempted.
> **Depends on**: [`public-landing-pages`](../../implemented/45-public-landing-pages/spec.md)
> **Blocks**: [`audit-trust`](../../implemented/52-audit-trust/spec.md), [`audit-visual-system`](../../implemented/50-audit-visual-system/spec.md)
> **Reality check**: (2026-07-26) Re-verified before starting: `pnpm type-check` and
> `pnpm exec eslint . --quiet` were both already clean (0 errors) — the 11 `PLAN_PRICING` errors
> and unused-`url` lint error described below were already fixed by the time this plan was picked
> up (by `pricing-optimization`/related work). Fonts were also already self-hosted (`@font-face`
> WOFF2 + `font-display: swap` in `globals.css`, no `fonts.googleapis.com` reference anywhere) —
> that task was done too. The screenshot pipeline was the one real, unimplemented gap; it's done
> now (see below). Original 2026-07-20 reality check text kept below for history.
>
> **Original reality check (2026-07-20)**: `playwright` is already a dev dependency and image
> dimensions/loading hints are present in `HomePage.tsx`. There is no configured
> Playwright/Lighthouse suite or quality gate, and the active desktop/mobile screenshots total
> about 1.7 MiB. Fresh checks on 2026-07-20 show 11 pricing type errors and one unused-variable
> ESLint error that must be cleared first.

- [x] **Clear the known static-analysis baseline** — already clean on arrival (2026-07-26)
  - Verify: `pnpm type-check && pnpm exec eslint . --quiet` — both exit 0.

- [x] **Generate and enforce responsive screenshot assets**
  - Files: `scripts/optimize-images.ts` (new), `scripts/check-performance-budgets.mjs` (new), 10 generated `public/images/search-{desktop,mobile}-*.{avif,webp}` files
  - Do: `sharp`-based generator producing the exact size matrix from `spec.md` (desktop 640/1280/1920, mobile 360/720). Quality tuned (AVIF 72, WebP 85 — screenshots are text-heavy, low quality blurs UI labels) with real headroom under every budget. Metadata stripping is automatic (sharp never copies EXIF/ICC unless `.withMetadata()` is called, which this doesn't). Source PNGs kept as `<picture>` fallback.
  - Verify: `pnpm assets:build && pnpm assets:check` — real output, e.g. desktop-1920.avif 73 KiB vs. 300 KiB budget, mobile-720.webp 51 KiB vs. 150 KiB budget. Confirmed the checker actually fails: renamed a generated file away, reran, got two real `FAIL:` lines and exit code 1, restored it, reran clean.
  - Deviation: `git diff --exit-code -- public/images` as a CI dirty-check wasn't wired into any workflow — that's part of the CI-gate task, out of scope this pass (see below).

- [x] **Serve only the appropriate hero resource**
  - Files: `src/modules/landing/components/HomePage.tsx`
  - Do: Both hero images now use `<picture>` (AVIF source, WebP source, PNG `<img>` fallback) with the real generated srcset/sizes. `fetchPriority="high"` added to the LCP image (React 19 types it natively — no cast needed). Decorative mobile-crop picture unchanged in loading strategy (`loading="lazy"` inside a `hidden lg:block` ancestor).
  - Verify: live in-browser — `getEntriesByType('resource')` (a real per-navigation log, not a possibly-stale devtools view) at a 375px viewport shows **zero** requests for any `search-mobile-*` asset, confirming the "not fetched below `lg`" requirement holds. Screenshot confirms both hero images render crisply via AVIF `currentSrc`.
  - Deviation: no `tests/e2e/performance-resources.spec.ts` — that's a new Playwright file, forbidden this session. Verified by hand instead (see above); exact `sizes` breakpoint selection under different device-pixel-ratios wasn't exhaustively checked without real device/Lighthouse throttling.

- [x] **Self-host the existing fonts** — already done on arrival (2026-07-26)
  - Verify: `rg fonts.googleapis fonts.gstatic src/routes/__root.tsx src/shared/styles/globals.css` — no matches. `globals.css` already has self-hosted `@font-face` blocks for Inter and JetBrains Mono with `font-display: swap`.

> **Reality check**: (2026-07-27) every "not attempted" reason below was a *session rule*, not a
> technical blocker — `playwright.config.ts` being a reserved file, and CI/CD edits needing the
> maintainer's confirmation. Both were lifted on 2026-07-27. Contrasting the remaining tasks
> against the repository also found that most of the infrastructure they describe already exists:
>
> - **The production-preview harness is already in CI.** `.github/workflows/quality.yml` builds,
>   runs `drizzle-kit migrate`, seeds the admin, starts `vite preview` under the four real
>   least-privilege roles, waits on `/api/health`, and runs a gate against it. It was built for the
>   accessibility gate; Lighthouse only needs to hang off it.
> - **The Playwright harness exists** at `tests/e2e/harness/` (auth, browser, cache, clock,
>   database, env, fakes, fixtures, ids, roles, server), with 83 tests covering the harness itself.
> - **The dependencies are installed**: `playwright`, `@axe-core/playwright`, `sharp`,
>   `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono` (the plan looked for
>   `@fontsource/jetbrains-mono`, a different package name).
>
> Genuinely missing: `@lhci/cli`, `.lighthouserc.cjs`, and a `test:lighthouse` script.

- [x] **Wire deterministic QA commands and dependencies** — done (2026-07-27)
  - `assets:build`/`assets:check` and `sharp` were already in place; `test:e2e` and both font
    packages turned out to be installed too. `@lhci/cli` and `test:lighthouse` land with the
    Lighthouse task below, which is where they belong.

- [x] **Create the production-preview browser harness** — already existed (2026-07-27)
  - Not built by this plan: `quality.yml`'s accessibility gate already stands up a production
    preview against real roles, and `tests/e2e/harness/` provides the browser-side fixtures.

- [x] **Cover critical public and authenticated paths** — done (2026-07-27)
  - Files: `.github/workflows/quality.yml`, `scripts/ci/local-quality.sh`
  - The specs already existed; CI ran one file of nineteen. `pnpm test:e2e --workers=1` now runs
    all of them. Enabling them immediately caught three shipped regressions — see the
    `fix: three defects the unrun e2e specs were already catching` commit.
  - Verify: full suite green locally at `--workers=1`, 4.7 minutes.

- [x] **Enforce Lighthouse budgets** — done (2026-07-27)
  - Files: `.lighthouserc.cjs`, `package.json`, `pnpm-lock.yaml`, `.github/workflows/quality.yml`
  - Three mobile-throttled audits of `/` against the production preview the accessibility gate
    already stands up — same build, same least-privilege roles, never `vite dev`.
  - Verify (measured medians, local preview): performance 1.00 (budget ≥0.90), accessibility 0.96
    (≥0.95), LCP 1135 ms (≤2500), CLS 0 (≤0.10), TBT 0 ms (≤200), transfer 496 KiB (≤900).
    **Accessibility has only 0.01 of headroom** — the first regression there will fail the gate,
    which is the point, but expect it to be the one that trips first.

- [x] **Gate pull requests and deployment** — done (2026-07-27)
  - Both e2e and Lighthouse are ordinary steps of the `Quality` job, so a failure blocks it, and
    `deploy.yml` already runs only on a successful `Quality` `workflow_run` — a regression now
    stops the deploy instead of being reported after it.
  - Note: this appeared twice in the plan as two separate open items; the duplicate is folded in.

Moved to [`plans/phase-5/01-production-readiness-audit`](../../phase-5/01-production-readiness-audit/tasks.md)
on 2026-07-29, deliberately not as a checkbox: numbers measured against a deployed release. It waits on a live
deployment and on time passing, so keeping it here made this plan permanently unfinishable while the
work it describes was complete. Phase 5 is the MVP/Beta-to-production gate and is where it belongs.


## Summary for this pass (2026-07-26)

Of nine tasks, three were already done when picked up (static-analysis baseline, fonts — the
plan's own reality check was stale), three are done now (screenshot pipeline: generator, budget
checker, `<picture>` markup), and three remain genuinely undone — but all three are
Playwright/Lighthouse/CI-pipeline work that this session's standing constraints put out of reach
(no new e2e files; CI/CD pipeline edits need explicit user sign-off). That's a real, honest gap,
not a shortcut — flagging it here rather than declaring the plan complete.

## Correction (2026-08-11): Lighthouse does not gate the deploy

The task above says "Both e2e and Lighthouse are ordinary steps of the `Quality` job, so a failure
blocks it, and `deploy.yml` already runs only on a successful `Quality` `workflow_run` — a regression
now stops the deploy". That was true when it was written on 2026-07-27. It is not true now, and the
change was deliberate.

Commit `91755f5ae` (2026-08-09) created `.github/workflows/advisory.yml` and moved Lighthouse there,
along with the screenshot diff. Its header states the reason: `continue-on-error` kept those checks out
of a run's *conclusion* but not out of its *duration*, and `deploy.yml` triggers on
`workflow_run: completed` — so a five-minute Lighthouse pass still stood between a green build and a
deploy. Moving them to their own workflow is what actually takes them off that path.

So today: `pnpm test:lighthouse` and `.lighthouserc.cjs` both exist, Lighthouse runs on every push to
master in **Advisory**, and it runs as a blocking step in `pnpm ci:local`. What it does *not* do is stop
a deploy. A performance regression leaves a red mark on the commit, which Advisory's header argues is
the entire point of running these — but somebody reading this plan should not believe the deploy is
gated on it.

The budgets themselves are unchanged and still enforced where Lighthouse runs: performance ≥ 0.90,
accessibility ≥ 0.95, LCP ≤ 2500 ms, CLS ≤ 0.10, TBT ≤ 200 ms, transfer ≤ 900 KiB.

## Closed 2026-08-11

The `partially-implemented` status was written on 2026-07-26 and said the tests/e2e/Lighthouse/CI-gate
tasks were "explicitly out of scope for this session, not attempted". The plan's own reality check, dated
one day later, supersedes it: "every 'not attempted' reason below was a *session rule*, not a technical
blocker… Both were lifted on 2026-07-27." All nine tasks are checked, the last four dated 2026-07-27.

Verified today rather than taken on trust: `.lighthouserc.cjs` exists, `pnpm test:lighthouse` runs
`lhci autorun`, and it runs both as a blocking step of `pnpm ci:local` and on every push to master in
`advisory.yml`. The one claim that had gone stale — that a Lighthouse failure stops the deploy — is
corrected in the dated note above it: `advisory.yml` was created on 2026-08-09 specifically to take
those checks off the deploy's path.
