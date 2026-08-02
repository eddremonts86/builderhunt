# Tasks: Exhaustive Local E2E — Organizations, Admin, API Security, Billing, Webhooks, Workers, Concurrency

> **Status**: `pending` (scope: design wave 4+5; auth/sessions/onboarding/search/dashboard/alerts/sprints/exports/responsive is owned by sibling tasks per `docs/superpowers/specs/2026-07-53-exhaustive-local-e2e-design.md` Delivery order §2, §3, §6)
> **Depends on**: [`team-accounts`](../27-team-accounts/tasks.md), [`stripe-billing-platform`](../30-stripe-billing-platform/tasks.md) (for the implemented webhook receipt, event handlers, claim/lease worker, replay, fake provider, checkout/portal/subscription/credits surface), [`security-and-multitenancy`](../01-security-and-multitenancy/tasks.md)
> **Blocks**: the speed-gate "two consecutive clean runs" criterion in spec §Verification gates; CI's `quality.yml` job.
> **Reality check**: every route named below already exists in `src/routes/api/...` and is wired to real Postgres (not mocks) via the foundation files cited in each task. The existing `tests/e2e/team-accounts.spec.ts` (10 scenarios, real browser) covers the happy-path organization matrix but stops short of API-contract, tenant-isolation, idempotency, and replay coverage; `tests/unit/security/team-api-isolation.test.ts` and `tests/unit/security/billing-tenant-isolation.test.ts` cover route-layer input validation and RLS-migration invariants but never exercise routes over real HTTP. The deterministic `FakeBillingProvider` (`src/shared/lib/billing/fake-provider.ts`) already supports `success|decline|timeout|delayed|sca_required|out_of_order` scenarios plus idempotent creation by `idempotencyKey` — every billing task below uses it, never real Stripe. `receiveStripeWebhook` (`src/shared/lib/billing/webhook-inbox.ts`) already accepts a `signingSecrets` override so the harness can sign with a fixture secret independent of the process's real env; `runBillingWorker` and `replayBillingWebhookEvent` both accept a `retriever` override so the harness can inject a deterministic event list. The harness for these tasks is the **execution substrate**, not a new product surface — it lives under `tests/e2e/harness/` (gitignored-namespace) and owns a per-test disposable database, an in-process fake provider, an in-process email outbox, and a `crypto` fixture for signing real Stripe webhooks.

## Conventions for every task below

1. **RED → GREEN → REFACTOR** — every task writes the failing test first, ships the minimum code to turn it green, then refactors. The Verify line is the GREEN command; running it on a clean checkout must reproduce the failure-then-pass path the task describes.
2. **Independent task boundaries** — no two tasks in this file share mutable state. Each owns a subdirectory under `tests/e2e/` (e.g. `tests/e2e/organizations/`, `tests/e2e/admin/`, `tests/e2e/billing/`, `tests/e2e/webhooks/`, `tests/e2e/concurrency/`), imports its fixtures from `tests/e2e/harness/` only, and never mutates a shared fixture file. The harness itself is task 1; everything else is additive.
3. **Real Postgres, real HTTP, real browser** — no supertest, no `app.inject`, no in-memory db. `webServer` in `playwright.config.ts` already boots the real app; the harness drops a disposable database before each test and lets Drizzle's `migrate` bring it to the same schema (uses `src/shared/lib/db/create-disposable-test-database.ts` — confirm the helper exists before task 1, otherwise build it as part of task 1.1).
4. **Determinism** — every test seeds its own timestamps, ids, and emails; no `Date.now()` leakage between tests; no `Math.random()` for fixture ids; no live Resend, no live Stripe, no live discovery, no live AI; the email outbox is in-process and asserted by the test, never asserted by polling.
5. **Coverage manifest** — after every API task merges, run `node scripts/check-route-coverage.mjs` and confirm the new route appears in the 76-route count with a recognized guard. The route-coverage manifest is the single source of truth for "did we cover this?"; a route without a test gets a documented non-applicable disposition in the manifest, not silent exemption.
6. **Browser console + network assertions** — every browser E2E task wires `page.on('console')` and `page.on('requestfailed')` to fail on uncaught errors/unexpected 5xx unless the test explicitly opts the line out. The harness exposes a `withStrictConsole(page)` helper for this (task 1).
7. **Repeatability** — every test must run twice consecutively from clean state with zero flakes. The `repeatability` package.json script (task 8) runs the full suite twice back-to-back; CI's nightly job runs the same.

---

> **Reality check (2026-07-27)**: this plan was written as though the harness did not exist. It
> exists at **`tests/e2e/harness/`**, and has for some time, with 83 tests
> covering the harness itself. Contrasting task 1's shopping list against the actual exports, every
> item but one is already built:
>
> | Task 1 asks for | Already exists as |
> |---|---|
> | `withDisposableDatabase()` | `acquireWorkerDatabase` / `dropWorkerDatabase` (`harness/database.ts`) |
> | `seedPersonalUser` / `seedOrganization` / role factories | `harness/auth.ts` (`signUp`, `signIn`, `createOrganizationViaApi`, `setActiveOrganization`, `captureStorageState`, `sessionFromStorageState`) + `harness/roles.ts` |
> | `FakeBillingProvider` installer | `harness/fakes/billing.ts` (`setBillingScenario`, scenarios in `_scenarios.ts`) |
> | `emailOutbox()` | `harness/fakes/email.ts` (`installEmailFake`, `resetEmailFake`) |
> | `signStripeWebhook` / `postRawWebhook` | `harness/fakes/webhook.ts` (`signStripeWebhook`, `postWebhook`, `postUnsignedWebhook`, `stripeEventFixture`) |
> | `withStrictConsole(page)` | `harness/browser.ts` (`expectStrictBrowser`) |
> | `http.ts` | `harness/auth.ts` (`newApiContext`) |
> | `pnpm test:e2e:repeat` | **missing — the only genuine gap in task 1** |
>
> The harness also carries pieces this plan never asked for: a fixed clock (`harness/clock.ts`), a
> Redis namespace per worker (`harness/cache.ts`), an egress guard that fails a test on any
> unexpected outbound request (`harness/fakes/egress.ts`), and AI/discovery fakes.
>
> Treat the remaining tasks as writing test matrices on an existing substrate, not as building one.
> Every path below is the real one: the file paths in this plan were corrected on 2026-07-28 to the
> unified `tests/{unit,e2e,regression}` layout, so they can be followed literally.

- [x] **Add the repeatability script the harness still lacks** — done (2026-07-27)
  - Files: `package.json`, `scripts/ci/e2e-repeat.mjs`
  - `pnpm test:e2e:repeat` runs the suite twice and compares per-test outcomes, failing on any
    divergence in either direction — a test that starts passing on the second run is as much a bug
    as one that starts failing. Arguments are forwarded, so it can narrow both runs the same way.
  - **Known flake this immediately matters for**: `sign-in via the UI lands on the dashboard and
    the session survives a reload` failed once in a full-suite run with one `403` beyond the two
    `/api/admin/incidents` probes it allows, and passed both in isolation and with its own file
    run whole (instrumented: exactly the two expected 403s). Cross-file order dependence, not a
    product defect. CI's `retries: 1` will absorb it, which is precisely why it needs chasing
    rather than leaving to the retry.

- [x] **Build the E2E harness: disposable database, deterministic fake provider seam, email outbox, signed-webhook signer, and role factories** — already existed (verified 2026-07-27, see the table above)
  - Files: `tests/e2e/harness/**`
  - Do: Provide a `withDisposableDatabase()` fixture that builds a Postgres role+database from a CI-provided `WORKER_DATABASE_URL` (the role has `CREATEDB`), runs `drizzle-kit migrate` to current head, returns a Drizzle client, and tears the database down in `afterEach`. Extend `playwright.config.ts` with a `webServer` env var that injects the disposable `DATABASE_URL` for the lifetime of one test (the harness echoes the same `E2E_PORT`/`baseURL` already configured). Provide a `seedPersonalUser({ withVerifiedEmail?: boolean, withActiveOrg?: boolean })`, `seedOrganization({ owner, members, tier, seatLimit })`, `seedPlatformAdmin()`, and `seedOrganizationWithConfirmedInvitation(...)` factory; every factory returns `{ contexts: { owner, admin, member, anonymous, platformAdmin }, ids: {...} }` so API tests can talk to a real in-process session via `request.post('/api/...', { headers: { cookie: sessionCookie }})` without going through the UI. Build a `FakeBillingProvider` installer that runs in the same Vite dev server process via `getBillingProvider`'s already-supported override seam (confirm `getBillingProvider` accepts an injected provider in `src/shared/lib/billing/stripe-provider.ts`; if not, add the override and a `getBillingProviderForTesting()` export as part of this task — the function must be only loaded by `import.meta.vitest` or `process.env.E2E_FAKE_BILLING === '1'` to prevent accidental production use). Build an `emailOutbox()` that monkey-patches `sendOrganizationInvitationEmail`/`sendResetPasswordEmail`/`sendExportReadyEmail`/`sendDeletionScheduledEmail` in `src/shared/lib/email.ts` to a per-test array; expose the same array on `globalThis.__emailOutbox` for the test to assert against. Build a `signStripeWebhook({ payload, secret, timestamp })` helper that produces a real `Stripe-Signature` header over the raw bytes, and a `postRawWebhook({ rawBody, signature })` that POSTs to `/api/webhooks/stripe` and asserts the response shape. Build a `withStrictConsole(page)` that hooks `page.on('console', ...)` and `page.on('pageerror', ...)` to fail on any uncaught error or `console.error`/`console.warn` unless the test calls `allowConsoleMessage(matchPattern)` once. Add a `pnpm test:e2e:repeat` script that runs the full `tests/e2e/` suite twice back-to-back and fails on any divergence between the two runs.
  - Verify (RED): `pnpm test:e2e tests/e2e/harness/index.spec.ts` — a one-test spec that (a) opens a disposable database, (b) seeds a personal user, (c) issues `POST /api/auth/sign-in/email` against the real app, (d) confirms `auth_sessions` has a row, (e) installs the fake provider, (f) creates a checkout session, (g) calls `signStripeWebhook` and posts a `checkout.session.completed` event, (h) confirms the outbox received one item — fails RED on a fresh checkout with harness helpers stubbed out, GREEN only after the helper module is built. Then `pnpm test:e2e:repeat` runs the whole suite twice and must produce identical `passed/failed` counts.
  - Independent boundary: this task owns **only** `tests/e2e/harness/**` and the `playwright.config.ts`/`package.json` changes. Every later task depends on it but does not modify it.

- [x] **API E2E matrix: organizations + invitations + privacy + account cross-tenant security**
  - Files: `tests/e2e/api/organizations.spec.ts` (new), `tests/e2e/api/organizations-invitations.spec.ts` (new), `tests/e2e/api/privacy.spec.ts` (new), `tests/e2e/api/account.spec.ts` (new), `src/shared/lib/auth/organization-lifecycle.ts` (verification only — no edits unless a real bug is found and captured as a separate task)
  - Do: Build a per-route API spec that exercises every method of `src/routes/api/organizations/index.ts` (GET list, POST create, DELETE deletion-schedule), `src/routes/api/organizations/invitations/index.ts` (POST create), `src/routes/api/organizations/invitations/$invitationId.ts` (POST resend, DELETE cancel), `src/routes/api/organizations/invitations/$invitationId/accept.ts` (POST), `src/routes/api/organizations/invitations/mine.ts` (GET), `src/routes/api/organizations/members/$memberId.ts` (PATCH role, DELETE remove), `src/routes/api/organizations/transfer-ownership.ts` (POST), `src/routes/api/organizations/switch.ts` (POST), `src/routes/api/organizations/team.ts` (GET), `src/routes/api/organizations/billing.ts` (GET), `src/routes/api/organizations/deletion.ts` (DELETE cancel), `src/routes/api/me/data-export/index.ts` (POST/GET), `src/routes/api/me/data-export/$id.ts` (GET), `src/routes/api/me/delete-account/index.ts` (GET/POST/DELETE), `src/routes/api/me/builder/index.ts` (GET/DELETE), `src/routes/api/me/builders/index.ts` (GET), `src/routes/api/me/builder/$builderId.ts` (GET/DELETE), `src/routes/api/me/builder/$builderId/restrict-processing.ts` (POST), `src/routes/api/me/builder/$builderId/evidence-provenance.ts` (GET), `src/routes/api/me/plan-changes/index.ts` (GET), `src/routes/api/plans/me.ts` (GET), `src/routes/api/plans/request-upgrade.ts` (POST). For each route, assert: (1) anonymous → 401, (2) authenticated-no-org → 403 (where applicable), (3) allowed role → 200/201 with response-schema assertions on every documented field, (4) disallowed role → 403/409 with the same error message regardless of the actual reason (anti-enumeration), (5) organization A principal using organization B's `memberId`/`invitationId`/`userId` path param → 403/404 with no leakage of B's data shape, (6) invalid body (wrong type, missing required, extra unknown) → 400, (7) `Idempotency-Key` reuse on POST → second call returns the same response body, (8) rate-limit-per-user on `POST /api/organizations/invitations` (20/hr per `requireRateLimit` in `organization-lifecycle.ts`) → 21st call in the same test returns 429 after the harness advances `now()`. Privacy tests additionally assert: export payload contains no `password`/`token`/`session`/`twoFactorSecret` fields (redaction), `GET /api/me/data-export/$id` for another user's export row → 404 (not 403 — leaks no existence), 24h throttle on `POST /api/me/data-export` → 429 with `existingId`, account deletion blocked by sole-owner-with-other-members (assert `AccountDeletionOwnershipError` payload's `organizations[]` shape), account deletion cancel restores the row to `null` on `GET /api/me/delete-account`. Cover the `switch` route by setting `activeOrganizationId` and verifying the next tenant-scoped route (e.g. `GET /api/organizations/team`) reads from the new active org and not the previous one.
  - Verify (RED): `pnpm test:e2e tests/e2e/api/organizations.spec.ts tests/e2e/api/organizations-invitations.spec.ts tests/e2e/api/privacy.spec.ts tests/e2e/api/account.spec.ts` — fails RED on the harness's pre-existing `tests/e2e/` directory because the files don't exist yet; each spec asserts the full matrix above. The first run's expected failure count is `(4 files × N scenarios)`. The GREEN path is satisfied entirely by the existing route + foundation code (no production code changes); any genuine bug found during this matrix must be captured as a `test.fixme` and a separate follow-up task, never silently edited here.
  - Independent boundary: this task owns **only** `tests/e2e/api/organizations*`, `tests/e2e/api/privacy*`, `tests/e2e/api/account*`. The browser-level team-accounts journey stays in `tests/e2e/team-accounts.spec.ts` (existing); this task reuses the same `seedOrganization`/`seedPersonalUser` harness from task 1 but never touches the existing UI spec.

  **Started 2026-08-02: `tests/e2e/api/organizations.spec.ts` landed — 21 passing, 1 `fixme`.**

  Covers `GET/POST/DELETE /api/organizations`, `POST /api/organizations/switch`,
  `GET /api/organizations/team` and `DELETE /api/organizations/deletion`: anonymous refusal on all six with a
  body the schema would *accept* (an empty body only proves the validator runs), A never sees B's organization
  in the list, the create DTO carries no `stripeCustomerId`/`deletionRequestedAt`, five invalid-body shapes,
  a caller-supplied `id`/`slug` ignored rather than honoured, switch changing what the *next* tenant-scoped read
  answers for, switching into B's organization refused on membership rather than existence, the team payload
  free of `password`/`sessionToken`/`twoFactorSecret`, and delete proving it is **not addressable by id** — a
  body naming B's organization schedules the caller's own and leaves B's untouched in
  `organization_deletion_requests`.

  **One finding, captured as `test.fixme` rather than fixed here, per this task's own rule.**
  `POST /api/organizations` runs `CreateBody.safeParse` before any session lookup, so an anonymous caller gets
  400 for `{}` and 401 for `{ name: "x" }`. Authentication is not bypassed — the lifecycle service still
  refuses — but the ordering lets an unauthenticated prober read the request schema (field name, min/max
  length, type) out of status codes alone. One-line reordering; needs its own task.

  Two consecutive clean runs of `tests/e2e/api/` at `--workers=1`: 27 passed, 1 skipped.

  **`tests/e2e/api/organizations-invitations.spec.ts` landed — 17 passing, 1 `fixme`.**

  An invitation is the one object here that deliberately crosses a tenant boundary, so the properties differ
  from the rest of the matrix. Covered: anonymous refusal on all five routes; the organization invited into
  comes from the session and an `organizationId` in the body is ignored; five invalid bodies, including
  `role: 'owner'`, which is outside the enum on purpose because ownership moves through transfer-ownership and
  its recent-auth requirement; no password/session/2FA field in the payload; A refused on B's invitation with
  B's row surviving; cancel really cancelling; resend **rotating** the invitation; and `mine` answering by
  verified email rather than by organization.

  **Second finding, `test.fixme` per this task's rule: an enumeration oracle on invitation ids.** Both
  `POST` (resend) and `DELETE` (cancel) on `/api/organizations/invitations/:id` answer **403** for an
  invitation that exists in another organization and **404** for one that does not exist at all. The refusals
  are correct; the difference between them is not. Any session can sweep the id space and learn which ids are
  real — and a real invitation id says an organization is hiring and someone is mid-onboarding.

  Three of the spec's own assumptions were wrong before the routes were, and each is now recorded in the file
  so the next reader does not restore them: resend rotates the id rather than reusing it (right — it kills the
  link already in an inbox), a pending invitation holds a seat (right — otherwise an organization
  oversubscribes), and `seat_limit` is capped at 10 by
  `organization_entitlements_seat_limit_check`.

  Two consecutive clean runs of `tests/e2e/api/` at `--workers=1`: 44 passed, 2 skipped.

  **`tests/e2e/api/privacy.spec.ts` landed — 10 passing, green on the first run.**

  A data export is a GDPR right and simultaneously the most concentrated pile of one person's data the product
  ever produces, so three properties carry it. **Redaction** is asserted against the serialized body rather
  than a remembered field list — substring matching over the whole payload, blunt on purpose, because the
  danger is a future column joining the export by accident. **404 rather than 403** for another user's export,
  identical in status and body to a fabricated id, because an export id existing says a specific person
  exercised a specific right at a specific time. And the **24-hour throttle returns `existingId`**, which is
  the difference between a throttle and a data-subject right denied by a rate limiter: a user who clicks twice
  must reach the export they already have. The throttle is also proved per-user, so one account cannot deny
  the export right to every other one.

  **`tests/e2e/api/account.spec.ts` landed — 17 passing, 1 `fixme`. Task 1's four files are complete.**

  Everything under `/api/me` is keyed by the session *user*, not by an active organization, so a bug here is
  not "A read B's organization" but "A read B" — every assertion runs on that axis. Account deletion gets the
  most care: the sole-owner-with-other-members refusal is asserted to carry `organizations[]`, because a bare
  409 leaves a user holding a legal right they cannot exercise and no way to learn what to fix. Schedule and
  cancel are asserted together on purpose, read back through the route's own `GET` rather than out of a table,
  since that GET is what the settings page renders — a user who cannot see their pending deletion cannot stop
  it.

  One route deliberately answers a stranger instead of refusing: `GET /api/me/delete-account` returns
  `200 {"request": null}` so a signed-out visitor's settings page renders a sign-in prompt rather than an
  error. It leaks nothing — `null` is also what a signed-in user with no pending deletion gets. The spec first
  asserted 401 there, which would have been pinning a status code the route deliberately does not use; it now
  pins the property instead.

  **Third finding, `test.fixme`: `GET /api/me/builder/:id` returns 200 with an HTML document.** That file
  implements `PATCH` only, and an unimplemented method on a TanStack Start file route falls through to the
  route *component*. A client scripting the endpoint reads 200 and concludes it received a profile. This is
  the same defect class already fixed once this session on `PATCH /api/solutions/runs/:id`, so the follow-up
  is **"audit every `/api` file route for unimplemented methods"**, not "add a GET here".

  Two consecutive clean runs of `tests/e2e/api/` at `--workers=6`: 71 passed, 3 skipped, 16.7s.

  **Task 1 findings summary — three, none fixed here, all `test.fixme`:** `POST /api/organizations` validates
  before authenticating; resend and cancel leak invitation-id existence via 403-vs-404; `GET /api/me/builder/:id`
  answers with HTML.

- [x] **API E2E matrix: platform-admin routes and admin authorization boundaries**
  - Files: `tests/e2e/api/admin.spec.ts` (new), `src/shared/lib/auth/platform-admin.ts` (verification only)
  - Do: For every method of `src/routes/api/admin/users/index.ts` (GET), `src/routes/api/admin/users/$userId.ts` (PATCH), `src/routes/api/admin/plan-requests/index.ts` (GET/POST), `src/routes/api/admin/billing/configuration.ts` (GET/PATCH), `src/routes/api/admin/billing/run-worker.ts` (POST), `src/routes/api/admin/billing/events/$eventId/replay.ts` (POST), `src/routes/api/admin/changelog/index.ts` (GET/POST), `src/routes/api/admin/changelog/$id.ts` (PATCH), `src/routes/api/admin/roadmap/index.ts` (GET/POST), `src/routes/api/admin/roadmap/$id.ts` (PATCH), `src/routes/api/admin/incidents/index.ts` (GET/POST), `src/routes/api/admin/incidents/$id.ts` (PATCH), `src/routes/api/admin/metrics/index.ts` (GET), `src/routes/api/admin/alerts/run-worker.ts` (POST), `src/routes/api/admin/discovery/run-worker.ts` (POST), `src/routes/api/admin/embeddings/run-worker.ts` (POST), `src/routes/api/admin/enrichment/run-worker.ts` (POST), `src/routes/api/admin/sprints/run-worker.ts` (POST), `src/routes/api/admin/legal/run-worker.ts` (POST): assert (1) anonymous → 401, (2) non-admin authenticated user → 403 (using every non-admin role from the harness; verify the same response body for member vs. admin vs. owner to confirm anti-enumeration), (3) platform admin → 200/201 with response-schema assertions, (4) cron principal via `tryCronPrincipal` (`src/shared/lib/auth/cron.ts`) → 200 with the same summary shape, (5) PATCH/POST bodies with invalid zod schema → 400, (6) cross-tenant: platform admin running on tenant A's principal still operates on the named target id (the platform role is system-wide — confirm this is the intended behavior and document it inline). The metrics route additionally asserts the response shape includes `inProcess`, `db.totalUsers`, `db.activeUsers24h`, `db.activeUsers7d`, `discovery.cursor`, and `server.nodeVersion` — never asserting the exact numeric value, only the schema/presence. The billing run-worker route additionally asserts it returns the documented `WorkerRunSummary` key set (`claimedEvents`, `processedEvents`, `deferredEvents`, `retryScheduledEvents`, `deadLetteredEvents`, `expiredGrants`, `annualGrantsIssued`, `paymentBlocksApplied`, `autoRechargeTriggered`).
  - Verify (RED): `pnpm test:e2e tests/e2e/api/admin.spec.ts` — fails RED on the file's absence. Exhaustive coverage of 22 admin routes × 5 principal personas = ~110 assertions; the CI runtime budget for this file is 60s (the existing `playwright.config.ts` per-test timeout is 30s; this file's `test.describe.configure({ mode: 'serial' })` lets one worker run all serially).
  - Independent boundary: this task owns **only** `tests/e2e/api/admin.spec.ts`. Tasks 5 and 6 (webhooks/workers) build on the same `POST /api/admin/billing/run-worker` and `POST /api/admin/billing/events/$eventId/replay` routes but never modify this spec.

  **Done 2026-08-02: `tests/e2e/api/admin.spec.ts` — 168 passing.**

  Every method of every route under `src/routes/api/admin/` — 70 endpoints across 52 files — probed three
  ways: no session, a valid *paying tenant* session that is not on the allowlist, and a real platform admin.
  The middle one is the boundary that matters. An anonymous caller is refused by the session check every route
  in the app shares; a signed-in customer reaching an admin route is refused only by `ADMIN_USER_IDS`, and
  that is the check a refactor can drop with nothing else noticing.

  Two decisions worth keeping:

  - **A table, plus a filesystem assertion.** Seventy hand-written near-copies would hide the one route
    somebody forgot to add. `ROUTES` is compared against the actual files under `src/routes/api/admin/`, so a
    new admin route with no authorization probe fails *this* spec instead of shipping unprobed.
  - **The admin-positive probe is GET-only.** `POST /api/admin/billing/events/:id/replay` from a real admin
    would replay a billing event. Negative probes are safe against every method because they are refused
    before anything happens; the positive one is not. Mutating methods are covered for authorization here and
    for behaviour in the specs that own them. The positive assertion is also deliberately "not 401/403" rather
    than "200": several are `absent-id` lookups that correctly 404.

  Path params are filled with ids that cannot exist, on purpose — authorization must be decided before the
  resource is looked up, so a stranger's refusal must not depend on the id being real.

  Two consecutive clean runs of `tests/e2e/api/` at `--workers=6`: 239 passed, 3 skipped, 19.6s.

- [ ] **Billing API E2E: checkout, status, portal, subscription change/cancel/preview, credits, auto-recharge through the deterministic fake provider**
  - Files: `tests/e2e/api/billing-checkout.spec.ts` (new), `tests/e2e/api/billing-subscription.spec.ts` (new), `tests/e2e/api/billing-credits.spec.ts` (new), `tests/e2e/api/billing-portal.spec.ts` (new), `tests/e2e/api/billing-auto-recharge.spec.ts` (new), `src/shared/lib/billing/stripe-provider.ts` (only if task 1's `getBillingProviderForTesting` seam is missing)
  - Do: Install the `FakeBillingProvider` from the harness on every test. For every scenario in `FakeBillingProvider`'s `BillingScenario` union (`success | decline | timeout | delayed | sca_required | out_of_order`), drive the corresponding route and assert the response: `POST /api/billing/checkout/subscription` with `scenario=success` returns the session URL and creates one `billing_checkout_attempts` row; `decline`/`timeout` → 502 with `code: provider_error` and **no** `billing_checkout_attempts` row written; `delayed` returns `{status: 'open'}` and the harness's `settleCheckoutSession` flip → `status: 'complete'` triggers the `checkout.session.completed` webhook (task 5) and the row's `subscription_id` is populated; `sca_required` returns `{status: 'open', requiresAction: true}` and never resolves to `complete` without an explicit `settleCheckoutSession` call. Cover `POST /api/billing/checkout/credits` symmetrically with `success`/`decline`/`timeout`/`delayed`. Cover `GET /api/billing/checkout/status/$id` returning the same DTO schema for `pending|open|complete|failed` states. Cover `POST /api/billing/portal` with `invalid_url` (returns 400 with `code: invalid_url`), `no_customer` (404 with `code: no_customer`), and `success` (returns the fake-provider URL). For `POST /api/billing/subscription/change`, exercise `preview → change` (assert `previewSubscriptionChange` and `changeSubscription` are called with the same `idempotencyKey` and the second call returns the cached result), `sca_required` change (the subscription lands in `incomplete` and the response's `status` is `incomplete`, matching `fake-provider.ts`'s comment); `decline`/`timeout` → 502 with no DB write. `POST /api/billing/subscription/cancel` with `atPeriodEnd: true` (response status remains `active`, `cancelAtPeriodEnd: true`) and `atPeriodEnd: false` (`status: 'canceled'`). `POST /api/billing/subscription/preview` with a `fingerprint` mismatch (the route's anti-stale-preview guard) → 409. `POST /api/billing/auto-recharge` with a body that exceeds the rate card's `MAX_AUTO_RECHARGE_AMOUNT_CENTS` → 422 with the documented error code. For every route, additionally assert: anonymous → 401, member role in a free org → 403 (the `billing:mutate` permission gate), admin role in a free org → 403 (only owner can mutate billing — matches `permissions.ts`'s `rolePermissionTable`), tenant A principal using tenant B's `subscriptionId`/`customerId` → 404 (not 403 — confirm the tenant catch is via `withTenantContext` and that the second tenant's row is never leaked via timing-attack on the response body).
  - Verify (RED): `pnpm test:e2e tests/e2e/api/billing-*.spec.ts` — fails RED on file absence. The 5 files together cover 7 routes × 6 provider scenarios × 4 principals = ~170 assertions; the harness's `withFakeBillingProvider()` fixture scopes the in-memory provider state per test so concurrent scenarios don't bleed.
  - Independent boundary: this task owns **only** the five `tests/e2e/api/billing-*` files. The fake provider itself is read-only here; if a real bug is found in `fake-provider.ts` (e.g. a scenario that doesn't match the comment), capture as a fixme and a separate task.

  **Credit-pack checkout is done: `tests/e2e/api/billing-checkout-scenarios.spec.ts` — 7 passing, one file.**

  All six scenarios against **one** server, which the cross-process channel made possible; the five-file split
  this task assumed no longer applies to it. Each scenario is a distinct way a payment provider fails a
  customer, and each has its own wrong answer: `sca_required` must not read as paid (3-D Secure has not moved
  the money), `decline` and `timeout` must leave **no local checkout row** (a row for a payment that never
  existed is a reconciliation ghost), `delayed` succeeds at the HTTP layer and must still grant nothing (the
  normal case for bank transfers, and the easiest to get wrong), `out_of_order` must not leak into checkout at
  all, and a replayed idempotency key must not become a second payment.

  **Every assertion is against `billing_credit_grants`, not the status code.** The failure this surface exists
  to prevent is credits granted without payment, and that is invisible from an HTTP response. Even the success
  case asserts the ledger does *not* move — credits arrive when the payment settles, not when someone opens a
  checkout and walks away.

  Three wrong guesses are recorded in the file so the schema does not have to be rediscovered: there is no
  `billing_credit_ledger` table (the ledger is grants + reservations + allocations), a grant's column is
  `original_units`/`remaining_units` rather than `units` — which is what lets a grant be partly spent without
  losing what was bought — and the route answers `{ checkoutUrl, status }`.

  **Subscription checkout is done too: `tests/e2e/api/billing-subscription-scenarios.spec.ts` — 5 passing.**
  A pack is a one-off; a subscription is a *state*, so the invariant is different: the enforced tier in
  `organization_entitlements` must not move. Five scenarios, and note that two of them (`sca_required`,
  `delayed`) surface as HTTP **successes** — which is exactly why the status code cannot be the assertion.

  It is a separate file from change/preview because the starting states are opposite:
  `POST /api/billing/checkout/subscription` refuses with `409 subscription_exists` when a plan already exists,
  correctly. Keeping them together needed a load-bearing declaration order, and seeding partway through then
  collided with `billing_customers_org_livemode_unique`. The split says out loud what the ordering hid.

  **`billing-subscription-change-scenarios.spec.ts` exists and is `fixme`, for a reason worth reading.**
  `seedActiveSubscription` writes the database rows but never creates the subscription *inside the provider*,
  so under `E2E_MODE` the fake has never heard of it and `preview` answers `500` with no scenario set at all.
  The `change` test asserted `>= 400`, which a 500 satisfies — so it passed while proving nothing about
  declines. That is the false green this task exists to prevent, so both are marked rather than left running.
  **Unblocking is one fixture change:** make `seedActiveSubscription` create the subscription through the
  provider (or have the spec create it via checkout and settle it) so the database and the provider agree.

  **The scenario surface is smaller than this task assumed, and that is now measured rather than guessed.**
  The fake provider exposes fifteen methods; the E2E subclass scenario-defaults exactly **three** —
  `createCheckoutSession`, `createPaymentIntent`, `changeSubscription`. Everything else (`createPortalSession`,
  `createRefund`, `cancelSubscription`, `previewSubscriptionChange`, every getter) has **no scenario
  dimension**: passing `decline` cannot change what they do.

  So "portal, refunds, auto-recharge and cancel through six scenarios" is not remaining work — it is not
  a thing that exists. Those routes need ordinary behavioural coverage, which belongs with the routes rather
  than in a scenario matrix, and `billing-authorization.spec.ts` already holds their authorization floor.
  `createPaymentIntent` currently has no route caller at all.

  **What genuinely remains of the scenario matrix is one item:** `changeSubscription`, blocked on the fixture
  gap above. Both `createCheckoutSession` paths — packs and subscriptions — are covered and green.

  `tests/e2e/api/` at `--workers=6`: 283 passed, 5 skipped.

  `tests/e2e/api/` at `--workers=6`: 283 passed, 5 skipped.

  Two consecutive clean runs of `tests/e2e/api/` at `--workers=6`: 278 passed, 3 skipped.

  ---

  *Earlier slice:* **`tests/e2e/api/billing-authorization.spec.ts` — 31 passing.** The authorization floor,
  not the scenario matrix.

  The scenario work this task is really about — every route through `FakeBillingProvider`'s six scenarios
  (`success`, `sca_required`, `decline`, `timeout`, `delayed`, `out_of_order`), asserting what each does to the
  ledger — is **still open**, and is the five files the task names.

  What landed first is the floor underneath it, because these routes move money: a scenario test proves a
  decline grants no credits, and says nothing about whether a stranger could reach the endpoint at all. All 15
  endpoints across 13 files are probed for anonymous refusal, and each is probed with a body naming another
  organization to prove the organization always comes from the principal. Table compared against the
  filesystem, same as `admin.spec.ts`, so a new billing endpoint with no probe fails here.

  One route is deliberately not refused: `GET /api/billing/contact/verify` is a click-through target from an
  email, opened in a browser with no session, and it redirects to sign-in with a callback. Asserting 401 there
  would be asserting against the feature. It is marked `anonymous: 'link'` and probed for the property that
  matters instead — a tokenless click neither verifies anything nor names anyone.

  **The constraint that shapes the remaining work — read this before writing the scenario files.**

  The scenario seam is an **environment variable read inside the app server process**:
  `src/shared/lib/billing/stripe-provider.ts` reads `process.env.E2E_BILLING_SCENARIO` at call time, and the
  app under test is a separate `vite dev` child spawned by `startWorkerServer`. That child inherits
  `process.env` **at spawn**. `setBillingScenario()` mutates the *test worker's* env, which the already-running
  child never sees — and `startWorkerServer` memoizes one server per worker index, so a spec cannot restart it
  to pick up a new value.

  So a scenario cannot be flipped between tests in one file. It is fixed for the lifetime of the server, which
  means **one scenario per spec file** — and that, not arbitrary decomposition, is why this task names five.
  The obvious-looking alternative (call `setBillingScenario()` in a `beforeEach`) compiles, runs, and asserts
  nothing: every test would silently run under whichever scenario was in force when the server booted.

  Two ways forward, and picking one is the first decision of the next session:

  1. **One file per scenario**, each setting `process.env.E2E_BILLING_SCENARIO` before `startWorkerServer` —
     works today, no harness change, five servers' worth of boot time.
  2. **Give the fake provider a per-request channel** (a header the E2E-only subclass honours, the way the
     per-call `scenario` argument already wins over the env default). One server, scenarios flippable per
     test, and a small, E2E-only change to a file that already carries an E2E-only seam.

  Option 2 is the better shape and the task's own note — "a per-call `scenario` always wins" — suggests the
  seam was designed for it. It is a production-file edit, though, which this task forbids inside the matrix,
  so it needs to be its own task first. It is the one below, spelled out to the mechanism.

- [x] **Give the E2E billing provider a cross-process scenario channel** — done and proven end to end
  - Files: `src/shared/lib/billing/stripe-provider.ts`, `tests/e2e/harness/fakes/billing.ts`
  - **The problem, restated in one line:** the scenario is `process.env.E2E_BILLING_SCENARIO` read inside the
    app server child, and the test worker cannot reach that child's environment after it spawns.
  - **The mechanism, which already has a precedent in this codebase.** `src/shared/lib/rate-limit.ts` faces the
    same two-process split and solves it with Redis: it prefixes its keys with `process.env.E2E_REDIS_PREFIX`,
    which the harness sets per worker and the server inherits at spawn. Both processes therefore already share
    a namespaced Redis they can both address.

    So: `currentE2EDefaultScenario()` becomes async and reads `${E2E_REDIS_PREFIX}e2e:billing-scenario` first,
    falling back to `E2E_BILLING_SCENARIO` when the key is absent. The three `override` methods already await,
    so no signature outside this file changes. `setBillingScenario()` in the harness writes the key instead of
    (or as well as) mutating `process.env`.
  - **Keep the guard exactly where it is.** The lookup belongs inside
    `E2EScenarioDefaultingFakeBillingProvider`, which is only ever constructed under `E2E_MODE === 'true'`.
    Nothing on the production path gains a Redis read, and `RealBillingProvider` is untouched.
  - Verify: one spec sets two different scenarios against a single server and gets two different outcomes —
    that is the whole point, and it is impossible today. Then the five-file split in the task above collapses
    into one.
  - **Done 2026-08-02, and proven end to end.** `src/shared/lib/billing/stripe-provider.ts` reads
    `${prefix}:e2e:billing-scenario` before falling back to the env var; `setServerBillingScenario()` in
    `tests/e2e/harness/fakes/billing.ts` writes it. `tests/e2e/api/billing-scenario-channel.spec.ts` proves it
    against a running server: the same checkout request succeeds, then returns an error once `decline` is
    written, then succeeds again once the key is cleared. Same request, three outcomes, one server.
  - **That spec had to exist.** The provider falls back to the environment when the key is absent, so a dead
    channel and a working one with no scenario set are indistinguishable — every scenario spec built on an
    unproven channel would have passed while asserting against `success`.
  - Three obstacles are recorded in the spec so they are not rediscovered: return URLs must be same-origin (an
    attacker-chosen one is a phishing hop with the app's credibility behind it), the idempotency key must
    differ per call or the second request replays the first, and a pack checkout needs a
    `billing_seller_profiles` row with the country in its allowlist — seeded inline there, and the right
    moment to lift it into `tests/e2e/harness/fixtures/` is when the matrix needs it too.
  - `tests/e2e/api/` at `--workers=6`: 271 passed, 3 skipped.

- [ ] **Sweep every `/api` file route for unimplemented methods** — found twice by the matrix, then counted
  - Files: `scripts/check-api-route-methods.mjs` (new), plus whichever routes the sweep condemns
  - **Why this is a task and not two patches.** An unimplemented method on a TanStack Start file route falls
    through to the route *component*, so the request gets **200 with an HTML document** instead of 405 with an
    `Allow` header. A client scripting the endpoint reads 200 and concludes it succeeded. It was hit twice
    independently this session — `PATCH /api/solutions/runs/:id` (fixed in plans/UI Wave 8) and
    `GET /api/me/builder/:id` (`test.fixme` in `tests/e2e/api/account.spec.ts`) — which is the point at which
    a third instance stops being a coincidence.
  - **Measured 2026-08-02:** 202 route files under `src/routes/api/`. Every one declares at least one handler,
    so there is no wholly-unreachable route. But **83 of them declare only non-GET handlers**, and a `GET` to
    any of those returns an HTML page with 200 today. Not all 83 are equally exposed — some are only ever
    reached by a form post — but 83 is the surface, not the two we happened to trip over.
  - Do: add a static check that every `/api` file route either declares a handler for a method or explicitly
    rejects it with 405 and an `Allow` header, then wire it into `ci:local` next to
    `security:route-coverage`. Prefer a shared helper over 83 hand-written rejections.
  - Verify: the check fails against one deliberately-unhandled method, passes after the helper lands, and
    `GET` on a PATCH-only route answers 405 with `Allow`.

- [x] **Signed Stripe webhooks: raw-body signature verification, duplicate handling, secret rotation, internal re-routing**
  - Files: `tests/e2e/api/webhooks-stripe.spec.ts` (new); `scripts/check-route-coverage.mjs` (verify the public-allowlist entry for `src/routes/api/webhooks/stripe.ts` survives; do not edit)
  - Do: For every documented event type in `webhook-handlers.ts` (`checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.created`, `payment_intent.succeeded`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`, `account.updated`), build a real Stripe-shaped payload signed with the harness's `signStripeWebhook` helper using the **same** `STRIPE_WEBHOOK_SECRET` the harness is configured with, POST it to `/api/webhooks/stripe`, and assert: (1) `200` with `{received: true, eventId: 'evt_...'}`, (2) one `billing_webhook_events` row persisted with `payloadEncrypted` populated (the row is the **only** persistence — the route never writes subscriptions/credits/ledger), (3) calling `POST /api/admin/billing/run-worker` once after the webhook processes the row into DB effects (task 6 covers the full worker matrix; this task's webhook receive is only the inlet). Then cover the rejection paths: missing `stripe-signature` header → 400 with `code: missing_signature`; valid signature with a timestamp outside the 5-minute tolerance → 400 with `code: stale_timestamp`; signature signed with a stale `STRIPE_WEBHOOK_SECRET_PREVIOUS` but with a **current** timestamp → 200 (rotation window accepts both); wrong `api_version` in the payload → 400 with `code: wrong_api_version`; livemode mismatch → 400 with `code: wrong_livemode`; duplicate `event.id` delivery → 200 with `duplicate: true` and **no** second `billing_webhook_events` row. Cover the `X-Request-Id` header forwarding: a request with `X-Request-Id: req-test-1` is logged under that id (assert by reading the test's captured `console.error` from the `withStrictConsole` helper). Cover the no-content-type fallback: a webhook with `Content-Type: application/octet-stream` and a body that is **valid** JSON still parses (Stripe sometimes sends bytes). Cover the no-user-session property: the handler succeeds with no `auth-session` cookie set; assert by stripping the cookie from the request and confirming the 200 still returns.
  - Verify (RED): `pnpm test:e2e tests/e2e/api/webhooks-stripe.spec.ts` — fails RED on file absence. The spec asserts real `Stripe.webhooks.constructEvent` signatures over real bytes (no mock signing) — the existing `tests/unit/routes/api/webhooks/stripe.test.ts` unit tests cover the typed-error → 400 mapping with a mocked `receiveStripeWebhook`, but this task verifies the actual `Stripe.webhooks.constructEvent` path against the real library with real signing.
  - Independent boundary: this task owns **only** `tests/e2e/api/webhooks-stripe.spec.ts`. Task 6 covers the worker that consumes these persisted rows; task 4 covers the API routes that the worker's effects reach.

  **Done 2026-08-02: `tests/e2e/api/webhooks-stripe.spec.ts` — 10 passing.**

  This is the only unauthenticated write in the product: no session, no tenant, no CSRF token. The signature
  *is* the authorization, so the file is mostly refusals, one per way a signature can be wrong — absent, made
  with the wrong secret, made over **different bytes** (the forgery the raw-body read exists to stop), stale,
  from the wrong livemode, and for an unexpected API version. The last two are *correctly signed* and still
  refused, because a signature proves origin, not relevance: a live-mode event applied to test data writes real
  money records from the wrong world.

  Also covered: the previous secret still verifies, so a rotation window does not silently drop payments; a
  retried delivery is recorded once, asserted against the inbox rather than trusting two 200s; and a refusal
  echoes neither the payload nor the signature.

  Signing is hand-written HMAC rather than Stripe's SDK helper, deliberately — a test that signed with the same
  helper the server verifies with would hide a bug in that helper, because both sides would be wrong together.

  Two findings about the seam itself, recorded in the spec so they are not rediscovered: the server verifies
  with `STRIPE_WEBHOOK_SECRET`, while `E2E_STRIPE_WEBHOOK_SECRET` is a read-only accessor pointing the other
  way (it tells a harness what to sign with, and setting only it makes correct signatures fail); and the inbox
  deduplicates on `stripe_event_id`, not on the row's own `id`.

  Two consecutive clean runs of `tests/e2e/api/` at `--workers=6`: 293 passed, 5 skipped.

- [ ] **Workers and replay: claim/lease/dead-letter processing, dead-letter recovery, event replay idempotency**
  - Files: `tests/e2e/api/billing-worker.spec.ts` (new), `tests/e2e/api/billing-replay.spec.ts` (new)
  - Do: For `POST /api/admin/billing/run-worker`: seed N persisted `billing_webhook_events` rows with `status = 'pending' | 'retry_scheduled' | 'dead_lettered'` (different ages and retry counts), call the worker with a deterministic `retriever` that returns the rows in-order, then out-of-order, then with one row missing; assert the summary matches `claimedEvents === N`, `processedEvents === M`, `deadLetteredEvents === 1`, `retryScheduledEvents === K`, and the returned `eventResults[]` array carries one entry per processed row with `{eventRowId, stripeEventId, result: 'processed' | 'skipped' | 'deferred' | 'dead_lettered'}` and the documented `detail` message. Cover the **claim/lease atomicity** property: fire two concurrent `run-worker` calls (via `Promise.all` over `request.post`), assert exactly one row is claimed by the first call and the second sees `claimedEvents === 0` (the lease row's `claimed_at` is the contention point). Cover the **retry-with-backoff** property: a row whose handler throws enters `retry_scheduled` with `next_attempt_at` in the future; calling the worker before that timestamp → `deferred`; advancing the harness's `now()` past `next_attempt_at` → `processed` (or `dead_lettered` if `attempt_count` exceeds the threshold). Cover the **expired-grant sweep**: a `billing_credit_grants` row with `expires_at < now()` and `status = 'active'` is flipped to `expired` and `annual_grants_issued` is incremented by the next-sweep's annual grant amount; assert the harness's `clock.now()` controls this end-to-end. Cover the **`annual_grants_issued`** counter: a user whose `current_period_end` is within the 11-day renewal window has a new grant row created (the `dunning.ts` / `annual-grants.ts` logic). Cover the **`paymentBlocksApplied`** counter: a `invoice.payment_failed` event for an org with multiple members freezes every `billing_credit_grants` row owned by anyone in that org; subsequent `checkEntitlement` calls return `payment_blocked: true`. Cover the **`autoRechargeTriggered`** counter: a `payment_intent.succeeded` event whose `amount` exceeds the configured `auto_recharge` threshold triggers `createPaymentIntent` via the fake provider (assert via the fake's tracked `createPaymentIntent` call history). For `POST /api/admin/billing/events/$eventId/replay`: replay a `processed` row → returns `result: 'processed'` (idempotent — the handler's own upsert makes the second run a no-op, never a double effect); replay a `dead_lettered` row → flips it back to `processed` and the underlying subscription/credit effect is re-applied; replay a nonexistent `eventId` → 404 with `code: 'not_found'`; replay an `eventId` that belongs to a deleted `billing_webhook_events` row → 404 (not 410 — the route never distinguishes). Assert that every replay call writes one `audit_log` row via `auditPlatformAdminAction` carrying the acting admin's `userId` and the original `eventId` (assert against the real `audit_log` table via the harness's DB client).
  - Verify (RED): `pnpm test:e2e tests/e2e/api/billing-worker.spec.ts tests/e2e/api/billing-replay.spec.ts` — fails RED on file absence. The worker's claim/lease race is the spec's mandatory "Critical concurrency suites pass repeated runs without retries" gate (spec §Verification gates #6); it must be repeatable across 10 consecutive runs with zero flakes.
  - Independent boundary: this task owns **only** the two named spec files. It depends on task 5 (the worker needs persisted rows to process) but does not modify task 5's spec.

- [x] **Cross-tenant security matrix: every tenant-scoped API rejects organization B's identifiers on session A** — first pass done (2026-07-27)
  - Files: `tests/e2e/api/cross-tenant.spec.ts`
  - Asserts a stronger property than "denied": B's real id must be indistinguishable from a
    fabricated one on status, error key **and body length**, because a route that 404s the absent
    and 403s the other tenant has confirmed the id is real. Covers `/api/sprints/$sprintId` and
    `/api/builders/$builderId/notes`, plus two routes that must ignore client-supplied tenancy
    (`GET /api/organizations/team` with a spoofed query string, `POST /api/organizations/invitations`
    with `organizationId` in the body — the invitation lands in A).
  - Two negative controls guard against a vacuous pass, and both paid for themselves on the first
    run: `/api/alerts/$id` and `/api/me/builder/$builderId` expose only PATCH, so the GETs fell
    through to the SPA document and every id looked identical; and the notes route resolves through
    `organization_builders`, not the legacy `builders` table, so the original fixture was invisible
    to it. Both are recorded in the spec so the next person does not re-list those routes.
  - Verify (2026-07-27): 4/4 pass; removing either negative control makes two of them pass
    vacuously, which is how the two findings above surfaced.
  - Extended the same session (2026-07-27) with two more: `GET /api/me/data-export/$id`, which
    keys off the session's *user* rather than the organization — a different boundary axis, and the
    one that governs account-subject data — and `PATCH /api/organizations/members/$memberId`, the
    severe case, where a crossing write would demote another organization's owner. That one asserts
    both halves: the response is byte-identical to patching a user who does not exist, and B's role
    in B's own organization is unchanged afterwards. 6/6 pass.
  - **Not covered yet**, deliberately listed rather than implied: the billing routes
    (`/api/billing/portal`, `/api/billing/checkout/subscription`, both POST, whose schemas strip any
    client-supplied customer id — the assertion is that the response is A's, never B's) and
    `POST /api/organizations/transfer-ownership` with a `targetUserId` from B. Both need billing
    fixtures; the probe helper and `absentLike` generalise to them unchanged.
  - Files: `tests/e2e/api/cross-tenant.spec.ts` (new); `src/shared/lib/auth/tenant-principal.ts` (no edits)
  - Do: For every tenant-scoped route identified by `scripts/check-tenant-boundaries.mjs` (the existing `node scripts/check-tenant-boundaries.mjs` already enforces the importer boundary; this task enforces the **runtime** boundary), seed two organizations A and B with real `organization_members` rows, then for each route issue a request as A's session with B's `organizationId`/`memberId`/`invitationId`/`userId`/`builderId`/`exportId`/`subscriptionId`/`customerId` in the path or body (where the body schema permits it — when the schema strips the field, assert that the body version and the path version both fall back to A's tenant context, matching `organization-lifecycle.ts`'s "never trust client-supplied org" invariant). Routes to cover: `GET /api/organizations/team` (always reads A's active org), `PATCH /api/organizations/members/$memberId` where the memberId belongs to B, `POST /api/organizations/invitations` with `{organizationId: 'B'}` in the body (the route's zod schema does not include `organizationId` — assert the response is identical with and without the field, matching the existing `team-invitations.test.ts` pattern), `POST /api/organizations/transfer-ownership` with `targetUserId` from B, `GET /api/me/data-export/$id` with B's export row id, `POST /api/me/builder/$builderId/notes` with B's builder id, `GET /api/queries/index.ts` with B's saved query id, `POST /api/search/semantic` with a tenant-keyed query that should resolve to A only, `GET /api/builders/$builderId` (the tenant-private builder view, if it exists), `POST /api/billing/portal` with B's `customerId` (the route accepts no `customerId` in the body — verify the response is A's portal URL, never B's), `POST /api/billing/checkout/subscription` with B's `customerId` (same — schema strips it, response is A's checkout). For every acceptance: assert the response body matches what the **same** A-session would get without the cross-tenant identifier (proving the identifier was structurally ignored or produced a same-shape 403/404). For every cross-tenant denied: assert the response does **not** leak B's data shape — status code, error key, and content length must match the "not found" case (no `error: 'B exists'`-style leakage).
  - Verify (RED): `pnpm test:e2e tests/e2e/api/cross-tenant.spec.ts` — fails RED on file absence. The spec asserts every tenant-scoped route against the cross-tenant matrix in a single serial run; expected runtime ~90s.
  - Independent boundary: this task owns **only** `tests/e2e/api/cross-tenant.spec.ts`. Task 2's per-route matrix covers the same routes through their own org's identifiers; this task is the cross-tenant counterpart, never overlapping test data.

- [ ] **Concurrency, idempotency, and repeatability: parallel writes, idempotency keys, claim races, and two consecutive clean runs**
  - Files: `tests/e2e/concurrency/idempotency.spec.ts` (new), `tests/e2e/concurrency/parallel-create.spec.ts` (new), `tests/e2e/concurrency/claim-race.spec.ts` (new), `tests/e2e/concurrency/tenant-switch.spec.ts` (new), `package.json` (add `test:e2e:repeat`)
  - Do: For `idempotency.spec.ts`: every `POST` that takes an `idempotencyKey` (`POST /api/billing/checkout/subscription`, `POST /api/billing/checkout/credits`, `POST /api/billing/subscription/change`, `POST /api/billing/auto-recharge`) and every `POST` that takes a request-id-derived idempotency (the harness's two `Promise.all` copies of each call must produce the same response body and the same number of rows in the relevant `billing_*` table — assert the count never goes above 1). For `parallel-create.spec.ts`: `Promise.all` of N concurrent `POST /api/organizations` with the same slug input (the lifecycle generates a random suffix per call — assert all N succeed and each returns a distinct `organizationId`), `Promise.all` of N concurrent `POST /api/organizations/invitations` against the same seat-1 org (re-asserts the existing `team-accounts.spec.ts` final-seat race at the API layer — exactly one 200, N-1 409s, and assert via the `audit_log` table that one audit row exists for the success and one `denied` row exists for each failure). For `claim-race.spec.ts`: a real two-worker claim race against `billing_webhook_events` with `status = 'pending'`, two concurrent `POST /api/admin/billing/run-worker` calls, assert exactly one returns `claimedEvents > 0` and the other returns `claimedEvents === 0` (the lease column's `claimed_at` is the contention point); the persisted `billing_webhook_events` row must have **one** `processing_attempts` increment, not two. For `tenant-switch.spec.ts`: a single session issues `POST /api/organizations/switch` (to A) and `POST /api/organizations/switch` (to B) concurrently, assert the final `auth_sessions.active_organization_id` is one of A or B (never an inconsistent state) and the audit table has exactly two `organization.switch` rows. The `test:e2e:repeat` script runs `pnpm test:e2e` twice back-to-back in the same shell, captures both runs' `passed/failed/skipped` counts, and fails if the second run differs from the first.
  - Verify (RED): `pnpm test:e2e tests/e2e/concurrency/*.spec.ts` — fails RED on file absence. Then `pnpm test:e2e:repeat` runs the full suite twice and must produce identical counts; this is the spec's Verification gate #5 ("The full suite passes twice consecutively from a clean deterministic database state") and gate #6 ("Critical concurrency suites pass repeated runs without retries").
  - Independent boundary: this task owns **only** the `tests/e2e/concurrency/**` directory and the `package.json` script. The `team-accounts.spec.ts` final-seat race is the browser-level counterpart to `parallel-create.spec.ts`'s API-level race; both stay.

- [ ] **Browser E2E: organizations + invitations + privacy + account user-visible journeys**
  - Files: `tests/e2e/organizations-and-invitations.spec.ts` (new), `tests/e2e/privacy-and-account.spec.ts` (new), `src/modules/dashboard/components/TeamSettingsPage.tsx` (verification only; add `data-testid` only where existing semantics are insufficient), `src/routes/_dashboard/settings/team.tsx` (verification only)
  - Do: For `organizations-and-invitations.spec.ts`, extend the existing `team-accounts.spec.ts` journey without duplicating it: (a) **stale-active-org behavior** — create a user, remove their active org from the members table directly via the harness's DB client (simulating the cascade when a teammate is removed), reload the dashboard, confirm the user is redirected to the org switcher with a "select an organization" affordance and **no** private data from the removed org is rendered. (b) **Invitation expiry** — create an invitation, advance the harness's `now()` past `expiresAt`, attempt to accept, confirm the same generic `403 'This invitation is no longer valid'` (re-asserting the enumeration-safety property at the browser layer). (c) **Invitation for wrong email** — A creates an invite for `wrong@example.com`, B (signed in as `right@example.com`) clicks the same `devLink`, confirm the same generic 403. (d) **Invitation cancellation race** — A cancels a pending invitation while B is mid-accept; confirm exactly one of (cancel succeeds, accept succeeds) wins and the other gets the generic 403. (e) **Seat-limit copy** — set `organization_entitlements.seat_limit = 1`, attempt to invite, confirm the UI shows the seat-limit error from the 409 response. (f) **Stale-session trip on ownership transfer** — simulate a session whose `authenticatedAt` is > 15 minutes old (the harness's `authSessionCreate` helper accepts a `createdAtOffset` for this), confirm the danger zone shows the "Sign in again" CTA pointing at `/auth/sign-in?redirect=/settings/team`. (g) **Mobile keyboard + viewport** — `@mobile-only` test for the Team settings page already exists in `team-accounts.spec.ts`; this task adds the same for the dashboard's org switcher and the privacy page. For `privacy-and-account.spec.ts`: (a) data export happy path — request, see the row in `/settings/privacy`, request again within 24h → 429 with `existingId`, advance the harness clock past 24h → succeeded; assert the email outbox received one `sendExportReadyEmail` call. (b) account deletion — sole-owner of a personal workspace with no other members → succeeds with a `referenceId`; sole-owner of an org with another member → blocked with `AccountDeletionOwnershipError` and the org's name visible; (c) account deletion cancel — schedule, see the pending banner, cancel, see the row back to `null` (no `referenceId`); (d) `restrict-processing` flow — request restriction, confirm the builder's restricted flag is set, attempt to fetch via `GET /api/me/builder/$builderId` → field absent in the response DTO; (e) download an export — assert the file is a valid JSON document with `consents`, `notes`, `savedQueries`, `trackings`, `planChanges`, and `exports` keys, **never** `password`, `token`, `twoFactorSecret`, or `session` keys.
  - Verify (RED): `pnpm test:e2e tests/e2e/organizations-and-invitations.spec.ts tests/e2e/privacy-and-account.spec.ts` — fails RED on file absence. The browser layer covers journeys; the API matrix (task 2) covers the contract. The two specs must not repeat the same assertion — if `team-accounts.spec.ts` already covers the case, leave it there and add only the new browser-level cases here.
  - Independent boundary: this task owns **only** the two named files. Never edits `team-accounts.spec.ts` or `signup-active-organization.spec.ts`.

- [ ] **Browser E2E: billing — checkout, return, status, subscription change/cancel, portal, credits, auto-recharge through the fake provider**
  - Files: `tests/e2e/billing/checkout-and-return.spec.ts` (new), `tests/e2e/billing/subscription-lifecycle.spec.ts` (new), `tests/e2e/billing/credits-and-auto-recharge.spec.ts` (new), `src/modules/billing/CheckoutReturn.tsx` (verification only), `src/modules/billing/PlanChangePreview.tsx` (verification only)
  - Do: For `checkout-and-return.spec.ts`: (a) Owner clicks "Upgrade" from `/settings/billing`, fills the disclosures, submits; the harness's `FakeBillingProvider` returns the `checkout.session.completed` URL; the browser confirms the URL is rendered in the iframe/redirect and the UI does **not** trust the redirect URL to advance state (the `CheckoutReturn.tsx` page polls internal `/api/billing/checkout/status/$id` only — verify by intercepting the redirect URL after return and confirming the page still polls and waits for the worker's `processed` write). (b) `delayed` scenario — submit, redirect to `/settings/billing/checkout/return?session_id=cs_...`, see the "waiting for payment" state, settle the harness's checkout session via `setProviderScenario('delayed')` and `settleCheckoutSession`, run one worker invocation via `POST /api/admin/billing/run-worker` (the harness exposes a `runWorker()` helper that calls the admin route as the seeded platform admin), refresh the page, see the success state. (c) `decline` scenario — submit, see the error toast from `CheckoutError.code: provider_error`, confirm no `billing_checkout_attempts` row was written (visible via the DB client). (d) `sca_required` scenario — submit, see the "Authentication required" UI, the page never advances to `complete` without further action. For `subscription-lifecycle.spec.ts`: (a) Owner opens `/settings/billing`, sees the current plan + seat usage; (b) `Subscription change` flow — preview, see the proration amount, change, see the new tier; assert the `NextPaymentDate` is the period end of the prior plan (the fake provider's `currentPeriodEnd`); (c) `sca_required` change — see "incomplete" status, never advance; (d) Cancel at period end — see `cancelAtPeriodEnd: true`, the UI shows "Active until $date"; (e) Cancel immediately — see `status: 'canceled'`, the UI shows the entitlement downgrade. For `credits-and-auto-recharge.spec.ts`: (a) Buy a credit pack — the fake provider's `createPaymentIntent` is called once, the allocation ledger has one row, the balance is the package amount; (b) `delayed` payment intent — see the "processing" UI, settle, see the credits land; (c) Auto-recharge toggle — enable for a pack, simulate a usage event that drops the balance below the threshold, run the worker, see a new `createPaymentIntent` call in the fake's history and a new allocation row. For every browser step, assert console strictness (no uncaught errors), network strictness (no failed/unexpected 5xx), and the `data-testid` selectors that already exist on `OrganizationBillingCard`, `PlanChangePreview`, `AutoRechargeSettings`, `CheckoutReturn` (add only where semantics are insufficient).
  - Verify (RED): `pnpm test:e2e tests/e2e/billing/*.spec.ts` — fails RED on file absence. The `CheckoutReturn.tsx` polling path is a real documented behavior (the design's "polls internal state only, never trusts the redirect URL"); the test must observe the actual `setInterval`/`fetch` cadence to prove it, not just assert the final state.
  - Independent boundary: this task owns **only** the `tests/e2e/billing/` directory. Tasks 4 and 5 cover the API counterpart on the same routes — these specs exercise the browser, those exercise the contract.

- [ ] **Browser E2E: admin — users, plan-requests, billing configuration, incidents, roadmap, changelog, metrics, workers**
  - Files: `tests/e2e/admin/admin-users.spec.ts` (new), `tests/e2e/admin/admin-billing.spec.ts` (new), `tests/e2e/admin/admin-content.spec.ts` (new), `tests/e2e/admin/admin-workers.spec.ts` (new), `src/modules/admin/billing/SellerConfiguration.tsx` (verification only)
  - Do: For `admin-users.spec.ts`: (a) sign in as platform admin, navigate to `/admin/users`, see the users list with plan badges; (b) change a non-admin user's plan from free to pro, see the success toast, assert the `audit_log` table has one `admin.user.plan-change` row; (c) attempt to downgrade a user whose personal workspace has more members than the new plan's seat limit → 409 with the seat-limit error message and the action is rolled back (the route's `setUserPlan` throws `SeatLimitExceededError`); (d) attempt `/admin/users` as a non-admin → redirect to `/dashboard` with a 403 toast (the admin route guard). For `admin-billing.spec.ts`: (a) admin opens `/admin/billing`, sees the seller configuration form; (b) update a configuration field, see the persisted value, assert the `audit_log` row carries the diff; (c) attempt as non-admin → 403. For `admin-content.spec.ts`: (a) create a roadmap item, see it on the public `/roadmap` page; (b) edit the item, see the change reflected; (c) create an incident, see it on `/status`; (d) resolve the incident, see it disappear from `/status`; (e) create a changelog entry, see it on `/changelog`. For `admin-workers.spec.ts`: (a) seed a `pending` `billing_webhook_events` row, navigate to `/admin/billing`, click "Run worker", see the summary; (b) navigate to `/admin/billing/events`, see the row, replay it, see the result; (c) navigate to the same page as a non-admin → 403 redirect. For every browser step, assert console strictness and network strictness.
  - Verify (RED): `pnpm test:e2e tests/e2e/admin/*.spec.ts` — fails RED on file absence. The admin UI surfaces are reached via the existing `src/routes/_admin/` route tree (verify the actual route paths exist before writing assertions; if any admin page is missing, add a separate task — do not stub it here).
  - Independent boundary: this task owns **only** the `tests/e2e/admin/` directory. Tasks 5 and 6 cover the worker's API surface; this task covers the user's click path to the same buttons.

- [ ] **Coverage manifest, CI wiring, and the two consecutive clean runs gate**
  - Files: `scripts/check-route-coverage.mjs` (extend to require an E2E disposition per route), `tests/e2e/_coverage/manifest.json` (new — generated by `scripts/check-route-coverage.mjs`), `.github/workflows/quality.yml` (add the repeatability run to the nightly job), `playwright.config.ts` (add the `chromium-api` project for headless HTTP-only runs), `docs/operations/local-e2e.md` (new), `package.json` (add `test:e2e:coverage`, `test:e2e:nightly`)
  - Do: Extend `scripts/check-route-coverage.mjs` to scan `tests/e2e/api/**` and `tests/e2e/*/​*.spec.ts` for each route's path string and emit a manifest that maps `route → e2eFile → status ('covered' | 'documented-n/a' | 'missing')`. The script's exit code is `1` when any route is `missing` — CI fails when a new route is added without a cover or an explicit `n/a` disposition. Add a `tests/e2e/_coverage/manifest.json` file generated by the script, checked into the repo as the expected disposition (one of: a covering `tests/e2e/...spec.ts` path, or an `n/a` reason). Wire `pnpm test:e2e:coverage` into `pnpm test:e2e` as a pre-step. In `playwright.config.ts`, add a `chromium-api` project (`use: { ...devices['Desktop Chrome'] }`, `grep: /@api/`, `testMatch: /e2e\/api\/.*\.spec\.ts/`) so the API matrix runs separately from the browser journeys and can be invoked in parallel in CI. In `.github/workflows/quality.yml`, add a `nightly` job that runs `pnpm test:e2e:nightly` (which runs `pnpm test:e2e:repeat` against the full suite twice + the `chromium-api` and `mobile` projects + the `repeatability` script), uploads the HTML report, traces, and screenshots, and comments the manifest diff on the PR. Document the full flow in `docs/operations/local-e2e.md` — the harness's `withDisposableDatabase()` schema, how the fake provider is installed, how the email outbox is captured, how the webhook signer works, the manifest schema, how to add a new route to the manifest, and the "two consecutive clean runs" gate.
  - Verify (RED): delete `tests/e2e/_coverage/manifest.json` and re-run `node scripts/check-route-coverage.mjs` — fails because the manifest is missing. Restore the file's content from a known-good source and the script passes. Then `pnpm test:e2e:nightly` runs the full suite twice and the aggregated `passed/failed/skipped` JSON is identical between runs; this is the spec's Verification gate #5 and #6.
  - Independent boundary: this task is the **last** task — it depends on every prior task in this file and on the harness (task 1). It does not add new scenarios; it makes the existing ones enforceable and observable.

---

## Future (out of scope for this task list)

- Optional `stripe.sandbox` contract checks against the real Stripe test account (the spec explicitly says "Optional sandbox contract checks may be added separately later"). The fake provider already covers the full contract; the sandbox check is an additive CI job, not a replacement.
- Cross-engine Safari/Firefox coverage. The current `chromium` and `mobile` projects cover the Chromium + chromium-mobile matrix; adding WebKit or Firefox is a future dependency-install decision.
- Long-horizon visual regression with screenshot diffs. The `chromium` project already takes screenshots on failure; full visual regression needs a baseline-management flow this plan doesn't establish.
- Load testing. The `repeatability` script catches concurrency flakes, not throughput; a k6 or Artillery harness is a separate track.
- The `signup-active-organization.spec.ts` follow-up documented in `27-team-accounts/spec.md` task 9 — better-auth hook-ordering fix that removes the workaround in the team-accounts journey. That bug fix lives in `team-accounts` (or a spawned follow-up plan), not here.
