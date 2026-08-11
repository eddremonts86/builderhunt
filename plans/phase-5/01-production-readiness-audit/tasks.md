# Production Readiness Audit (tasks)

> **Status**: `blocked` — every task waits on a live deployment plus elapsed time or a human decision
> **Depends on**: all of `plans/phase-1/`, deployed
> **Blocks**: dropping the Beta label
> **Reality check**: moved verbatim from five phase-1 plans on 2026-07-29, and seven more added on
> 2026-08-05 (see Phase 4b). Not one of them is code, and not one can be closed by a session — which is
> exactly why they were making "phase-1 is 100% done at MVP launch" impossible to ever answer yes.
> **Phase-1 reached zero open tasks on 2026-08-05**, which is what this plan existed to make possible.

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
  - Moved from `plans/implemented/phase-1/49-audit-performance-qa` on 2026-07-29 — it waits on production, not on work.

- [ ] **Verify production and close the audit**
  - Files: `docs/visual-system.md`
  - Do: Compare the deployed app against the committed baselines once, record the result, and close
    the audit.
  - Verify: `pnpm test:visual` run against the deployed URL reports zero unexpected diffs, and
    `docs/visual-system.md` records the date, the commit and any accepted difference with its reason.
  - Operator: needs a deployed release to compare against.
  - Moved from `plans/implemented/phase-1/50-audit-visual-system` on 2026-07-29 — it waits on production, not on work.


## Phase 2–3 — start the clocks, then wait

- [ ] **Collect and approve the real baseline** — not started, by design
  - Files: `docs/conversion-baseline.md` (§4 is where the numbers go)
  - Do: Deploy with `CONVERSION_EVENTS_ENABLED=true`, let it run, then write the measured
    signup-conversion rate into §4 with the exact window it covers and the session count behind it.
  - Verify: §4 states a number, its date range and its eligible-session count, and the count is
    ≥1,000 over ≥14 days. Anything less is not a baseline and must not be recorded as one.
  - Operator: needs ≥14 days of real production traffic and ≥1,000 eligible sessions. No agent can
    shorten this, and inventing a plausible number is the specific failure §4 exists to prevent.
  - Moved from `plans/implemented/phase-1/51-audit-conversion` on 2026-07-29 — it waits on production, not on work.

- [ ] **Approve and run seven-day canary**
  - Files: `docs/operations/public-enrichment-source-register.md` (the approval and the daily record)
  - Operator: needs a human approval and seven days of elapsed time. Neither can be produced by an
    agent, and the canary cannot be shortened.
  - Do: approved legal/source register; GitHub only; admin then internal users;
    manual jobs; batch 2.
  - Verify: spec SLOs, no critical policy/privacy/isolation incident, zero blocked-host
    requests, and zero overdue retention rows.
  - Moved from `plans/implemented/phase-1/42-stealth-scraping` on 2026-07-29 — it waits on production, not on work.

- [ ] **Approve the Solutions source and domain register**
  - Files: `docs/operations/solutions-source-register.md`, `docs/operations/solutions-domain-policy.md`
  - Do: For every source the Solutions catalog can ingest, record access method, terms/robots/privacy
    review, allowed fields, geography, owner, refresh/retention/deletion, rate limits, and kill
    switch. Explicitly deny physical and high-risk regulated domains.
  - Verify: security/privacy/product reviewers sign every source before it is enabled in production.
  - Operator: needs a human legal/privacy judgement per source. The code ships every scraping source
    **disabled by default** with a per-source toggle in Admin → Solutions sources, so enabling one is
    an explicit maintainer act and this register is the record of why it was allowed. An agent can
    build the switch; it cannot decide that scraping a given site is lawful.
  - Moved from `plans/implemented/phase-1/43-solutions-intelligence` Phase 0 on 2026-08-01 at the maintainer's
    direction — it waits on a human decision, not on work, and blocking the whole module's
    engineering on it was stopping real progress.


## Phase 4 — the decisions the waiting was for

- [ ] **Run controlled rollout and record the decision** — not started, by design
  - Files: `docs/conversion-baseline.md`
  - Do: With the baseline recorded, stage the change to 10%, then 50%, then 100%, recording the
    measured rate at each stage, and write the keep-or-revert decision with its reasoning.
  - Verify: `docs/conversion-baseline.md` shows a rate per stage against the same baseline window and
    an explicit decision. A rollout with no recorded decision is an untracked change.
  - Operator: depends on the baseline task above and on real production traffic; the keep-or-revert
    call is the maintainer's.
  - Moved from `plans/implemented/phase-1/51-audit-conversion` on 2026-07-29 — it waits on production, not on work.

- [ ] **Enable manual customer refresh**
  - Files: `.env.production.example` (`ENRICHMENT_ENABLED`), `docs/operations/public-enrichment-source-register.md`
  - Operator: turning this on for customers is a product decision that follows the canary approval.
  - Preconditions: every prior task complete and canary approved.
  - Do: expand audience without enabling scheduled refresh or new connectors.
  - Verify: one authorized production job reaches terminal state and renders attributed,
    non-expired evidence with redacted logs.
  - Moved from `plans/implemented/phase-1/42-stealth-scraping` on 2026-07-29 — it waits on production, not on work.

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
  - Moved from `plans/implemented/phase-1/52-audit-trust` on 2026-07-29 — it waits on production, not on work.


- [ ] **Decide the public indexing posture for /blog, /changelog and /roadmap**
  - Files: none in the repo — the per-surface directives come from the admin panel's indexing
    settings, which is what `public/robots.txt`'s own header comment says. Recording the outcome
    belongs in `plans/implemented/phase-1/54-waitlist-launch/tasks.md` Phase 1.
  - Do: choose whether those three surfaces are indexable at launch. Today all three are
    `noindex, nofollow` and `Disallow`ed for `*`, `GPTBot`, `ClaudeBot`, `PerplexityBot` and
    `Google-Extended`, so `/sitemap.xml` correctly omits `/blog` — 30 published posts that no search
    engine or AI crawler can see. Then submit `/sitemap.xml` in Google Search Console and Bing
    Webmaster Tools.
  - Verify: `curl -s $APP_URL/sitemap.xml | grep -c '<loc>.*/blog'` matches the decision;
    `curl -s $APP_URL/blog | grep -o 'name="robots" content="[^"]*"'` agrees with it; GSC reports the
    sitemap as "Success".
  - **Moved here from `plans/implemented/phase-1/54-waitlist-launch` on 2026-08-05, on Edd's instruction
    ("dejalo como esta, ya lo cambio yo en el futuro, pasa esa tarea a la phase-5, cuando vayamos
    live").** It is a marketing decision that needs a live launch to make sense, and it is the last
    thing keeping plan 54's prerequisite gate open. The other four items in that gate pass. Nothing
    is broken: the sitemap and the robots directives already agree with each other, and the only
    defensible failure mode — submitting a sitemap without having decided — is avoided by leaving it
    unsubmitted.

## Phase 4b — moved in from phase-1 on 2026-08-05

Seven tasks that wait on a live deployment, a clock, or a person with a browser. Same instruction as the
two sibling plans: *the product launches when phase-5 finishes.* Nothing here is code — every one of
them was verified as far as engineering can take it, and each note below says exactly how far that was.

- [ ] **Observe one soak period after the PG18 cutover**
  - Files: `docs/operations/deploy-runbook.md` (where the observation is recorded)
  - Do: Watch for one soak period: error rate, `/api/health`, semantic-search p95, `pg_stat_io` deltas,
    and that each HTTP-cron worker completes one tick. Unpause any scheduled job that was paused.
  - Verify: p95 of `POST /api/search/semantic` is no worse than the pre-cutover baseline, measured the
    same way; no role-authentication errors in the logs; every worker's next tick logs a normal
    completion; and the next 03:00 Coolify backup lands from the **pg18** resource.
  - Operator: nothing was frozen, so there is nothing to unfreeze — what remains is the waiting. The
    03:00 schedule was created on the PG18 resource on 2026-08-05 and there is no v1 API endpoint to
    trigger a backup, so the first one cannot exist before the following morning.
  - Moved from `plans/implemented/phase-1/03-postgres-18-upgrade` Phase 4 on 2026-08-05 — it waits on a clock.

- [ ] **Retire the pg16 resource on a schedule, not immediately**
  - Files: `docs/operations/deploy-runbook.md`
  - Do: Stop (do not delete) the pg16 resource and its volume, and record the retention date after which
    it is deleted. Do not start the retention clock until the first successful backup from pg18 exists.
  - Verify: the runbook states the retention date and that the volume still exists until then.
  - Operator: Edd set the window on 2026-08-05 — **stop pg16 seven days after the first successful pg18
    backup lands.** So this is a decision already made plus seven days of waiting. pg16 is intentionally
    still running, un-repointed, as the only rollback.
  - The doc half is done: the runbook's image line, its "status: not executed" block and its
    troubleshooting row all named `pg16` after the cutover had happened, and were corrected 2026-08-05.
  - Moved from `plans/implemented/phase-1/03-postgres-18-upgrade` Phase 4 on 2026-08-05 — it waits on a clock.

- [ ] **Provision the Product Hunt Developer Token and re-verify the v2 field names**
  - Files: Coolify environment (`PRODUCTHUNT_TOKEN`), no repository change
  - Do: Create a Developer Token at `api.producthunt.com/v2/docs` under a real Product Hunt account,
    set `PRODUCTHUNT_TOKEN` on the app service, then introspect the v2 schema and compare the field
    names the connector assumes — `topics(query:)`, `posts(topic:, order:)` and the maker fields.
  - Verify: `pnpm sources:probe` reports producthunt answering; the introspected field names match
    `src/lib/sources/producthunt.ts`, or the connector is corrected to match them.
  - Operator: needs a person with a Product Hunt account, which an agent must not create.
  - Why it matters rather than being a formality: the connector was built from the published v2 docs
    instead of live introspection, so its field names are honest-but-unverified. A silent rename
    upstream shows up as an empty result set, not as an error — the source simply stops finding
    people and nothing says so.
  - Moved from `plans/implemented/phase-1/18-producthunt-integration` on 2026-08-11, where it sat as a
    checked task whose own text said "not done, needs a human". It gates a source going live, not
    engineering.

- [ ] **Walk the authenticated app against the PG18 production database**
  - Files: none (manual)
  - Do: Sign in and walk dashboard, keyword search, `POST /api/search/semantic`, alerts, exports, and one
    admin page.
  - Verify: no 500s; semantic search returns results rather than `503 semantic_unavailable`; a
    tenant-scoped read returns rows through RLS as `builderhunt_app`, proving grants and policies survived
    provisioning.
  - Operator: needs a person to sign in on the live site, which an agent must not do.
  - The unauthenticated half is already verified: all 13 public routes return 200 and `/api/status`
    reports `db: ok, redis: ok`. Semantic ordering was compared at the SQL level instead of through the
    route (which needs a session): the same anchor embedding over the same `ORDER BY embedding <=> $vec`
    shape the HNSW index serves returned the **30 nearest neighbours identical in order and distance to 8
    decimals** on pg16 and pg18.
  - **This is the same walk as the task below.** One browser pass closes both; they are two plans
    describing one action.
  - Moved from `plans/implemented/phase-1/03-postgres-18-upgrade` Phase 3 on 2026-08-05 — it waits on a person.

- [ ] **Smoke-test the core authenticated funnel on production**
  - Files: none (manual)
  - Do: In order — fresh email → sign up → land on `/onboarding/welcome` → complete the 3-step tour → run
    a search → track 3 builders → `/exports` CSV download → `/pricing` → "Subscribe to Pro" → tick the
    disclosure → Stripe Checkout opens (complete it with a test card if the deployment is in test mode,
    otherwise cancel at the Checkout page) → `/settings/billing/return` → `/settings/billing` shows the
    subscription `active` and the organization's entitlement changed → `/settings/privacy` → request
    account deletion → cancel the deletion and confirm the account is usable again.
  - Verify: every step succeeds, and the subscription and deletion-request rows appear and behave.
  - Operator: step 1 requires creating an account and entering a password on the live site, which an agent
    must not do.
  - **Rewritten 2026-08-05**: two steps went through a surface that no longer exists. The legacy
    `plans`/`plan_requests` surface was retired on 2026-08-03/04 (commit `8c4b1e2` and its two
    predecessors), `/admin/plan-requests` is gone, and `src/` holds zero references to `plan_requests`, so
    "request upgrade → verify it appears in `/admin/plan-requests`" could not be performed at all.
    Upgrades go through Stripe Checkout, which the billing E2E suite already covers in test mode — this
    task's value is the *human* pass over the same path on the real deployment.
  - Moved from `plans/implemented/phase-1/54-waitlist-launch` Phase 2 on 2026-08-05 — it waits on a person.

- [ ] **Deploy enrichment dark to production**
  - Files: `.env.production.example` (`ENRICHMENT_ENABLED`),
    `docs/operations/public-enrichment-source-register.md`
  - Do: Deploy the migration and code with `ENRICHMENT_ENABLED=false`; validate the exact runtime roles,
    indexes, RLS, health, and zero enrichment network traffic.
  - Verify: a production smoke passes without enabling any customer-visible behaviour.
  - Operator: needs a production deploy plus the Coolify environment. An agent must not enable this.
  - **Preconditions**: the legal copy review in
    [`02-legal-and-commercial-approvals`](../02-legal-and-commercial-approvals/tasks.md). The other
    precondition — the runtime adversarial matrix — closed 2026-08-05 at 20/20, and its evidence is in the
    source register.
  - **A configuration divergence was found and corrected 2026-08-05**: `ENRICHMENT_ENABLED` was `true` in
    the production Coolify env while both gating tasks were still open. Measured before saying anything
    stronger: 614 `job_runs` with an `enrichment%` key over nine days, all `succeeded`, with
    `processed_count` summing to **0**, zero `enrichment_evidence` rows, and one `enrichment_jobs` row
    from before the window. So the worker had been waking on schedule and finding nothing to process — a
    configuration divergence from the plan, not an unapproved crawl. Set to `false` on the production row
    and the container redeployed so the value is in effect rather than only stored; the preview row stays
    `true`, since preview is the non-production environment the adversarial matrix requires.
  - Moved from `plans/implemented/phase-1/42-stealth-scraping` Phase 7 on 2026-08-05 — it waits on a deploy.

- [ ] **Roll out the interview flags in dependency order**
  - Files: `docs/operations/interview-runtime-verification.md`, `.env.production.example`, production
    deployment configuration (external, no secrets in repo)
  - Do: Enable internal calendar; then projections; scheduling; uploads; Stripe/credits; brief; closed
    Chrome transcription; contextual questions and report. Hold each stage through its agreed observation
    window and roll back on any privacy, cost or correctness threshold breach.
  - Verify: a production synthetic monitor and a consented internal workflow pass per stage; dashboards,
    alerts, the disable path, backup/restore, purge, and provider-region checks all remain green.
  - Operator: a staged production rollout with observation windows — elapsed time plus a maintainer's
    judgement at each gate.
  - Moved from `plans/implemented/phase-1/44-calendar-scheduling-interview-intelligence` Phase 12 on 2026-08-05.

- [ ] **Close the interview Definition of Done with runtime evidence**
  - Files: `docs/operations/interview-runtime-verification.md`,
    `plans/implemented/phase-1/44-calendar-scheduling-interview-intelligence/{spec,plan,tasks}.md`
  - Do: Attach dated evidence for email-to-booking, DST, race safety, scan/extraction/brief, a real
    30-minute bilingual live interview, reconnect/correction/report, credits/payment/refund/
    reconciliation, purge/export/delete, tenant and private-user isolation, restore, dashboards, and
    rollback. Mark tasks implemented only from evidence.
  - Verify: no unchecked task, no waived acceptance criterion, no unresolved high or critical finding, and
    every production flag intended for general availability enabled intentionally.
  - Operator: needs real consented use of the live product, including an actual bilingual interview. It is
    the last item of the interview plan by construction.
  - Moved from `plans/implemented/phase-1/44-calendar-scheduling-interview-intelligence` Phase 12 on 2026-08-05.

## Phase 4d — invisible partials, found and moved in on 2026-08-05

Three tasks that were marked `[~]` rather than `[ ]`, so **every open-task count in the repository missed
them** — `grep -c '^- \[ \]'` does not see a tilde, and that is how "phase-1 has zero open tasks" was true
and incomplete at the same time. Found by auditing for the marker instead of trusting the count.

- [ ] **Configure Docker log rotation on the VPS**
  - Files: `docs/runbook.md` §5 (the exact `log-opts` JSON and its verification command are already there)
  - Do: apply the documented `log-opts` to the Docker daemon on the host and verify it took effect.
  - Verify: the runbook's own verification command reports the configured limits on the running daemon.
  - Operator: root SSH on the Hetzner VPS.
  - Moved from `plans/implemented/phase-1/02-production-infrastructure` on 2026-08-05.

- [ ] **Run the live Denmark canary and staged rollout**
  - Files: `docs/operations/stripe-live-rollout.md`, `docs/operations/stripe-live-readiness.md`
  - Do: verify the live catalog read-only, enable webhook ingestion, then an internal account, then one
    voluntary Danish customer, then a percentage rollout. Observe a successful charge, a refund, and a
    payout with FX.
  - Verify: the readiness checklist and canary evidence are complete, and rollback disables new mutations
    while reads, webhooks, refunds and reconciliation keep working.
  - Operator: real money — a live catalog, a real customer, a real charge, a real refund, a real payout.
    Seven of the original nine observations were split out and closed on 2026-08-04; these are the two no
    engineering can produce.
  - Moved from `plans/implemented/phase-1/30-stripe-billing-platform` on 2026-08-05.

- [ ] **Run the real browser capture beta verification**
  - Files: `docs/operations/interview-runtime-verification.md`
  - Do: execute the written runbook — the ten-cell browser/platform matrix, the session script (crosstalk,
    two languages, noise, a deliberate 20-second network cut, pause/resume, device change), the seven
    measurements against their targets, and the four DevTools artifact inspections.
  - Verify: every cell of the matrix has a result, every measurement a number, and each of the four
    inspections a recorded observation.
  - Operator: needs hardware and human participants. The procedure itself is complete (`d6b1833`).
  - Moved from `plans/implemented/phase-1/44-calendar-scheduling-interview-intelligence` on 2026-08-05.

## Phase 4c — cohort rollouts moved in on 2026-08-05

- [ ] **Roll out self-managed profiles by cohort**
  - Files: `docs/operations/` (the rollout record), the production environment's
    `self_managed_profiles_enabled` value
  - Do: With the flag and its kill switch already built and deployed off, raise the audience 5% → 25% →
    100% in seven-day cohorts, recording at each stage what changed in signup, profile completion and
    public-profile traffic.
  - Verify: each cohort holds its full seven days; the kill switch is exercised at least once from
    production rather than assumed; and the record states the keep-or-revert decision with its reasoning.
  - Operator: 21 days of clock in production. No amount of engineering shortens it.
  - Moved from `plans/phase-2/07-perfiles-autogestionados` task 8.5 on 2026-08-05. Building the flag and
    documenting the kill switch stayed in phase 2 — only the waiting moved, which is the whole distinction
    this phase exists to draw.

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
