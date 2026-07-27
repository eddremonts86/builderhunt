# Tasks: Performance and QA Release Gate

> **Status**: `partially-implemented` — asset pipeline done; e2e/Lighthouse/CI-gate tasks explicitly
> out of scope for this session (see notes below), not attempted.
> **Depends on**: [`public-landing-pages`](../public-landing-pages/spec.md)
> **Blocks**: [`audit-trust`](../audit-trust/spec.md), [`audit-visual-system`](../audit-visual-system/spec.md)
> **Reality check (2026-07-26)**: Re-verified before starting: `pnpm type-check` and
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
  - Deviation: no `e2e/performance-resources.spec.ts` — that's a new Playwright file, forbidden this session. Verified by hand instead (see above); exact `sizes` breakpoint selection under different device-pixel-ratios wasn't exhaustively checked without real device/Lighthouse throttling.

- [x] **Self-host the existing fonts** — already done on arrival (2026-07-26)
  - Verify: `rg fonts.googleapis fonts.gstatic src/routes/__root.tsx src/shared/styles/globals.css` — no matches. `globals.css` already has self-hosted `@font-face` blocks for Inter and JetBrains Mono with `font-display: swap`.

> **Reality check (2026-07-27)**: every "not attempted" reason below was a *session rule*, not a
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

- [ ] **Cover critical public and authenticated paths**
  - Files: `tests/e2e/*.spec.ts`, `.github/workflows/quality.yml`
  - Reality: 19 spec files and 192 tests already cover public content, feeds/OG, consent, auth and
    sessions, dashboard navigation, onboarding and semantic search — but CI runs only
    `team-accounts.spec.ts` (10 tests). The work here is enabling what exists, not writing it.
  - Verify: CI executes the enabled specs and the job's duration stays defensible.

- [ ] **Enforce Lighthouse budgets**
  - Files: `.lighthouserc.cjs`, `package.json`, `pnpm-lock.yaml`
  - Do: Run three mobile-throttled production-preview audits for `/`; assert performance ≥0.90, accessibility ≥0.95, LCP ≤2.5 s, CLS ≤0.10, TBT ≤200 ms, and transfer ≤900 KiB.
  - Verify: `pnpm test:lighthouse` passes three consecutive CI runs; lowering any assertion below the measured result makes the command fail.

- [ ] **Gate pull requests and deployment**
  - Files: `.github/workflows/quality.yml`, `.github/workflows/deploy.yml`
  - Do: Make the e2e and Lighthouse steps required, so a regression blocks the deploy rather than
    reporting after it. `deploy.yml` already runs only on a successful `Quality` `workflow_run`, so
    this is about which steps `Quality` contains.
  - Note: this appeared twice in the plan as two separate open items; the duplicate is folded in here.

- [ ] **Add read-only production smoke and record the baseline**
  - Files: `.github/workflows/quality.yml`, `docs/operations/`
  - Do: Run the read-only smoke against the deployed app after a release and record the first
    measured numbers as the baseline the budgets are held against.

## Summary for this pass (2026-07-26)

Of nine tasks, three were already done when picked up (static-analysis baseline, fonts — the
plan's own reality check was stale), three are done now (screenshot pipeline: generator, budget
checker, `<picture>` markup), and three remain genuinely undone — but all three are
Playwright/Lighthouse/CI-pipeline work that this session's standing constraints put out of reach
(no new e2e files; CI/CD pipeline edits need explicit user sign-off). That's a real, honest gap,
not a shortcut — flagging it here rather than declaring the plan complete.
