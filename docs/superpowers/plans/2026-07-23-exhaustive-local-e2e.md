# Exhaustive Local E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `subagent-driven-development` and strict RED-GREEN-REFACTOR. Development uses up to three concurrent agents only after shared harness isolation is proven. Steps use checkbox syntax for tracking.

**Goal:** Deliver the broadest practical deterministic local E2E suite for BuilderHunt using real PostgreSQL, isolated Redis, real HTTP/browser execution, and simulated external-service boundaries.

**Architecture:** Establish one disposable PostgreSQL database and Redis namespace per Playwright worker, central role/organization/entitlement fixtures, deterministic fake providers, strict browser console/network assertions, and a route coverage manifest. Then add independent browser and API suites by product domain, followed by concurrency, responsive/accessibility, repeatability, CI, and documentation gates.

**Tech Stack:** TypeScript, Playwright 1.61.1, TanStack Start/Vite, PostgreSQL 16 + pgvector, Drizzle, Redis, Better Auth, Stripe SDK fake provider, Vitest.

## Global Constraints

- Local required tests use real PostgreSQL and no live external services.
- E2E requires Redis; the in-memory rate-limit fallback must fail closed in E2E mode.
- One disposable PostgreSQL database per Playwright worker; migrations use the existing advisory-lock helper.
- `E2E_MODE=true` explicitly enables test-only seams. They must be unreachable in production mode.
- Existing unrelated working-tree changes in Drizzle schema/migrations must remain untouched.
- No arbitrary waits; use `waitForHydration(page)` and condition-based assertions.
- Every browser test rejects unexpected console errors, page errors, failed BuilderHunt requests, and third-party egress.
- Every protected API route receives anonymous, no-active-org where applicable, allowed-role, denied-role, cross-tenant-ID, invalid-input, not-found, and relevant duplicate/race assertions.
- Use semantic selectors first. Add focused test IDs only when no stable user-facing selector exists.
- No production implementation change without a failing test first.
- Do not commit, push, or rewrite history.

---

## Wave 1 — Shared isolation and harness

### Isolation architecture decision

Playwright's single global `webServer` cannot switch database URLs per worker because application database clients bind environment variables at module load. Therefore the harness uses **one application-server process per worker**, not Playwright's global `webServer`, once parallel mode is enabled:

- `scripts/e2e/run-worker-server.mjs` allocates a disposable database, provisions exact-role credentials/grants for that database, allocates a unique app port and Redis prefix, then starts Vite with the worker-specific five database URLs.
- Worker fixtures connect their browser/API context to that server's base URL.
- The existing global `webServer` remains only for legacy single-worker specs until they are migrated.
- Parallelism stays disabled until exact-role connections and two server processes are proven concurrently.

Production-file fixes discovered by parallel test-authoring agents are not edited concurrently. Agents own new spec files only; findings are consolidated after each wave into one serialized fix task with failing tests and explicit source-file ownership.

### Task 1: Prove worker-isolated PostgreSQL and Redis

**Files:**
- Create: `e2e/harness/env.ts`
- Create: `e2e/harness/ids.ts`
- Create: `e2e/harness/database.ts`
- Create: `e2e/harness/cache.ts`
- Create: `e2e/harness/isolation.spec.ts`
- Create: `scripts/e2e/run-worker-server.mjs`
- Modify: `src/shared/lib/db/create-disposable-test-database.ts`
- Modify: `src/shared/lib/rate-limit.ts`
- Modify: `playwright.config.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces `acquireWorkerDatabase(workerIndex)`, `dropWorkerDatabase()`, `workerDatabaseUrls()`, `startWorkerServer(workerIndex)`, `stopWorkerServer()`, `acquireWorkerRedis(workerIndex)`, `dropWorkerRedisNamespace()`, `uniqueId(label)`, and strict `e2eEnv` parsing.
- Database URLs include migration-owner, application, auth, worker, and platform roles targeting the same disposable database. Provisioning sets test-only passwords, grants `CONNECT`, and verifies each role can perform its intended operations while denied operations remain denied.

- [ ] Write one failing test proving a disposable database can be created and migrated through the migration owner; run it and confirm the expected missing-helper failure.
- [ ] Implement only database creation/migration and rerun focused GREEN.
- [ ] Write one failing test per exact runtime role connection/grant boundary; implement test-only role credentials and per-database grants, then rerun focused GREEN and existing RLS checks.
- [ ] Write one failing test proving a worker server receives those five URLs before module load and serves `/api/health`; implement the worker-server launcher and rerun focused GREEN.
- [ ] Write one failing test proving two server processes mutate separate databases concurrently; implement worker orchestration and rerun with two workers.
- [ ] Write one failing test proving Redis keys are worker-prefixed and cross-reading fails; implement namespace isolation and cleanup.
- [ ] Refactor only after all focused tests pass, then run the isolation spec twice and existing database/RLS regressions.

### Task 2: Build principals, organizations, entitlements, storage states, and clock fixtures

**Files:**
- Create: `e2e/harness/roles.ts`
- Create: `e2e/harness/clock.ts`
- Create: `e2e/harness/auth.ts`
- Create: `e2e/harness/fixtures/principals.ts`
- Create: `e2e/harness/fixtures/organizations.ts`
- Create: `e2e/harness/fixtures/billing.ts`
- Create: `e2e/harness/fixtures/privacy.ts`
- Create: `e2e/harness/fixtures/builders.ts`
- Create: `e2e/harness/fixtures/workers.ts`
- Create: `e2e/harness/fixtures/platform-admin.ts`
- Create: `e2e/harness/fixtures.spec.ts`

**Interfaces:**
- Principals: anonymous, unverified, verified, member, organization admin, owner, and platform admin.
- Organizations always receive explicit free/pro/team entitlements and configurable seat limits.
- Real sign-up remains a separate regression path; fixture verification may update the DB because no product verification flow exists.

- [ ] Write failing tests for every principal and organization role, active organization, entitlement, storage state, and fixed-time state.
- [ ] Run `pnpm exec playwright test e2e/harness/fixtures.spec.ts`; expected RED.
- [ ] Implement fixtures using deterministic IDs and the worker database.
- [ ] Verify every storage state authenticates through `/api/auth/get-session` and every role resolves through the real authorization layer.
- [ ] Verify cleanup removes only worker-owned data and final worker teardown drops the database.

### Task 3: Replace hydration delays and enforce strict browser behavior

**Files:**
- Create: `src/shared/components/HydrationSignal.tsx`
- Create: `src/shared/components/HydrationSignal.test.tsx`
- Create: `e2e/harness/browser.ts`
- Create: `e2e/harness/browser.spec.ts`
- Modify: `src/routes/-root-components.tsx`
- Modify: `e2e/team-accounts.spec.ts`

**Interfaces:**
- Produces `waitForHydration`, `gotoHydrated`, `dismissOverlays`, `expectStrictBrowser`, `allowExpectedFailure`, `twoContexts`, and download helpers.

- [ ] Write a failing component test for the hydration signal.
- [ ] Write a failing browser harness test proving navigation needs no fixed delay and unexpected console/network failures fail the test.
- [ ] Implement the hydration signal and strict collectors.
- [ ] Migrate existing team-account helpers without changing scenario order or assertions.
- [ ] Run `pnpm test:e2e -- e2e/team-accounts.spec.ts e2e/signup-active-organization.spec.ts`; expected GREEN with no `waitForTimeout` hydration workaround.

### Task 4: Add deterministic external-service boundaries

**Files:**
- Create: `src/shared/lib/email/outbox.ts`
- Create: `src/shared/lib/email/outbox.test.ts`
- Modify: `src/shared/lib/email.ts`
- Modify and test the existing `src/shared/lib/billing/stripe-provider.ts` selection seam; do not add a second resolver.
- Create: `e2e/harness/fakes/email.ts`
- Create: `e2e/harness/fakes/billing.ts`
- Create: `e2e/harness/fakes/webhook.ts`
- Create: `e2e/harness/fakes/discovery.ts`
- Create: `e2e/harness/fakes/ai.ts`
- Create: `e2e/harness/fakes.spec.ts`
- Modify only audited provider call sites required to select fakes under `E2E_MODE=true`.

**Interfaces:**
- Email outbox, all existing billing fake scenarios, genuine Stripe SDK signatures, named discovery/AI scenarios, controlled worker invocation.

- [ ] Write failing unit tests proving `E2E_MODE=true` can select named test scenarios while the existing billing-disabled fake remains supported in non-E2E environments and E2E-only controls are inaccessible outside E2E mode.
- [ ] Write failing E2E tests for outbox delivery, billing scenario selection, signed webhook acceptance/rejection, deterministic discovery/AI responses, and third-party egress blocking.
- [ ] Implement minimal guarded seams.
- [ ] Run focused unit and harness specs; expected GREEN with zero live network calls.

### Task 5: Add route coverage manifest and harness smoke

**Files:**
- Create: `e2e/coverage-manifest.ts`
- Create: `scripts/check-e2e-coverage.mjs`
- Create: `e2e/harness/smoke.spec.ts`
- Modify: `scripts/check-route-coverage.mjs`
- Modify: `package.json`
- Modify: `playwright.config.ts`

**Interfaces:**
- Dispositions: `browser`, `api`, `both`, `not-applicable`; every route includes owned spec paths and a reason for non-applicable status.

- [ ] Write failing manifest tests for missing route, missing spec path, duplicate owner, and invalid disposition.
- [ ] Implement manifest discovery as a strict superset of the existing route guard checker.
- [ ] Write the smoke spec: server startup, seeded auth, database mutation, Redis mutation, fake-service call, and teardown.
- [ ] Add `test:e2e:smoke`, `test:e2e:api`, `test:e2e:full`, `test:e2e:concurrency`, and `test:e2e:coverage` scripts.
- [ ] Run coverage checker and smoke twice with two workers; expected GREEN.

---

## Wave 2 — Foundational browser journeys

After Wave 1 is reviewed and green, dispatch Tasks 6–8 to three agents in parallel; each owns only its named spec files.

### Task 6: Public content, consent, feeds, OG, and legal

**Files:**
- Create: `e2e/public-and-consent.spec.ts`
- Create: `e2e/public-content.spec.ts`
- Create: `e2e/public-feeds-and-og.spec.ts`

- [ ] Cover landing, explore, pricing, roadmap voting/auth boundary, changelog, blog, status, public builders, legal pages, cookie customization/persistence, ToS lifecycle, feeds, sitemap/robots/Atom where present, and OG responses.
- [ ] Include success, empty, validation, error, redirect, anonymous-data-redaction, and hostile-content states.
- [ ] Run each new spec before implementation to record RED, then make it GREEN using real routes and seeded data.

### Task 7: Authentication, sessions, and invitation redirect preservation

**Files:**
- Create: `e2e/auth-and-sessions.spec.ts`

- [ ] Cover sign-up UI, validation, duplicate email, weak password, sign-in, wrong credentials, sign-out, forgot/reset password through outbox, invalid/expired/reused reset token, expired session, open-redirect rejection, deep-link preservation, context cookie isolation, reload persistence, unverified restrictions, and first active organization regression.
- [ ] Cover signed-out invitation → sign-in → original invitation return.
- [ ] Run the spec RED then GREEN, plus the existing signup regression.

### Task 8: Onboarding, dashboard, and navigation

**Files:**
- Create: `e2e/onboarding.spec.ts`
- Create: `e2e/dashboard-and-navigation.spec.ts`

- [ ] Cover onboarding welcome/search/save/success/skip, required three saves, duplicate submissions, empty/error/retry, refresh restoration, and anonymous/completed redirects.
- [ ] Cover dashboard empty/non-empty/loading/error, stats, saved searches, recent builders, recommendations entry, banners, ToS, main navigation, account menu, organization switching, stale org, back/forward, deep links, and two-context isolation.
- [ ] Run focused specs RED then GREEN.

### Wave 2 review gate

- [ ] Run Wave 2 specs twice with two workers.
- [ ] Run `pnpm lint`, `pnpm type-check`, `pnpm test`, and `pnpm build`.
- [ ] Review strict console/network reports and route-manifest ownership.

---

## Wave 3 — Product browser domains

Dispatch Tasks 9–11 in parallel, followed by Tasks 12–13.

### Task 9: Search, tracking, queries, feeds, and Solutions Intelligence

**Files:**
- Create: `e2e/search-and-tracking.spec.ts`
- Create: `e2e/queries-and-solutions.spec.ts`

- [ ] Cover keyword/semantic modes, free/pro gates, all source filters, location/language, tabs, sort, save query, feeds, tracked builders, duplicate operations, pagination, keyboard shortcut, deep links, malformed/hostile/timeout provider states, and tenant isolation.
- [ ] Cover Solutions Intelligence entry points, query/recommendation integration, AI capability config, disabled/fallback states, and no live AI calls.

### Task 10: Builder profiles, notes, claims, evidence, persona, and outreach

**Files:**
- Create: `e2e/builder-profiles.spec.ts`

- [ ] Cover public/private profile branches, not found, track/untrack, notes CRUD, blank validation, claim/outbox verification, restrict-processing, evidence provenance/refresh/accept/reject, persona states, outreach generation/copy/rewrite/shorten, hostile text safety, duplicates, and tenant isolation.

### Task 11: Alerts and recommendations

**Files:**
- Create: `e2e/alerts.spec.ts`
- Create: `e2e/recommendations.spec.ts`

- [ ] Cover alert form validation, all event/channel/frequency combinations, paid gate, create/delete, worker trigger, unread/read-all, outbox delivery, duplicates, failures, rate-limit presentation, tenant isolation, recommendation empty/loading/success/refresh/dismiss/error, entitlement differences, and persistence.

### Task 12: Sprints

**Files:**
- Create: `e2e/sprints.spec.ts`
- Create deterministic upload fixtures under `e2e/fixtures/files/`.

- [ ] Cover list empty state, JD text, upload, parse/decompose/preview/save, malformed/error/retry, dossier/refine/history/track, pause/resume/conflict, worker progress, delete, plan/rate gates, duplicate saves, and tenant isolation.

### Task 13: Exports and tracked-builder downloads

**Files:**
- Create: `e2e/exports.spec.ts`

- [ ] Cover empty/list states, CSV download content/filename/escaping, hostile spreadsheet values, remove/re-track, export failure recovery, privacy export pending/completed/failed/download, duplicate request, ownership blocker, reload persistence, and cross-user isolation.

### Wave 3 review gate

- [ ] Run all Wave 3 specs twice.
- [ ] Run manifest, lint, type-check, unit tests, and build.

---

## Wave 4 — Organizations, privacy, admin, and API matrices

Dispatch Tasks 14–16 in parallel, then Task 17.

### Task 14: Organization, invitation, privacy, and account browser journeys

**Files:**
- Create: `e2e/organizations-and-invitations.spec.ts`
- Create: `e2e/privacy-and-account.spec.ts`

- [ ] Extend rather than duplicate existing team-account coverage: cancellation, resend, expiry, wrong email, double accept, leave, delete, ownership blockers, stale active organization, stale reauth, seat copy, pending banner, cancellation/accept race.
- [ ] Cover data export, download, duplicate throttle, account deletion, organization ownership blocker, cancellation window, primary claimed profile, account states, and multi-tab behavior.

### Task 15: Organization, privacy, account, and cross-tenant API E2E

**Files:**
- Create: `e2e/api/organizations.spec.ts`
- Create: `e2e/api/invitations.spec.ts`
- Create: `e2e/api/privacy.spec.ts`
- Create: `e2e/api/account.spec.ts`
- Create: `e2e/api/cross-tenant.spec.ts`

- [ ] Enumerate every method under organization, invitation, member, transfer, switch, deletion, privacy export/deletion, account builder, plans, and upgrades.
- [ ] Apply the complete auth/role/tenant/input/not-found/duplicate/rate matrix.

### Task 16: Admin browser and API E2E

**Files:**
- Create: `e2e/admin/users.spec.ts`
- Create: `e2e/admin/billing.spec.ts`
- Create: `e2e/admin/content.spec.ts`
- Create: `e2e/admin/workers.spec.ts`
- Create: `e2e/api/admin.spec.ts`

- [ ] Cover users/filter/plan changes/seat conflict/audit, plan requests/duplicate/concurrent resolution, seller configuration, incidents, roadmap, changelog, metrics, all worker controls, non-admin denial, cron principal, invalid bodies, empty-vs-backend-error behavior, and partial-state transaction regression.

### Task 17: Remaining API route matrix

**Files:**
- Create domain specs under `e2e/api/` for auth, onboarding, search, builders, alerts, sprints, exports, recommendations, queries, AI, feeds, public content, consent, and status.

- [ ] Ensure every route in the manifest has its declared runtime matrix or documented non-applicable disposition.
- [ ] Validate sensitive-field redaction and unexpected error mapping.

### Wave 4 review gate

- [ ] Run all API E2E with two isolated workers twice.
- [ ] Run browser Wave 4 specs twice.
- [ ] Run RLS/API isolation/static security checks.

---

## Wave 5 — Billing, webhooks, workers, and races

Dispatch Tasks 18–20 in parallel; Task 21 follows their integration.

### Task 18: Billing API and browser flows

**Files:**
- Create: `e2e/api/billing-checkout.spec.ts`
- Create: `e2e/api/billing-subscription.spec.ts`
- Create: `e2e/api/billing-credits.spec.ts`
- Create: `e2e/api/billing-portal.spec.ts`
- Create: `e2e/api/billing-auto-recharge.spec.ts`
- Create: `e2e/billing/checkout-and-return.spec.ts`
- Create: `e2e/billing/subscription-lifecycle.spec.ts`
- Create: `e2e/billing/credits-and-auto-recharge.spec.ts`

- [ ] Exercise every fake-provider scenario across checkout, status, portal, subscription preview/change/cancel, credits, auto-recharge, owner/member restrictions, recent-auth, seat blocker, stale preview, duplicate active subscription, provider timeout/error, and UI return reconciliation.

### Task 19: Signed webhook API E2E

**Files:**
- Create: `e2e/api/webhooks-stripe.spec.ts`

- [ ] Generate real Stripe SDK signatures for every handled event type.
- [ ] Cover missing/wrong/stale/current/previous secret, API-version/livemode mismatch, malformed/unknown/deferred events, duplicate receipt, same object under different event IDs, raw content types, redaction, and no-session behavior.

### Task 20: Workers and replay API E2E

**Files:**
- Create: `e2e/api/billing-worker.spec.ts`
- Create: `e2e/api/billing-replay.spec.ts`

- [ ] Cover claim/lease, concurrent workers, retry scheduling, dead-letter, retrieval miss, deferred events, expired/annual grants, dunning blocks/recovery, auto-recharge, replay no-op/recovery/missing event, audit trail, and deterministic fixed time.

### Task 21: Critical concurrency and idempotency suite

**Files:**
- Create: `e2e/concurrency/idempotency.spec.ts`
- Create: `e2e/concurrency/invitations.spec.ts`
- Create: `e2e/concurrency/privacy.spec.ts`
- Create: `e2e/concurrency/tenant-switch.spec.ts`
- Create: `e2e/concurrency/billing.spec.ts`
- Create: `e2e/concurrency/worker-lease.spec.ts`

- [ ] Cover final-seat invite, duplicate invitation acceptance, saved-query creation, privacy export request, checkout idempotency, subscription change, webhook receipt, worker lease claim, and concurrent org switching.
- [ ] Run `pnpm test:e2e:concurrency -- --repeat-each=5 --retries=0`; expected GREEN.

---

## Wave 6 — Responsive, accessibility, CI, and final stabilization

### Task 22: Responsive and accessibility matrix

**Files:**
- Create: `e2e/responsive-and-accessibility.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `package.json`

- [ ] Add tablet and accessibility projects.
- [ ] Cover representative public/auth/dashboard/search/profile/alerts/sprints/privacy/admin/billing pages at desktop/tablet/mobile.
- [ ] Verify no overflow, keyboard operation, focus trap/restoration, skip link, labels, live regions, tab semantics, reduced motion, forced colors where practical, and automated axe checks.

### Task 23: CI workflows, artifacts, redaction, and documentation

**Files:**
- Create: `.github/workflows/e2e.yml`
- Modify: `.github/workflows/quality.yml`
- Create: `docs/operations/local-e2e.md`
- Create or update: `e2e/README.md`
- Modify: `playwright.config.ts`
- Modify: `package.json`

- [ ] Define PR smoke and nightly/full projects exactly as the design specifies.
- [ ] Add JUnit/JSON/HTML reporters, videos on failure, traces, screenshots, 14-day artifact retention, and artifact PII redaction.
- [ ] Document prerequisites, fixtures, fake scenarios, commands, route-manifest maintenance, debugging, and cleanup.

### Task 24: Final verification and stabilization

- [ ] `pnpm test:e2e:coverage`
- [ ] `pnpm test:e2e:smoke -- --repeat-each=2`
- [ ] `pnpm test:e2e:api -- --repeat-each=2`
- [ ] `pnpm test:e2e:full -- --repeat-each=2`
- [ ] `pnpm test:e2e:concurrency -- --repeat-each=5 --retries=0`
- [ ] `pnpm lint`
- [ ] `pnpm type-check`
- [ ] `pnpm test`
- [ ] `pnpm security:boundaries`
- [ ] `pnpm security:route-coverage`
- [ ] `pnpm test:rls:local`
- [ ] `pnpm test:api-isolation:local`
- [ ] `pnpm test:migration-integrity`
- [ ] `pnpm test:migrations:local`
- [ ] `pnpm security:dependencies`
- [ ] Validate JUnit/JSON/HTML output and a controlled failing spec's screenshot/video/trace retention, artifact redaction, 14-day workflow retention, and quarantine issue/owner/expiry enforcement.
- [ ] Run `E2E_RUN_ID=clean-a pnpm test:e2e:full`, verify complete DB/Redis/storage cleanup, then run `E2E_RUN_ID=clean-b pnpm test:e2e:full`; both independent runs must pass with identical counts.
- [ ] `pnpm build`
- [ ] Confirm no disposable databases, Redis keys, outbox entries, storage states, or test data remain.
- [ ] Confirm no live external requests occurred.
- [ ] Confirm unrelated pre-existing Drizzle changes remain untouched via `git status --short` and diff review.
