# Exhaustive Local E2E Test Architecture

**Date:** 2026-07-23
**Status:** Approved

## Goal

Build the broadest practical deterministic E2E coverage for BuilderHunt locally, using real PostgreSQL and simulated external-service boundaries. Cover user-visible journeys and HTTP contracts across success, empty, loading, validation, authorization, tenant-isolation, failure, retry, idempotency, concurrency, responsive, keyboard, and accessibility states.

## Scope

The suite covers:

- Public landing, exploration, pricing, roadmap, changelog, blog, status, builder profiles, and legal pages.
- Sign-up, sign-in, sign-out, forgot-password, reset-password, session expiry, redirect preservation, and negative authentication states.
- Welcome, search, save, skip, completion, and persistence branches of onboarding.
- Dashboard, search, tracked builders, builder profiles, notes, claims, evidence, exports, alerts, sprints, recommendations, and account settings.
- Organization creation, switching, invitation, acceptance, cancellation, expiry, role changes, removal, leaving, deletion, ownership transfer, seat limits, and stale-session behavior.
- Privacy export and account-deletion workflows, including ownership blockers and cancellation.
- Billing checkout, return, status, subscription changes, cancellation, credit packs, webhooks, workers, replay, and role restrictions through a deterministic fake provider.
- Platform-admin users, plans, billing, incidents, metrics, roadmap, changelog, workers, and authorization boundaries.
- Runtime security behavior for all API routes, including anonymous denial, role matrices, tenant isolation, forged identifiers, trusted origins, response redaction, and rate limits.

Live external providers and real financial transactions are excluded from the required local suite. Optional sandbox contract checks may be added separately later.

## Chosen harness primitives

- **Database isolation:** one disposable PostgreSQL database per Playwright worker on the existing PostgreSQL instance, created from `DATABASE_MIGRATION_URL`, migrated under the repository's advisory-lock helper, assigned to the worker server process through `DATABASE_URL`, and dropped during global teardown. Deliverable 1 begins with a spike proving two workers can create, migrate, mutate, and drop independent databases concurrently. Browser tests within one worker use unique fixture identifiers; destructive state tests receive a fresh worker database run.
- **Cache isolation:** Redis is required for E2E. Each worker receives an `E2E_RUN_ID`/worker-prefixed namespace. Global teardown deletes only that prefix. The process-global in-memory fallback is forbidden in E2E and must fail fast when Redis is unavailable.
- **Time:** `E2E_FIXED_TIME` plus fixture-seeded timestamps define clock-sensitive states. Production paths needing current time receive the smallest injectable clock seam necessary, introduced test-first.
- **Principals:** fixture-seeded users are canonical for role/state matrices. Real sign-up remains a separate regression journey. The harness may set `email_verified` directly because no product email-verification flow exists. Personal and team organizations always receive explicit entitlement rows. A single test-local password constant is allowed and must never be accepted outside E2E mode.
- **Hydration:** `waitForHydration(page)` waits for a root hydration-ready signal and network quiescence; arbitrary per-spec delays are prohibited.
- **Workers:** tests invoke worker HTTP endpoints deterministically with platform-admin or `CRON_SECRET` authorization and then poll database/UI state. No background scheduler timing is assumed.
- **External services:** E2E mode is enabled explicitly with `E2E_MODE=true`. Billing scenarios use the existing fake-provider vocabulary; email uses a test outbox; discovery/AI use named deterministic scenarios; unexpected network egress fails the test.

## Coverage manifest

Create a machine-readable TypeScript manifest as a strict superset of `scripts/check-route-coverage.mjs`. Every application and API route must declare one disposition: `browser`, `api`, `both`, or `not-applicable`, plus owned spec paths and a reason for `not-applicable`. The checker fails on missing routes, missing spec files, invalid dispositions, and duplicate ownership.

Explicit domains include Solutions Intelligence, queries, recommendations, AI capability routes, feeds, OG endpoints, public content, builder notes/claims/evidence, discovery, embeddings, and enrichment workers.

## Architecture

### 1. Central E2E harness

Create a shared Playwright fixture package responsible for:

- Disposable real-PostgreSQL databases or isolated database shards.
- Schema migration and deterministic fixture seeding.
- Test principals: anonymous, unverified user, verified user, organization member, organization admin, organization owner, and platform admin.
- Personal workspaces, organizations A and B, configurable entitlements, billing rows, invitations, exports, deletions, and worker events.
- Authenticated storage states for common roles.
- Browser helpers for hydration-safe navigation, overlay handling, downloads, multiple contexts, and stable assertions.
- Test cleanup that removes only data owned by the current test or drops its disposable database.

Existing helper logic in `tests/e2e/team-accounts.spec.ts` must move into reusable fixtures instead of being copied.

### 2. Browser E2E suites

Organize browser specs by bounded product domain:

- `public-and-consent`
- `auth-and-sessions`
- `onboarding`
- `dashboard-and-navigation`
- `search-and-tracking`
- `builder-profiles`
- `alerts`
- `sprints`
- `exports`
- `organizations-and-invitations`
- `privacy-and-account`
- `billing`
- `admin`
- `responsive-and-accessibility`

Each suite uses semantic selectors first and stable `data-testid` selectors where semantics are insufficient. Production components may receive focused test IDs only when no stable user-facing selector exists.

### 3. API E2E suites

Exercise route handlers through live HTTP against the real application and real PostgreSQL. Group all API routes by resource and authorization boundary. Every protected route must receive at least:

- Anonymous request.
- Authenticated request without a valid active organization where applicable.
- Allowed role request.
- Disallowed role request.
- Organization A principal using organization B identifiers.
- Invalid path, query, and body input.
- Resource-not-found behavior.
- Relevant duplicate, retry, rate-limit, idempotency, and concurrent operations.
- Response schema and sensitive-field redaction assertions.

The route inventory and static authorization matrix act as the coverage manifest. A machine-readable manifest should fail CI when a route is added without an explicit E2E disposition.

### 4. External-service boundaries

#### Billing and Stripe

Use the billing provider contract and deterministic fake provider for checkout, status, subscription, portal, pack, timeout, and provider-failure scenarios. Generate genuinely signed webhook payloads with fixed test secrets so raw-body and signature verification remain real. Inject deterministic event retrieval for worker and replay scenarios.

#### Email

Use a fake outbox. Password-reset and invitation tests assert message creation, recipient, template intent, and token-link behavior without contacting a real provider or leaking tokens into logs.

#### Discovery and AI

Stub connectors at provider boundaries with deterministic payloads for success, empty results, malformed data, hostile text, timeouts, upstream rate limits, and fallback behavior. BuilderHunt HTTP routes and UI remain real.

#### Cache

Use an isolated deterministic cache implementation or isolated test Redis. Verify tenant-key separation, invalidation after organization switching, and stale-tab behavior.

## Coverage model

Each flow is tested through relevant combinations of:

- Happy path.
- Empty state.
- Loading and disabled controls.
- Invalid input and server validation.
- Recoverable and terminal failure.
- Retry and refresh.
- Duplicate submission.
- Sequential idempotency.
- Concurrent idempotency or race behavior.
- Session refresh and expiry.
- Multiple tabs or browser contexts.
- Organization A versus organization B.
- Member, admin, owner, and platform-admin permissions.
- Free, pro, and team entitlement states.
- Desktop, tablet, and mobile layout.
- Keyboard operation, focus management, reduced motion, and automated accessibility checks.

Not every Cartesian-product combination belongs in the browser layer. Browser suites prove representative journeys and presentation states; API E2E suites exhaustively cover contract, role, tenant, concurrency, and failure matrices.

## Determinism and isolation

- No live Stripe, email, discovery, AI, or other third-party calls in required tests.
- No hard-coded developer credentials.
- No fixed shared fixture identifiers.
- No arbitrary waits. Existing hydration handling should become a condition-based helper; temporary timing guards are allowed only when documented by runtime evidence and bounded centrally.
- Tests own their database namespace and can run independently.
- Time-dependent flows use an injectable clock or explicitly seeded timestamps.
- Rate-limit state is isolated by test identity and cache namespace.
- Tests may run repeatedly without accumulating database records.

## Execution strategy

Use three concurrent subagents after the database/cache isolation spike and shared harness are merged, and only when each agent owns disjoint files. Shared fixture and configuration changes remain serialized. Integrate in waves, review every wave, and run the aggregate suite after each wave.

Initial execution remains `workers: 1`. The isolation spike must prove `workers: 2` locally and in CI before the API and independent browser projects enable parallel execution. Pull-request smoke uses at most two isolated workers; nightly full coverage may use three isolated workers. Development-agent concurrency and Playwright worker concurrency are separate controls.

Playwright projects should distinguish:

- Critical Chromium browser journeys.
- Mobile Chromium responsive journeys.
- Tablet responsive journeys.
- Accessibility-focused representative journeys.
- API E2E suites.

Parallelism is enabled only after database and cache isolation are proven. Until then, suites remain single-worker to protect correctness.

## CI strategy

- Pull requests: fixture validation, route-coverage manifest, critical browser smoke, API authorization smoke, lint, type-check, unit tests, and build. Smoke includes sign-up/sign-in, onboarding completion, search/track, organization invite/accept, privacy export request, billing fake checkout return, one admin authorization check, and public route health. Concurrency stress is excluded from PR smoke.
- Main/nightly full matrix: all browser domains, API route matrix, responsive/accessibility projects, `--repeat-each=2` repeatability, and critical concurrency tests repeated five times without Playwright retries.
- CI uses `video: 'retain-on-failure'` and retains HTML reports, traces, screenshots, videos, JUnit, and JSON results for 14 days on failure.
- A global unexpected-console/network collector fails on unallowlisted browser console errors, page errors, failed BuilderHunt requests, or third-party network egress. Tests register explicit expectations before triggering intentional failures.
- Quarantined tests require an issue reference, documented cause, owner, and expiration date. Increasing timeouts is not an accepted flake fix.

## Verification gates

The implementation is complete only when:

1. Every application route and API route appears in the TypeScript coverage manifest with a `browser`, `api`, `both`, or reasoned `not-applicable` disposition, and every referenced spec exists.
2. All identified product domains have browser coverage for their critical journey and primary negative states.
3. Protected API routes have runtime authorization and tenant-isolation coverage.
4. Billing, email, discovery/AI, and cache tests make no live external requests.
5. `pnpm test:e2e:full -- --repeat-each=2` passes from independently created worker databases and teardown leaves no disposable databases or Redis prefixes.
6. Critical races—final-seat invitation, duplicate invitation acceptance, saved-query creation, privacy export request, checkout idempotency, subscription change, webhook receipt, and worker lease claim—pass five consecutive runs with Playwright retries disabled.
7. Browser console errors, page errors, failed BuilderHunt requests, and external egress are globally rejected unless explicitly expected by the test.
8. `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build`, `pnpm security:boundaries`, `pnpm security:route-coverage`, `pnpm security:dependencies`, `pnpm test:rls:local`, `pnpm test:api-isolation:local`, database migration checks, and all E2E scripts pass.
9. Harness usage, local prerequisites, smoke/full commands, fixture principals, fake-service scenarios, artifact locations, and debugging procedures are documented.
10. A final `git status --short` review confirms unrelated pre-existing working-tree changes were not modified.

## Delivery order

1. Database-isolation spike: two concurrent workers independently create, migrate, mutate, and drop databases; E2E Redis isolation fails closed and cleans its prefix.
2. Principal, organization, entitlement, clock, hydration, console/network, storage-state, and cleanup fixtures; migrate existing team-account helpers without changing behavior.
3. Fake billing, signed webhook, email outbox, discovery/AI scenario, cache, and controlled-worker boundaries.
4. Route coverage manifest/checker and CI artifact/report plumbing. Harness milestone: a minimal smoke spec exercises server startup, seeded authentication, database mutation, Redis mutation, and full teardown.
5. Auth, sessions, onboarding, public content, consent, dashboard, navigation, feeds, OG, and the fresh-sign-up regression.
6. Search, tracking, builder profiles, notes, claims, evidence, alerts, sprints, exports, recommendations, Solutions Intelligence, and AI capability routes.
7. Organizations, invitations, privacy, account, and cross-tenant matrices.
8. Billing, signed webhooks, workers, replay, admin, discovery, embeddings, and enrichment matrices.
9. Responsive, accessibility, multi-tab, concurrency, repeatability, full-suite stabilization, and documentation.

## Risks

- The current Playwright configuration is single-worker because tests share local state. Parallel execution must wait for proven database isolation.
- Fresh sign-up, email verification, and active-organization behavior currently require workarounds. Fixtures must represent these states explicitly while preserving regression tests for actual user-visible behavior.
- Some surfaces lack stable selectors. Add only targeted selectors instead of coupling tests to styling or DOM structure.
- Full route and state coverage will create a large suite. Keep smoke and full matrices separate to preserve pull-request feedback speed.
