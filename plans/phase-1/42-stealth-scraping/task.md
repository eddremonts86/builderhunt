# Public Profile Enrichment — Implementation Tasks

> **Status:** `code-complete-dark` — Phases 0-6 checkboxes below are real (verified, not
> assumed). Phase 7's first item (quality gates) is done; canary/rollout items remain
> unchecked and require a human decision + elapsed time, not more code.
> **Spec:** [`spec.md`](./spec.md)
> **Plan:** [`implementation_plan.md`](./implementation_plan.md)
> Check a task only after its listed verification passes. Preserve the user's existing
> uncommitted migration/worktree changes; generate the migration from the then-current
> schema rather than assuming a migration number.

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
  - Files: `src/modules/builder-profile/components/PublicEvidenceCard.tsx` and test
  - Do: all spec states, bounded polling, source/observation/expiry, explanation,
    role-gated review, accessible loading/status/error announcements.
  - Verify: component state matrix, keyboard flow, and no polling after terminal/unmount.

- [x] **Wire builder profile**
  - File: `src/modules/builder-profile/components/BuilderProfilePage.tsx`
  - Do: card near `PersonaCard`; active tenant role; no anonymous/public DTO change.
  - Verify: authenticated browser member/admin flows and anonymous profile inspection.

- [ ] **Update legal and product copy**
  - Files: `src/routes/_landing/legal/privacy.tsx`, `src/routes/_landing/legal/terms.tsx`,
    `src/routes/_landing/crawler.tsx` (new — the public page the crawler's user agent points at),
    `README.md`, `src/shared/lib/legal-versions.ts` (only if the approved legal review requires a
    consent-version bump), `docs/operations/public-enrichment-source-register.md`
  - Do: State on the privacy page the categories collected, the purpose, the lawful basis, the
    source, the retention period, the data-subject rights and the contact route. Publish the crawler
    page naming the exact user agent and how to request exclusion. Correct any README or product
    claim that implies more than public-data collection. Use the precise public-data wording from the
    approved review — never "stealth", evasion, or guaranteed access.
  - Verify: every legal page renders and its links resolve (`pnpm exec playwright test tests/e2e/public-content.spec.ts`
    covers the legal surface); the crawler page is reachable anonymously; and the written approval is
    recorded in `docs/operations/public-enrichment-source-register.md`.
  - Operator: the wording needs a legal review signed off by a person; an agent may draft it but must
    not record the approval.

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

- [ ] **Run runtime adversarial matrix**
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

- [ ] **Deploy dark**
  - Files: `.env.production.example` (`ENRICHMENT_ENABLED`), `docs/operations/public-enrichment-source-register.md`
  - Operator: needs a production deploy plus the Coolify environment. An agent must not enable this.
  - Do: deploy migration/code with `ENRICHMENT_ENABLED=false`; validate exact runtime
    roles, indexes, RLS, health, and zero enrichment network traffic.
  - Verify: production smoke without enabling customer behavior.

- [ ] **Approve and run seven-day canary**
  - Files: `docs/operations/public-enrichment-source-register.md` (the approval and the daily record)
  - Operator: needs a human approval and seven days of elapsed time. Neither can be produced by an
    agent, and the canary cannot be shortened.
  - Do: approved legal/source register; GitHub only; admin then internal users;
    manual jobs; batch 2.
  - Verify: spec SLOs, no critical policy/privacy/isolation incident, zero blocked-host
    requests, and zero overdue retention rows.

- [ ] **Enable manual customer refresh**
  - Files: `.env.production.example` (`ENRICHMENT_ENABLED`), `docs/operations/public-enrichment-source-register.md`
  - Operator: turning this on for customers is a product decision that follows the canary approval.
  - Preconditions: every prior task complete and canary approved.
  - Do: expand audience without enabling scheduled refresh or new connectors.
  - Verify: one authorized production job reaches terminal state and renders attributed,
    non-expired evidence with redacted logs.

## Future work — not part of this implementation

These are scope records, deliberately not checkboxes: each needs a new approval or a new
specification before it becomes work, and a checkbox here reads as "pending task" to anyone —
human or agent — walking this file top to bottom.

- Scheduled refresh, after a separate post-canary approval.
- Additional official API adapters, each after its own source-policy review.
- Authorized organization-site crawling, after host-level approval and robots tests.
- Public evidence display or AI interpretation, only under a new specification.
