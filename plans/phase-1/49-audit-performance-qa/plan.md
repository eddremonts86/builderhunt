# Delivery Plan: Performance and QA Release Gate

> **Status**: `partially-implemented`
> **Depends on**: [`public-landing-pages`](../45-public-landing-pages/spec.md)
> **Blocks**: [`audit-trust`](../52-audit-trust/spec.md), [`audit-visual-system`](../50-audit-visual-system/spec.md)
> **Reality check**: Explicit image dimensions, eager/lazy hints, font preconnects, Vitest, and
> standalone Playwright scripts already exist. The missing work is active-asset optimization, a
> supported browser config, quantitative budgets, and CI/deploy enforcement.

## Delivery sequence

### Phase 0 — Restore a truthful static baseline

Replace the stale pricing renderer contract with the real `PLAN_PRICING` shape (`monthly`,
`annual`, `label`, and `features`) as specified by `pricing-optimization`, and remove the unused
`url` assignment in `test/test-landing-redesign.mjs`. Run lint and type-check without suppressions;
the QA workflow must begin from zero known errors rather than allowlisting the current failures.

### Phase 1 — Make the harness deterministic

Add the QA scripts and pinned tooling to `package.json`/`pnpm-lock.yaml`, then create
`playwright.config.ts`, `.lighthouserc.cjs`, and `e2e/fixtures/`. Reuse `scripts/db/seed-admin.ts`
and Docker Compose Postgres/Redis; isolate the QA database name and fixture user. Document exact
local and CI commands in `README.md`. This phase proves the harness can boot a production build
before adding assertions.

### Phase 2 — Establish critical runtime coverage

Implement anonymous navigation/link/console tests and one authenticated dashboard smoke test in
`e2e/`. Mock external source and email boundaries, not BuilderHunt routes. Use semantic selectors
or `data-testid` values and deterministic fixture cleanup. Store traces/screenshots only after a
failure and redact auth headers from reporters.

### Phase 3 — Optimize the actual transfer path

Add `sharp`, the deterministic optimizer, generated AVIF/WebP variants, and byte/dimension checks.
Update only the screenshot markup in `HomePage.tsx`; verify the selected current source with the
browser Performance API at 390, 768, and 1440 px. Self-host the two current font families and
remove the remote font origins from `__root.tsx`.

### Phase 4 — Add quantitative performance gates

Run Lighthouse CI against the preview with fixed runs, URLs, throttling, and assertions. Record the
pre-change and post-change medians in the pull request artifact; budgets in the spec remain the
merge gate. If a budget cannot be met, fix the responsible resource or submit a separately reviewed
budget change with evidence—do not silently loosen assertions.

### Phase 5 — Gate deployment and smoke production

Add a pull-request quality workflow. Add the same quality job as a prerequisite to the existing
deploy job in `.github/workflows/deploy.yml`, then append read-only post-deploy health/content
checks. Enable required-check branch protection outside the repository and record its screenshot or
API output in the release ticket.

## CI gate matrix

| Gate        | Command                        | Pass condition                                           |
| ----------- | ------------------------------ | -------------------------------------------------------- |
| Static      | `pnpm lint && pnpm type-check` | exit 0, no ignored new error                             |
| Unit        | `pnpm test`                    | exit 0                                                   |
| Assets      | `pnpm assets:check`            | generated tree clean; every byte/dimension budget passes |
| Build       | `pnpm build`                   | exit 0                                                   |
| Browser     | `pnpm test:e2e`                | Chromium critical suite passes with zero retries         |
| Performance | `pnpm test:lighthouse`         | all Lighthouse assertions pass across three runs         |
| Runtime     | post-deploy curl/browser smoke | health and four critical routes match status/content     |

## Risks and controls

| Risk                                          | Control                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Native `sharp` output changes across versions | Pin the package and runtime, commit outputs, and fail CI on a generated diff.                    |
| External APIs/fonts make tests flaky          | Self-host fonts and intercept source/email requests with deterministic fixtures.                 |
| Lighthouse variance causes false failures     | Fixed CI runner and throttling, three runs, median assertions, no local score promises.          |
| Auth traces expose secrets                    | Disposable account, failure-only retention, reporter redaction, no production environment.       |
| Quality and deploy workflows race             | Make deploy explicitly depend on its quality job; do not rely on two independent push workflows. |

## Rollout

1. Land the harness in non-blocking/report-only mode and collect three CI baselines.
2. Land asset/font changes and confirm browser-selected resources plus Lighthouse deltas.
3. Make static/unit/build/browser/asset checks required, then Lighthouse.
4. Add the deploy dependency and read-only production smoke once `master` is green.

## Rollback

Revert `HomePage.tsx` to the original PNG sources and restore the remote font links if rendering
regresses; generated assets can remain harmlessly deployed. Temporarily switch only Lighthouse to
report-only when runner variance is proven, while keeping lint, type, unit, build, browser, and
post-deploy health gates mandatory. Reverting the deploy dependency requires an incident note and
explicit maintainer approval.

## Completion evidence

Attach the clean `pnpm qa` output, selected-resource/transfer report for all three viewports,
three-run Lighthouse summary, CI run URL, and post-deploy smoke output. Update all three headers to
`implemented` only after those artifacts exist.
