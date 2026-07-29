# Production Readiness Audit (tasks)

> **Status**: `blocked` — every task waits on a live deployment plus elapsed time or a human decision
> **Depends on**: all of `plans/phase-1/`, deployed
> **Blocks**: dropping the Beta label
> **Reality check**: moved verbatim from five phase-1 plans on 2026-07-29. Not one of them is code, and
> not one can be closed by a session — which is exactly why they were making "phase-1 is 100% done at
> MVP launch" impossible to ever answer yes.

Order matters only where a task names its predecessor. The two waiting periods in Phase 3 run in
parallel deliberately: queued, they add three weeks for no reason.

## Phase 1 — measured on the day of the deployment

- [ ] **Add read-only production smoke and record the baseline**
  - Files: `.github/workflows/quality.yml`, `docs/operations/performance-baseline.md` (new)
  - Do: Run the read-only smoke against the deployed app after a release and record the first
    measured numbers as the baseline the budgets are held against.
  - Verify: `pnpm assets:check` passes against the recorded numbers, `pnpm test:lighthouse` produces
    a report for the deployed URL, and `docs/operations/performance-baseline.md` states the date, the
    commit and each measured number — so a later regression can be attributed to a change rather
    than argued about.
  - Operator: needs a deployed release to measure. The numbers must come from production, not from a
    local run, or the baseline is meaningless.
  - Moved from `plans/phase-1/49-audit-performance-qa` on 2026-07-29 — it waits on production, not on work.

- [ ] **Verify production and close the audit**
  - Files: `docs/visual-system.md`
  - Do: Compare the deployed app against the committed baselines once, record the result, and close
    the audit.
  - Verify: `pnpm test:visual` run against the deployed URL reports zero unexpected diffs, and
    `docs/visual-system.md` records the date, the commit and any accepted difference with its reason.
  - Operator: needs a deployed release to compare against.
  - Moved from `plans/phase-1/50-audit-visual-system` on 2026-07-29 — it waits on production, not on work.


## Phase 2–3 — start the clocks, then wait

- [ ] **Collect and approve the real baseline** — not started, by design
  - Files: `docs/conversion-baseline.md` (§4 is where the numbers go)
  - Do: Deploy with `CONVERSION_EVENTS_ENABLED=true`, let it run, then write the measured
    signup-conversion rate into §4 with the exact window it covers and the session count behind it.
  - Verify: §4 states a number, its date range and its eligible-session count, and the count is
    ≥1,000 over ≥14 days. Anything less is not a baseline and must not be recorded as one.
  - Operator: needs ≥14 days of real production traffic and ≥1,000 eligible sessions. No agent can
    shorten this, and inventing a plausible number is the specific failure §4 exists to prevent.
  - Moved from `plans/phase-1/51-audit-conversion` on 2026-07-29 — it waits on production, not on work.

- [ ] **Approve and run seven-day canary**
  - Files: `docs/operations/public-enrichment-source-register.md` (the approval and the daily record)
  - Operator: needs a human approval and seven days of elapsed time. Neither can be produced by an
    agent, and the canary cannot be shortened.
  - Do: approved legal/source register; GitHub only; admin then internal users;
    manual jobs; batch 2.
  - Verify: spec SLOs, no critical policy/privacy/isolation incident, zero blocked-host
    requests, and zero overdue retention rows.
  - Moved from `plans/phase-1/42-stealth-scraping` on 2026-07-29 — it waits on production, not on work.


## Phase 4 — the decisions the waiting was for

- [ ] **Run controlled rollout and record the decision** — not started, by design
  - Files: `docs/conversion-baseline.md`
  - Do: With the baseline recorded, stage the change to 10%, then 50%, then 100%, recording the
    measured rate at each stage, and write the keep-or-revert decision with its reasoning.
  - Verify: `docs/conversion-baseline.md` shows a rate per stage against the same baseline window and
    an explicit decision. A rollout with no recorded decision is an untracked change.
  - Operator: depends on the baseline task above and on real production traffic; the keep-or-revert
    call is the maintainer's.
  - Moved from `plans/phase-1/51-audit-conversion` on 2026-07-29 — it waits on production, not on work.

- [ ] **Enable manual customer refresh**
  - Files: `.env.production.example` (`ENRICHMENT_ENABLED`), `docs/operations/public-enrichment-source-register.md`
  - Operator: turning this on for customers is a product decision that follows the canary approval.
  - Preconditions: every prior task complete and canary approved.
  - Do: expand audience without enabling scheduled refresh or new connectors.
  - Verify: one authorized production job reaches terminal state and renders attributed,
    non-expired evidence with redacted logs.
  - Moved from `plans/phase-1/42-stealth-scraping` on 2026-07-29 — it waits on production, not on work.

- [ ] **Roll out source by source without weakening enforcement** — not attempted
  - Files: `docs/operations/` (the rollout record), `.env.production.example`
    (`PROFILE_REMOVAL_ENABLED`)
  - Do: Turn the flag on for one source at a time, and after each one confirm that suppression is
    still enforced on every other source — the failure mode this guards against is a per-source
    rollout quietly becoming a global exemption.
  - Verify: after each source, `pnpm vitest run tests/unit/security` passes and a suppressed profile
    from an already-enabled source is still absent from search and from the public profile route.
  - Operator: turning `PROFILE_REMOVAL_ENABLED` on in production is a maintainer decision, and the
    kill switch is the safety net until it is made. Both tasks above are meaningful only once that
    decision exists — do not enable it to make a test pass.
  - Moved from `plans/phase-1/52-audit-trust` on 2026-07-29 — it waits on production, not on work.


## Phase 5 — close the gate

- [ ] **Drop the Beta label**
  - Files: `src/modules/landing/components/HomePage.tsx`, `src/routes/_landing/index.tsx`,
    `plans/phase-5/01-production-readiness-audit/spec.md`
  - Do: Remove the Beta wording from the public surface, and set this plan's status to `implemented`
    in all three files.
  - Verify: no open task remains above; every one of them cites evidence dated after the production
    deployment; and `pnpm exec playwright test tests/e2e/public-content.spec.ts` still passes with the
    wording changed.
  - Operator: the maintainer decides the label comes off. It is the statement that the seven gates
    above are closed, so it must not precede them.
