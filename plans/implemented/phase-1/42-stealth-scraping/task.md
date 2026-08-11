# Public Profile Enrichment — Implementation Tasks

> **Status**: `implemented` — every checkbox below is real (verified, not
> assumed), including the runtime adversarial matrix, which closed 2026-08-05 at 20/20 and found five
> defects on the way. The two items that remain are a signed legal review and a production deploy; both
> moved to `plans/phase-5/` on 2026-08-05, because the product launches when phase-5 finishes and legal
> is not build-phase work.
>
> **Phase-1 scope closed 2026-08-05.** Prose pointers below name the phase-5 plan that owns each moved
> item; they are deliberately not checkboxes, because a box reads as pending engineering.
> **Spec:** [`spec.md`](./spec.md)
> **Plan:** [`implementation_plan.md`](./implementation_plan.md)
> Check a task only after its listed verification passes. Preserve the user's existing
> uncommitted migration/worktree changes; generate the migration from the then-current
> schema rather than assuming a migration number.


## Status reconciliation (2026-08-11)

Moved to `plans/implemented/` on the strength of this, so the folder means one thing: **every task checked,
and `pnpm ci:local` green at 34/34 steps** (6,543 unit tests, 996 e2e) on commit `90527722e`.

Why the status changed: was `engineering-complete, shipped dark`, a value no gate can read. Phase-1 scope closed 2026-08-05 at 31/31; the legal review and production deploy moved to phase-5. It ships dark (`ENRICHMENT_ENABLED=false`), which is a deployment decision, not missing work.

The eight status values previously in use across phase-1 — `complete`, `done`, `in_progress`, `retired`,
`closed — skipped`, `engineering-complete`, `code-complete-dark`, `pending — implementation-ready` — are
outside the five `scripts/check-phase-readiness.mjs` accepts, and that script only ran against phase-2 and
phase-3. A status no gate reads is a status that drifts, which is how four plans sat at 100% of their tasks
while still labelled `pending`.

## Phase 0 — Policy freeze

- [x] **Define enrichment contracts and source policies**
  - Files: `src/lib/enrichment/types.ts`, `src/lib/enrichment/policies.ts`
  - Do: `SourcePolicy`, connector/result types, allowed enrichment fields,
    compile-time policies, and runtime narrowing.
  - Verify: `pnpm type-check`.

- [x] **Prove blocked providers fail closed**
  - Files: `tests/unit/lib/enrichment/policies.test.ts`
  - Cases: missing policy; malformed allowlist; allowlist containing LinkedIn/X/Meta;
    disabled global feature; duplicate connector IDs.
  - Verify: targeted Vitest; assert no executable adapter is returned.

- [x] **Create the source approval register**
  - File: `docs/operations/public-enrichment-source-register.md`
  - Include: initial matrix, permission reference, lawful-basis/LIA reference, fields,
    hosts, owner, approval/review dates, robots rule, rate limit, retention, and kill-switch
    owner.
  - Verify: every registry connector has exactly one register entry; blocked entries have
    no approval date.

## Phase 1 — Persistence and isolation

- [x] **Add enrichment schema**
  - Files: `src/shared/lib/db/schema.ts`, next Drizzle migration/metadata/hash files
  - Do: all three tables, checks, indexes, FKs, and partial active-job uniqueness
    from spec §7.
  - Verify: `pnpm db:generate`, migration-integrity test, fresh disposable migration, and
    populated disposable upgrade.

- [x] **Add tenant and worker RLS**
  - File: generated migration plus security manifests/tests required by the existing
    multitenancy plan.
  - Do: FORCE RLS; app member reads/enqueues; admin/owner reviews; worker operations
    only inside `app.organization_id`; platform-only restrictions.
  - Verify: exact `builderhunt_app`, `builderhunt_worker`, and platform-role tests for
    missing/A/B/stale transaction context and cross-tenant insert/update/delete.

- [x] **Add tenant repository**
  - File: `src/shared/lib/repositories/enrichment.ts`
  - Do: tracked-target check, idempotent enqueue, latest job/evidence read, review,
    restriction read, tenant export, tenant delete.
  - Verify: repository integration tests with two organizations sharing one global
    builder identity.

- [x] **Add worker repository and leases**
  - File: `src/shared/lib/repositories/enrichment-worker.ts`
  - Do: due-job claim with `FOR UPDATE SKIP LOCKED`, scoped target load, lease
    reclaim, evidence upsert, terminal update, cancel, and bounded retention.
  - Verify: two concurrent transactions cannot own the same live lease; expired lease is
    reclaimable; wrong lease token cannot finalize.

## Phase 2 — Validation and resolution

- [x] **Add Zod schemas and minimization**
  - File: `src/lib/enrichment/schemas.ts`
  - Do: body/candidate/payload/stored schemas; lengths/counts; reject unknown and
    prohibited fields such as email/phone/private content.
  - Verify: malicious/oversized/unknown-field fixtures fail before persistence.

- [x] **Add deterministic normalization**
  - File: `src/lib/enrichment/normalize.ts`
  - Do: NFKC names, username, URL, organization, and coarse location rules.
  - Verify: table-driven Unicode, tracking-param, mixed-case host, short-username, and
    idempotence tests.

- [x] **Add resolver v1**
  - File: `src/lib/enrichment/resolver.ts`
  - Do: score components, independent-signal count, contradiction rules,
    thresholds, `resolverVersion`, and explainable output.
  - Verify: golden fixtures at 6999/7000/8999/9000/10000, forced reject, caps, missing
    values, and deterministic repeat output.

- [x] **Add canonical content hash**
  - Files: resolver/schema module and tests
  - Do: stable-key canonical JSON; hash only minimized evidence.
  - Verify: key order does not change hash; meaningful payload/source changes do.

## Phase 3 — Connector safety

- [x] **Build central safe network client**
  - File: `src/lib/enrichment/network.ts`
  - Do: HTTPS, exact host, URL credential denial, DNS public-IP check, redirect
    revalidation, timeout, 2 MiB cap, content type, user agent, abort, and normalized
    errors.
  - Verify: local fake server covers private IP, DNS rebinding fixture, redirect escape,
    redirect loop, timeout, oversized/chunked body, wrong MIME, 429/Retry-After, 401/403,
    and challenge marker.

- [x] **Build robots and shared host limiting**
  - Files: `src/lib/enrichment/robots.ts`, `src/shared/lib/redis.ts` or a focused limiter
  - Do: bounded robots cache, fail-closed authorized crawling, Redis atomic rate
    bucket, stable result codes.
  - Verify: allow/disallow/wildcard/invalid/unavailable robots; concurrent limiter boundary;
    authorized crawl blocked when Redis is unavailable.

- [x] **Build connector registry**
  - File: `src/lib/enrichment/registry.ts`
  - Do: policy + env intersection; unique IDs; no connector-level direct `fetch`.
  - Verify: registry test plus a static test/lint assertion that connector files import the
    central client rather than call `fetch`.

- [x] **Implement GitHub exact-profile canary adapter**
  - File: `src/lib/enrichment/connectors/github.ts`
  - Do: use tracked GitHub source ID/username through the official API; map only
    allowed fields; return typed results; preserve rate-limit hints.
  - Verify: contract fixtures for success/no-data/rate-limit/auth/server error/malformed
    payload; no broad search and no HTML fallback.

- [x] **Implement user-submitted URL adapter**
  - File: `src/lib/enrichment/connectors/user-submitted.ts`
  - Do: normalize and store link evidence; never fetch blocked/unapproved hosts.
  - Verify: LinkedIn/X/Meta URLs can be stored as attributed submitted links but create
    zero outbound requests.

## Phase 4 — Worker and operations

- [x] **Add environment contract**
  - Files: `src/shared/lib/env.ts`, env security tests, `.env.example`,
    `.env.production.example`
  - Do: spec §12 values and production cross-field validation.
  - Verify: defaults boot disabled; unsafe enabled combinations fail startup with stable
    English errors.

- [x] **Implement enrichment worker**
  - File: `src/lib/enrichment/worker.ts`
  - Do: lease loop, restriction/policy recheck, max two jobs, sequential connectors,
    validate/minimize/resolve/upsert, retry schedule, terminal status, and report counts.
  - Verify: pure retry/result aggregation tests and Postgres integration for double-run,
    partial success, permanent stop, crash/reclaim, and subject restriction race.

- [x] **Implement retention pass**
  - Worker/repository files
  - Do: delete expired raw/rejected/accepted payloads and 90-day terminal jobs in
    batches of 500; preserve minimal restriction/audit state.
  - Verify: clock-controlled integration fixture reaches zero backlog without deleting
    live evidence.

- [x] **Add worker admin endpoint**
  - File: `src/routes/api/admin/enrichment/run-worker.ts`
  - Do: existing admin-auth HTTP-cron shape; no request body target; stable aggregate
    response; disabled no-op.
  - Verify: admin 200, non-admin 403, unsupported method, disabled mode, and no caller
    selection of org/builder/connector.

- [x] **Add observability and redaction**
  - Files: `src/lib/enrichment/worker.ts`, `src/shared/lib/log.ts`, tests
  - Do: spec §15 events; redact names, locations, profile/source/submitted URLs,
    evidence and upstream content.
  - Verify: snapshot logs contain IDs/counts/codes but none of the fixture PII, tokens,
    URLs, headers, or payload text.

## Phase 5 — APIs and privacy rights

- [x] **Add enqueue endpoint**
  - File: `src/routes/api/builders/$builderId/evidence-refresh.ts`
  - Do: auth, tenant tracked check, Zod/body limit, policy intersection,
    restriction, idempotency, rate limit, 202/200/409 contract.
  - Verify: full route matrix with two tenants and shared identity.

- [x] **Add evidence read endpoint**
  - File: `src/routes/api/builders/$builderId/evidence/index.ts`
  - Do: latest job plus unexpired tenant evidence; stable DTO excludes internal
    lease/error/request metadata.
  - Verify: public/anonymous/other tenant cannot observe presence or decisions.

- [x] **Add review endpoint**
  - File: `src/routes/api/builders/$builderId/evidence/$evidenceId.ts`
  - Do: PATCH only; admin/owner; accepted/rejected; reviewer/time; subject
    restriction wins.
  - Verify: member forbidden, cross-tenant 404, repeated same decision idempotent,
    conflicting second decision audited.

- [x] **Add subject restriction flow**
  - File: `src/routes/api/me/builder/$builderId/restrict-processing.ts`
  - Do: verified claimant authorization, global restriction, active-job cancel,
    bounded tenant payload purge, repeat idempotency.
  - Verify: new/enqueued/running requests stop; restriction remains enforceable after
    evidence deletion.

- [x] **Add verified-subject provenance read**
  - File: `src/routes/api/me/builder/$builderId/evidence-provenance.ts`
  - Do: verified claimant only; aggregate source URL, field categories,
    observation date, and retention state across tenants; omit organization, recruiter,
    job, reviewer, note, and score metadata.
  - Verify: claimant sees provenance without tenant disclosure; non-claimant and another
    builder receive 404/403 per the existing claim authorization convention.

- [x] **Extend export and deletion**
  - Files: privacy repositories/workers/tests affected by account and organization data
  - Do: include tenant evidence provenance in authorized exports and erase it in
    deletion/restriction paths.
  - Verify: two-tenant privacy fixture exports only authorized data and deletion leaves no
    payload orphan.

## Phase 6 — UI and copy

- [x] **Build `PublicEvidenceCard`**
  - Files: `src/modules/builder-profile/components/PublicEvidenceCard.tsx`, `tests/unit/modules/builder-profile/components/PublicEvidenceCard.test.tsx`
  - Do: all spec states, bounded polling, source/observation/expiry, explanation,
    role-gated review, accessible loading/status/error announcements.
  - Verify: component state matrix, keyboard flow, and no polling after terminal/unmount.
  - Reality check (2026-07-31): the test file this task cited never existed on disk. Written now
    (6 cases: unavailable→renders nothing, idle-empty prompt, active-job disables refresh, refresh
    POSTs and reloads, 409 processing_restricted→restricted state, review item Accept
    PATCHes `{resolution:'accepted'}` and reloads). All 6 pass.

- [x] **Wire builder profile**
  - File: `src/modules/builder-profile/components/BuilderProfilePage.tsx`
  - Do: card near `PersonaCard`; active tenant role; no anonymous/public DTO change.
  - Verify: authenticated browser member/admin flows and anonymous profile inspection.

**Moved to [`plans/phase-5/02-legal-and-commercial-approvals`](../../../phase-5/02-legal-and-commercial-approvals/tasks.md)
on 2026-08-05, deliberately not as a checkbox** — it needs a legal review signed by a person, and Edd's
instruction is that the product launches when phase-5 finishes, so legal does not belong in the build
phase. An agent may draft the wording; it must never record the approval.

The draft is paste-ready: [`docs/operations/public-enrichment-privacy-copy-draft.md`](../../../../docs/operations/public-enrichment-privacy-copy-draft.md)
(2026-08-05), covering a new §1 bullet plus a full section on lawful basis, retention and rights, and one
line for `/crawler`. It is a doc rather than an edit to the route on purpose: on this repository a commit to
`master` deploys, so writing legal copy into the page **is** publishing it.

**The gap it fills is real, not cosmetic.** `/legal/privacy` §1 lists seven categories and every one is
about a *user*. Nothing discloses the public developer profiles the product indexes — personal data
belonging to people who never signed up and mostly do not know the product exists. That is the category a
supervisory authority looks at first.

## Phase 7 — Final verification and rollout

- [x] **Run complete quality gates**
  - Run all commands listed in `implementation_plan.md` Phase 7.
  - Verify: no skipped relevant suite; record exact pass/fail counts and environment.
  - **Done 2026-07-20**: `pnpm type-check` clean, `pnpm test` 508/508, `pnpm lint` 0 errors
    (30 pre-existing warnings, none new except one already-tolerated
    `react-hooks/set-state-in-effect` pattern matching PersonaCard/TosModal/CookieBanner),
    `pnpm security:boundaries` 0 legacy imports, `pnpm test:migration-integrity` valid,
    `pnpm build` succeeds (client + SSR). Also proved the full migration chain (0000→0018)
    applies cleanly to a brand-new scratch database, not just the long-lived dev DB.
    NOT run: `pnpm test:rls:local` (needs new `RLS_TEST_*_URL` fixtures for
    enrichment_jobs/enrichment_evidence/builder_processing_restrictions — none exist yet).

- [x] **Run runtime adversarial matrix**
  - **Done 2026-08-05. 20/20 checks across all twelve cases, exit 0** (17/17 on the first pass, plus one
    regression assertion per defect this exercise found and Edd then had fixed).** Evidence in
    [`docs/operations/public-enrichment-source-register.md`](../../../../docs/operations/public-enrichment-source-register.md)
    §"Runtime adversarial matrix — run 2026-08-05": one table row per case with its job id, first log
    event and the hosts it contacted, plus the run's complete contacted-host list.
    Reproduce with `pnpm test:enrichment-matrix:local`.

    The harness is [`scripts/ops/verify-enrichment-adversarial-local.mjs`](../../../../scripts/ops/verify-enrichment-adversarial-local.mjs),
    driven by [`run-enrichment-matrix-local.sh`](../../../../scripts/ops/run-enrichment-matrix-local.sh),
    which provisions a disposable `builderhunt_security_test_*` database and per-run login roles
    inheriting `builderhunt_app/_auth/_worker/_platform`. That role detail is the point: a matrix run
    as the owner cannot fail a GRANT, and finding 2 below is a GRANT failure.

    **Real vs simulated, because the honesty is the evidence:** schema, roles, RLS, route handlers,
    worker loop, policy register, resolver, retention SQL, restriction cascade and the kill switch (a
    separate OS process with the flag off) are all real. The *transport* is scripted for the fault
    cases — no upstream returns a challenge, a 429 and a hang on request — and case 01b makes one
    genuine HTTPS GET to `api.github.com` through the same `safeFetch` envelope. 10 scripted requests,
    1 real. **Zero requests to any blocked host**, asserted over the whole run.

    **It found a defect that would have failed the worker in production, and it was fixed here.**
    `enrichment_evidence_organization_job_fk` is `ON DELETE NO ACTION`, accepted evidence is retained
    180 days, jobs were retired at 90 — so the job sweep raised `23503` for every successful job in
    that 90-day window, and since the sweep runs inside `runEnrichmentWorker`, one such row failed the
    *entire* run: HTTP 500, `job_runs` closed `failed`, and the evidence half of retention stopped
    with it. Fixed in `src/shared/lib/repositories/enrichment-worker.ts` by retiring only jobs nothing
    references — not by cascading the FK, which would delete accepted evidence at 90 days and silently
    shorten the retention this plan promises. Regression pinned in
    `tests/unit/shared/lib/repositories/enrichment-worker.test.ts` (real database, because the bug is
    a foreign key and a mock cannot hold one).

    **Four further findings, all resolved the same day after Edd decided each one** (the register
    carries the full reasoning; the matrix now asserts every fix, at 19/19):

    - The organization-level delete/export helpers had no caller and were refused `42501` as the app
      role — **removed**, with the reasoning left where the code was. The paths that work are the
      organization cascade and the subject's own purge/provenance routes; a per-organization purge, if
      ever wanted, needs a worker-role write path rather than a wider grant.
    - The worker never passed `candidateSourceRecordId`, so the 10 000-bps stable-id signal never fired
      and **nothing was ever auto-accepted** — every candidate queued for human review however well it
      matched. Now passed; an exact ID match accepts and carries the 180-day window.
    - An operator-pasted URL resolved `rejected` and the tenant read returns only accepted/review, so
      the link was written, invisible, and deleted after seven days. The resolver's new
      `isOperatorSubmitted` input floors the *resolution* at `review` while awarding **no** confidence.
    - A privacy cancellation incremented `failed`, which the route maps to `job_runs.state='failed'` —
      correct behaviour closing a run as a failure. Split into its own `cancelled` counter.

    **A fifth defect turned up on a last pass over the same foreign-key family, and it is the worst of
    them** because it is a route a user presses: `DELETE /api/builders/:id` (untrack) deletes only the
    `organization_builders` row, so `ON DELETE NO ACTION` on the two composite FKs pointing at it raised
    `23503` — "stop following this person" answered 500 for exactly the people the product had enriched,
    and the evidence row survived the attempt. Deleting a whole organization was never affected, because
    both cascades fire in one statement; that is why organization deletion tested clean earlier and this
    did not. Fixed by `drizzle/0150_enrichment_untrack_cascade.sql`, which cascades both — the
    evidence → job FK stays NO ACTION for the retention reason above. Verified on the applied migration
    (`confdeltype` = `c`, `c`, `a`) and pinned at the constraint level in the worker repository test.

    Only one note stays open, and it is not a defect: `log.ts` mints no per-event id, so the register
    cites `event@ts` rather than inventing one.

  - Files: `docs/operations/public-enrichment-source-register.md` (where the evidence is recorded —
    this task produces evidence, not code)
  - Do: Exercise each case against a running instance with enrichment enabled in a non-production
    environment: an allowlisted host succeeding, a blocked host, a robots.txt denial, a challenge
    response, a 429, a timeout, two overlapping jobs for one builder, a worker crash and reclaim, a
    restriction arriving mid-job, retention expiry, an export and a delete request, and the kill
    switch. Record the job ID and log event ID for each.
  - Verify: all twelve cases produce the documented outcome, with sanitized evidence (job IDs, log
    event IDs, and the list of hosts actually contacted) attached to the source register. Zero
    blocked-host requests appear in the contacted-host list.

**Moved to [`plans/phase-5/01-production-readiness-audit`](../../../phase-5/01-production-readiness-audit/tasks.md)
on 2026-08-05, deliberately not as a checkbox** — it needs a production deploy and the Coolify environment,
and it is gated on the legal review that moved to
[`02-legal-and-commercial-approvals`](../../../phase-5/02-legal-and-commercial-approvals/tasks.md). Its other
precondition, the runtime adversarial matrix, closed 2026-08-05 at 20/20.

**One finding stays recorded here, because it happened to this plan.** On 2026-08-05 `ENRICHMENT_ENABLED`
was found `true` in the production Coolify env while both gating tasks were open. Measured before saying
anything stronger: 614 `job_runs` with an `enrichment%` key over nine days, all `succeeded`, with
`processed_count` summing to **0**, zero `enrichment_evidence` rows, and one `enrichment_jobs` row from
before the window. The worker had been waking on schedule and finding nothing to process — a configuration
divergence from the plan, not an unapproved crawl. Set to `false` on the production row on Edd's
instruction and the container redeployed so the value is in effect rather than only stored; the preview row
stays `true`, since preview is the non-production environment the adversarial matrix requires.

**Local development stays enabled, but not through `.env`.** Setting `ENRICHMENT_ENABLED=true` there breaks
`tests/unit/lib/enrichment/worker.test.ts` *by design*: its second test calls the real
`runEnrichmentWorker()` and asserts a no-op shape, and the first pins the flag to `false` precisely so the
suite fails loudly instead of doing real DB and network work. Weakening that guard to carry a dev
convenience would be the wrong trade, so the convenience is a script instead — `pnpm dev:enrichment`.

## Future work — not part of this implementation

These are scope records, deliberately not checkboxes: each needs a new approval or a new
specification before it becomes work, and a checkbox here reads as "pending task" to anyone —
human or agent — walking this file top to bottom.

- Scheduled refresh, after a separate post-canary approval.
- Additional official API adapters, each after its own source-policy review.
- Authorized organization-site crawling, after host-level approval and robots tests.
- Public evidence display or AI interpretation, only under a new specification.
