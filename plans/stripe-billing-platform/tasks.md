# Tasks: Stripe Billing Platform

> **Status**: `in_progress` (4/~40 tasks — dependency contracts pinned, launch register recorded, Stripe
> SDK/client/catalog/fake-provider built; the rest of §1 ("Validate Stripe Products and Prices") and
> everything after it needs a real Stripe sandbox account and business/legal sign-off not available in
> this session — see `docs/operations/stripe-launch-register.md`)
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/tasks.md),
> [`team-accounts`](../team-accounts/tasks.md)
> **Blocks**: [`calendar-scheduling-interview-intelligence`](../calendar-scheduling-interview-intelligence/tasks.md)
> **Reality check**: no Stripe package or billing-credit runtime exists. Organization entitlement,
> tenant context, RLS foundations, manual plan records, pricing, and billing settings already exist
> and must be migrated rather than duplicated. Migration `0019` is an unrelated in-progress change;
> generate the next available migration instead of editing it.

## 0. Lock dependencies and commercial configuration

- [x] **Verify organization billing dependency contracts**
  - Files: `src/shared/lib/auth/tenant-principal.ts`, `src/shared/lib/authorization/permissions.ts`, `src/shared/lib/repositories/entitlements.ts`, `src/shared/lib/organizations/contracts.ts`, `src/shared/lib/billing/dependency-contracts.test.ts`
  - Do: Pin active-organization resolution, `owner | admin | member`, owner-only billing mutation, admin read, platform-admin separation, accepted-member plus usable-invitation seat count, and canonical entitlement interfaces. Add a boundary test forbidding billing modules from accepting organization IDs as authority or importing Better Auth/DB rows into DTOs.
  - Verify: `pnpm vitest run src/shared/lib/billing/dependency-contracts.test.ts && pnpm security:boundaries` passes after security/team dependencies are complete.
  - Progress (2026-07-23): security-and-multitenancy (17/19, rest correctly blocked on production observation) and team-accounts (9/9) are both substantially complete, so this task's dependency contracts were pinnable now rather than deferred. Created `src/shared/lib/billing/` (new module, first file) with `dependency-contracts.test.ts` — 10 tests pinning: `resolveTenantPrincipal`'s `{userId, organizationId, role, requestId}` derivation (rejects no-session/no-active-org); `can()`'s owner-only (`organization:transfer`/`delete`) vs. any-role-read (`organization:read`) vs. elevated-mutate (`organization:update`) pattern, which billing subscription mutation/read will reuse; `resolvePlatformAdminPrincipal`'s structural separation from organization role (no `organizationId`/`role` field, distinct allow-list); `toSeatUsageDto`'s `{used, limit}` shape; and `resolveEntitlementPolicy`'s tier/status/paid-actions derivation. Also added a forward-looking boundary check (`billing module boundary` describe block) that scans every non-test file under `src/shared/lib/billing/` for a bare `organizationId: string` first parameter (should be a `TenantPrincipal`) or a direct `better-auth`/`db/schema`/`db/index` import — trivially passes today (no real billing module exists yet) but starts enforcing the moment phase 1 adds one. Deliberately thin: each contract already has its own exhaustive unit test elsewhere (`tenant-principal.test.ts`, `permissions.test.ts`, `entitlements.test.ts`) — this file only pins the surface those tests already prove, framed in terms of what billing will actually consume.
  - Verified: `pnpm vitest run src/shared/lib/billing/dependency-contracts.test.ts` → 10/10, `pnpm security:boundaries` clean, `pnpm type-check`/`pnpm lint` (0 errors) clean, full test suite 648/648 (up from 638, +10 new).
  - Not started: everything past this task requires either a real Stripe sandbox account/API keys (which this session has no access to) or business/legal decisions (Denmark-only allowlist, tax classification, KYC evidence, catalog pricing sign-off) that aren't mine to make — see task 2 ("Record the launch decision register") and the `plan.md` Phase 0 gate.

- [x] **Record the launch decision register without personal identifiers**
  - Files: `docs/operations/stripe-launch-register.md`, `plans/_meta/app-reality.md`, `.env.example`
  - Do: Record USD-only catalog, Denmark-only customer allowlist, individual seller classification, required CVR/VAT/OSS review, approved card/wallet methods, Terms/Privacy versions, Stripe API version, support/refund owner, financial retention decision, and every live release gate. Add documented placeholders only; never add CPR, home address, private bank/card data, or live secrets.
  - Verify: repository secret/PII scan finds no personal identifier; register has an owner and evidence field for every gate.
  - Progress (2026-07-23): created `docs/operations/stripe-launch-register.md` with one table per decision area (catalog/currency, seller/country, payment methods/consent, legal documents, support/operations, technical pins) plus a release-gate checklist — every row starts `_pending_`/`_not designated_` since no Stripe account or business sign-off exists yet in this session. Added `STRIPE_BILLING_ENABLED`/`STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`STRIPE_API_VERSION` to `.env.example` (names only, no values). Corrected the stale billing note in `plans/_meta/app-reality.md` (Team price was documented as $99, matching the *legacy* system — not a bug, but flagged the doc's broader staleness — orgs/RLS, semantic search, sourcing sprints are all now implemented but still listed as "NOT implemented" — as a separate background task rather than a full rewrite here). No PII/secrets anywhere in the register by construction (every field is a placeholder or a yes/no + date, never an ID/card/bank value).

## 1. Provider and catalog foundation

- [x] **Install and pin the Stripe server dependency**
  - Files: `package.json`, `pnpm-lock.yaml`, `.env.example`, `src/shared/lib/billing/stripe-client.ts`, `src/shared/lib/billing/stripe-client.test.ts`
  - Do: Add the official Stripe Node SDK at an exact tested version. Create a server-only lazy client with pinned API version, bounded retries, operation idempotency, request-ID/redacted logging, separate test/live keys and webhook secrets, `STRIPE_BILLING_ENABLED`, and no client-bundle import path.
  - Verify: tests prove disabled/missing/mixed-mode configuration fails closed; `pnpm build` contains no secret value or server Stripe client in browser chunks.
  - Progress (2026-07-23): `pnpm add stripe@22.3.2 --save-exact` (exact pin, no `^`). `stripe-client.ts` exports a pure `resolveStripeClientConfig()` (disabled/missing-key/malformed-key/missing-version all throw `StripeBillingDisabledError`, mirroring `resolveTenantPrincipal`'s injectable-pure-function pattern so it's unit-testable without the frozen `env` singleton) plus the real lazy-singleton `getStripeClient()` that calls it with real `env` values. Added the same fail-closed validation to `env.ts`'s zod schema itself — deliberately placed *before* the existing production-only early return, unlike `ENRICHMENT_ENABLED`'s checks, since sandbox testing with real Stripe test keys is expected in every environment, not just production; a live key (`sk_live_`) outside `NODE_ENV=production` is also rejected there. Added `idempotencyKeyFor()` and `redactStripeError()` (uses `error.rawType`, not `error.type` — the latter is the SDK's own subclass name like `StripeCardError`, not Stripe's documented API-level error type). Added a full-directory sweep to `client-route-boundary.test.ts` (`billing module boundary`) that fails if any file under `src/routes/**`/`src/modules/**` imports `~/shared/lib/billing/stripe-client`. Verified: `pnpm build` — grepped `dist/client/` for `stripe`/`sk_test_`/`sk_live_`/`STRIPE_SECRET_KEY`; only false positives found (`bg-striped-terracotta` CSS utility class) and the zod *schema/validation code* (variable names, regex, error messages) for STRIPE_* vars, which is pre-existing, intentional behavior for every var in `env.ts` (real secret values never reach the client — the browser stub object in `env.ts` never includes them) — no actual secret leaked. `pnpm vitest run src/shared/lib/billing/stripe-client.test.ts src/shared/lib/env.security.test.ts src/shared/lib/client-route-boundary.test.ts` all pass; sanity-checked the exhaustiveness claim in the next task's catalog by temporarily deleting a tier and confirming `tsc` fails, then restoring it.

- [x] **Define the immutable billing catalog**
  - Files: `src/shared/lib/billing/catalog.ts`, `src/shared/lib/billing/catalog.test.ts`, `src/shared/lib/billing-shared.ts`, `src/shared/lib/billing.test.ts`
  - Do: Add `pro_max`; set Pro $19/$182/140, Pro Max $79/$758/700, Team $199/$1,910/2,100/10 seats, and the three pack definitions. Model version, currency, interval, tax behavior, Stripe environment Price IDs, effective/retired dates, and public DTOs. Clients can submit keys only. Reconcile every existing plan limit/feature map.
  - Verify: snapshot tests assert every amount/unit/seat/feature; exhaustive TypeScript checks fail when a tier lacks pricing, entitlement, icon, or limits.
  - Progress (2026-07-23): `catalog.ts` defines a NEW `CatalogTier`/`SubscriptionCatalogKey`/`PackCatalogKey` type system, deliberately separate from (not replacing) the legacy `PlanTier` in `billing-shared.ts` — that system still serves existing manually-billed organizations at its own prices ($0/$19/$99) until the voluntary migration in §10. Every catalog entry carries version/currency/tax-behavior/effective+retired-dates/a `{test, live}` Stripe Price ID placeholder pair (real IDs land once Products/Prices exist in Stripe, task "Validate Stripe Products and Prices before mutation"). Client-safe DTOs (`toSubscriptionCatalogDto`/`toPackCatalogDto`) strip the Price ID/version/tax fields entirely; `resolveSubscriptionCatalogKey`/`resolvePackCatalogKey` are the only way a client-submitted key becomes real pricing — never trust a client amount. "Reconcile every existing plan limit/feature map" (verified in a dedicated `describe` block): Pro's price matches the legacy system exactly (no drift); Team's does NOT match ($99 legacy vs. $199 new) — asserted explicitly as an intentional repricing for new Stripe subscribers, not a bug, matching spec.md's grandfather clause; Pro Max has no legacy equivalent at all. Exhaustiveness verified two ways: `TIER_PRESENTATION`/`SUBSCRIPTION_CATALOG`'s `Record<CatalogTier/Key, ...>` annotations, and an empirical check — temporarily deleted the `team` entry from `TIER_PRESENTATION` and confirmed `pnpm type-check` failed with `TS2741: Property 'team' is missing`, then restored it. 22/22 tests pass.

- [ ] **Validate Stripe Products and Prices before mutation**
  - Files: `src/shared/lib/billing/catalog-validation.ts`, `src/shared/lib/billing/catalog-validation.test.ts`, `scripts/billing/verify-stripe-catalog.ts`, `docs/operations/stripe-catalog.md`
  - Do: Fetch configured objects read-only and compare amount, USD currency, recurring interval, product, tax behavior, livemode, archive state, and metadata. Document create/archive/version procedure and refuse mutations on mismatch.
  - Verify: sandbox manifest passes; fixtures with one wrong amount, interval, currency, product, metadata, or livemode each fail with redacted diagnostics.
  - Blocked: needs a real Stripe sandbox account with Products/Prices actually created — no credentials available in this session (see `docs/operations/stripe-launch-register.md`).

- [x] **Create a deterministic fake billing provider**
  - Files: `src/shared/lib/billing/provider.ts`, `src/shared/lib/billing/fake-provider.ts`, `src/shared/lib/billing/fake-provider.test.ts`
  - Do: Define typed provider contracts for Customers, Checkout, Portal, previews, subscription changes, Setup/PaymentIntents, refunds, object refresh, and reconciliation. Fake supports success, SCA, decline, timeout, duplicate, delayed, and out-of-order scenarios without network access.
  - Verify: contract suite passes identically against fake and Stripe sandbox adapter for supported operations.
  - Progress (2026-07-23): `provider.ts` defines the full `BillingProvider` interface (customers, checkout, portal, subscription preview/change/cancel, setup/payment intents, refunds, `refreshObject`, `listForReconciliation`) — every future mutating billing call site is written against this, never a raw Stripe SDK call inline. `fake-provider.ts` implements it in-memory with deterministic scenario injection (`success`/`sca_required`/`decline`/`timeout`/`delayed`/`out_of_order` — no real timers, no randomness; `duplicate` is exercised structurally by calling any create method twice with the same `idempotencyKey`, not a scenario flag). Extracted the test suite itself into `provider-contract-suite.ts` (a plain `.ts` export, not `.test.ts` — vitest's `include` glob only matches `*.test.ts`, so it's never auto-discovered standalone) specifically so the *same* suite can run unchanged against a real Stripe-backed adapter once one exists, satisfying "passes identically against fake and Stripe sandbox adapter." `fake-provider.test.ts` runs that suite against `FakeBillingProvider` (28/28) plus a few fake-only tests for `settleCheckoutSession`/`settlePaymentIntent`/`reset` (no real-adapter equivalent, since those simulate webhook-driven async settlement that a real adapter wouldn't need a test-only escape hatch for).
  - Verified (all four tasks together): `pnpm type-check` clean, `pnpm lint` 0 errors (same 55 pre-existing warnings), `pnpm security:boundaries` clean, `pnpm build` succeeds with no secret leak, full test suite 719/719 (up from 638 at the start of this plan — 71 new tests across 5 new files: `dependency-contracts.test.ts`, `stripe-client.test.ts`, `catalog.test.ts`, `fake-provider.test.ts`, plus additions to `env.security.test.ts`/`client-route-boundary.test.ts`).

## 2. Additive schema and isolation

- [ ] **Add billing and credit tables in an additive migration**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0020_stripe_billing.sql`, `drizzle/meta/_journal.json`, `drizzle/migration-hashes.json`, `src/shared/lib/db/billing-schema.test.ts`
  - Do: Add every table and invariant from `spec.md`: customers, subscriptions, attempts, webhook inbox, grants, reservations, allocations, append-only ledger, provider usage, auto-recharge, refunds, reconciliation, seller profiles, and terms acceptances. Use the next available migration number if `0020` is taken; do not modify `0019`. Add unique live-subscription/window/idempotency constraints, non-negative checks, and organization-preserving references.
  - Verify: `pnpm db:generate && pnpm test:migration-integrity && pnpm test:migrations:local && pnpm vitest run src/shared/lib/db/billing-schema.test.ts` passes on empty and populated snapshots.

- [ ] **Apply billing RLS and runtime-role policy**
  - Files: `drizzle/0020_stripe_billing.sql`, `scripts/db/verify-rls-local.mjs`, `test/security/billing-tenant-isolation.test.ts`, `docs/operations/database-roles.md`
  - Do: Tenant policies cover customer-visible organization rows; webhook/configuration/reconciliation/payload rows are platform/worker-only. Browser roles cannot insert/update ledger or financial state. Test tenant A/B, owner/admin/member, platform, worker, missing tenant, and spoofed tenant settings.
  - Verify: `pnpm test:rls:local && pnpm vitest run test/security/billing-tenant-isolation.test.ts` passes using non-owner DB roles.

- [ ] **Prove migration backup, restore, and rollback safety**
  - Files: `scripts/db/restore-test.ts`, `src/shared/lib/db/restore-policy.ts`, `src/shared/lib/db/restore-policy.test.ts`, `docs/operations/stripe-database-migration.md`
  - Do: Extend restore fixtures with billing states and assert ledger/event/reference integrity. Rehearse additive rollback before financial writes and document forward repair after writes.
  - Verify: `pnpm db:restore-test && pnpm vitest run src/shared/lib/db/restore-policy.test.ts` produces attached checksum evidence.

## 3. Repositories, permissions, configuration, and readiness

- [ ] **Build tenant-safe billing repositories and DTOs**
  - Files: `src/shared/lib/repositories/billing.ts`, `src/shared/lib/repositories/billing.test.ts`, `src/shared/lib/billing/contracts.ts`, `src/shared/lib/billing/contracts.test.ts`
  - Do: Implement transaction-injected repositories for organization customer/subscription/attempt/terms/grant/reservation/refund summary. Return explicit DTOs only; enforce composite organization references and forbid raw Stripe payload/card/bank/PII serialization.
  - Verify: repository tests cover A/B isolation, missing rows, duplicate keys, and malicious extra fields; boundary check rejects global `db` import.

- [ ] **Centralize owner/admin/member billing permissions**
  - Files: `src/shared/lib/billing/permissions.ts`, `src/shared/lib/billing/permissions.test.ts`, `src/shared/lib/authorization/permissions.ts`
  - Do: Export pure read/mutate/refund/Portal/auto-recharge predicates and server guards. Owner alone mutates; admin reads financial summary; member gets minimal availability. Platform operator is separate. Require recent auth for payment method, billing contact, auto-recharge, refund, ownership, deletion, and seller changes.
  - Verify: complete role/action matrix and stale-session tests pass; no route contains ad hoc role string comparisons.

- [ ] **Build private seller and country configuration**
  - Files: `src/shared/lib/billing/seller-profile.ts`, `src/shared/lib/billing/seller-profile.test.ts`, `src/routes/api/admin/billing/configuration.ts`, `src/routes/_dashboard/admin/billing.tsx`, `src/modules/admin/billing/SellerConfiguration.tsx`
  - Do: Add platform-admin read/update with version/effective date, legal/public fields, approved business/VAT IDs, USD, Denmark allowlist, Stripe registrations, preview, audit, and provider mismatch display. Exclude CPR and bank/card fields by schema. Generate route tree normally.
  - Verify: platform-admin/recent-auth tests pass; org owner receives 403; PII fixture is rejected; historical version remains readable; `pnpm type-check && pnpm build` passes.

- [ ] **Implement live billing readiness gate**
  - Files: `src/shared/lib/billing/readiness.ts`, `src/shared/lib/billing/readiness.test.ts`, `scripts/billing/check-live-readiness.ts`, `docs/operations/stripe-live-readiness.md`
  - Do: Fail closed unless flag, KYC/`charges_enabled`, public profile, statement descriptor/support, catalog, webhook/version, tax/product code, Denmark allowlist, Terms/Privacy, operator/runbooks, and reconciliation evidence are complete. Emit reason codes without secrets.
  - Verify: each missing gate independently prevents a mutation; fully populated sandbox fixture passes; live command is read-only unless explicitly enabled.

## 4. Credit ledger

- [ ] **Implement append-only grant and balance logic**
  - Files: `src/shared/lib/billing/credits.ts`, `src/shared/lib/billing/credits.test.ts`, `src/shared/lib/repositories/billing-ledger.ts`, `src/shared/lib/repositories/billing-ledger.test.ts`
  - Do: Add idempotent grant/expire/freeze/unfreeze/revoke/adjust operations with integer units, source links, earliest-expiry available balance, active-paid pack eligibility, and compensating entries only.
  - Verify: unit/property tests prove conservation and non-negative totals across randomized sequences and duplicate idempotency keys.

- [ ] **Implement atomic reservation lifecycle**
  - Files: `src/shared/lib/billing/reservations.ts`, `src/shared/lib/billing/reservations.test.ts`, `src/shared/lib/repositories/billing-ledger.ts`
  - Do: Lock eligible grants, persist exact allocation slices, reserve/extend/settle/release with unique org operation key, heartbeat, maximum duration, and settlement grace. Protect in-flight allocations across grant expiry; expire released remainder when original grant has expired.
  - Verify: concurrent final-credit, duplicate settle/release, crash/retry, boundary expiry, abandoned heartbeat, and over-settlement tests cannot overspend or roll credits over.

- [ ] **Expose server-only feature billing contracts**
  - Files: `src/shared/lib/billing/feature-authorization.ts`, `src/shared/lib/billing/feature-authorization.test.ts`, `src/shared/lib/billing/rate-cards.ts`
  - Do: Implement `checkEntitlement`, `reserveCredits`, `extendReservation`, `settleReservation`, `releaseReservation`, and `refundUsage`; require server-owned versioned rate-card/max-duration definitions. Return typed insufficient-entitlement/credits/blocked errors without balance mutation endpoints.
  - Verify: fake feature/provider integration proves no provider request begins before reservation and stops safely when extension fails.

## 5. Checkout, consent, and customer lifecycle

- [ ] **Create organization Stripe Customers idempotently**
  - Files: `src/shared/lib/billing/customers.ts`, `src/shared/lib/billing/customers.test.ts`, `src/shared/lib/billing/stripe-provider.ts`
  - Do: Resolve active organization, create/reuse one Customer per livemode, use opaque organization metadata, keep billing email separate, and handle timeout/retry with a stable operation key. Never copy candidate/product data into Stripe.
  - Verify: concurrent creation and lost-response retry create one Customer; test/live IDs cannot cross; metadata/DTO snapshots contain no sensitive fields.

- [ ] **Implement versioned commercial consent**
  - Files: `src/shared/lib/billing/consent.ts`, `src/shared/lib/billing/consent.test.ts`, `src/shared/lib/legal.ts`, `src/shared/lib/legal.test.ts`
  - Do: Resolve current Terms/Privacy/commercial versions, validate Checkout disclosures, store owner/org/action/time/provider evidence, require reacceptance on material version changes, and model separate auto-recharge consent.
  - Verify: stale/missing/wrong-org consent blocks Checkout; material/non-material version tests match policy; no raw request payload is stored.

- [ ] **Build subscription Checkout endpoint**
  - Files: `src/shared/lib/billing/checkout.ts`, `src/shared/lib/billing/checkout.test.ts`, `src/routes/api/billing/checkout/subscription.ts`, `src/routes/api/billing/checkout/subscription.test.ts`
  - Do: Owner-only catalog-key request; validate readiness, country, existing subscription, consent, URLs, and attempt idempotency. Create subscription-mode Checkout with USD Price, automatic tax, billing address, tax ID, customer updates, promotion codes, and approved immediate card/wallet methods.
  - Verify: API matrix covers owner/admin/member, spoofed org/amount/Price/URL, duplicate request, existing subscription, non-Denmark country, disabled billing, and provider timeout.

- [ ] **Build pending Checkout return experience**
  - Files: `src/routes/_dashboard/settings/billing/return.tsx`, `src/modules/billing/CheckoutReturn.tsx`, `src/modules/billing/CheckoutReturn.test.tsx`, `src/routeTree.gen.ts`
  - Do: Show pending/succeeded/failed/expired states by polling internal summary; never trust URL status or grant access. Include safe recovery and accessibility semantics.
  - Verify: component/E2E tests prove forged success parameters do nothing and delayed webhook resolves without duplicate navigation or access.

- [ ] **Create restricted Customer Portal sessions**
  - Files: `src/shared/lib/billing/portal.ts`, `src/shared/lib/billing/portal.test.ts`, `src/routes/api/billing/portal.ts`, `docs/operations/stripe-customer-portal.md`
  - Do: Owner/recent-auth only, allowlisted return URL, configured Portal limited to payment methods, tax identity, invoices, and receipts; disable product switching and cancellation. Validate Portal configuration in readiness.
  - Verify: owner can open sandbox Portal; admin/member cannot; sandbox Portal cannot change/cancel plan; open redirect tests pass.

## 6. Webhooks and workers

- [ ] **Implement signed durable Stripe webhook receipt**
  - Files: `src/routes/api/webhooks/stripe.ts`, `src/routes/api/webhooks/stripe.test.ts`, `src/shared/lib/billing/webhook-inbox.ts`, `src/shared/lib/billing/webhook-inbox.test.ts`
  - Do: Read raw bytes, verify current/rotating secrets, enforce API version/livemode, insert unique event before `2xx`, retain minimized encrypted payload under schedule, and redact logs/errors. Do not require user session or parse JSON before signature verification.
  - Verify: official signed fixtures pass; tampered body/signature, old timestamp, wrong mode/version fail; duplicate event returns `2xx` with one row.

- [ ] **Implement idempotent monotonic event handlers**
  - Files: `src/shared/lib/billing/webhook-handlers.ts`, `src/shared/lib/billing/webhook-handlers.test.ts`, `src/shared/lib/billing/subscription-state.ts`, `src/shared/lib/billing/subscription-state.test.ts`
  - Do: Handle required Checkout/invoice/subscription/PaymentIntent/refund/dispute families. Retrieve current objects when needed, enforce legal state transitions/provider timestamps, and make unknown events safe no-ops. Link every effect to event/object idempotency.
  - Verify: permutation tests deliver fixtures duplicate/reversed/delayed and produce identical final subscription, entitlement, refund, and ledger state.

- [ ] **Build billing worker and event replay**
  - Files: `src/shared/lib/billing/worker.ts`, `src/shared/lib/billing/worker.test.ts`, `src/routes/api/admin/billing/run-worker.ts`, `src/routes/api/admin/billing/events/$eventId/replay.ts`, `docs/operations/stripe-webhooks.md`
  - Do: Claim/lease pending events, retry with bounded backoff, alert dead letters, process grace/grants/expiry/notices/auto-recharge, and expose platform-admin audited single-event replay. Use restricted worker DB role and existing authenticated HTTP-cron pattern.
  - Verify: concurrent worker, crashed lease, poison event, replay, and unknown event tests pass; runbook demonstrates Stripe resend plus internal replay safely.

## 7. Subscription lifecycle

- [ ] **Project paid subscription and monthly renewal state**
  - Files: `src/shared/lib/billing/subscriptions.ts`, `src/shared/lib/billing/subscriptions.test.ts`, `src/shared/lib/repositories/entitlements.ts`, `src/shared/lib/repositories/entitlements.test.ts`
  - Do: On authoritative paid state, project tier/status/period/seat limit into organization entitlement and issue one monthly included grant. Add Pro Max/status variants and preserve manual authority until voluntary cutover.
  - Verify: initial/renewal duplicate invoices grant once; unpaid/redirect events grant none; entitlement and grant commit atomically.

- [ ] **Issue annual subscription credits monthly**
  - Files: `src/shared/lib/billing/annual-grants.ts`, `src/shared/lib/billing/annual-grants.test.ts`, `src/shared/lib/billing/worker.ts`
  - Do: Derive calendar anniversaries from Stripe anchor, clamp to month end, issue first grant after annual payment and next 11 idempotently, stop after cancellation/unpaid/dispute/contract end, and never grant whole-year allowance upfront.
  - Verify: Test Clock/unit cases cover Jan 29/30/31, leap day, DST-independent UTC, duplicate worker, late worker, upgrade, cancellation, and annual renewal.

- [ ] **Implement subscription preview and change matrix**
  - Files: `src/shared/lib/billing/subscription-changes.ts`, `src/shared/lib/billing/subscription-changes.test.ts`, `src/routes/api/billing/subscription/preview.ts`, `src/routes/api/billing/subscription/change.ts`
  - Do: Fetch Stripe preview; return charge/tax/effective/renewal/refill/credit delta. Apply paid upgrades with immediate invoice/pending update and ceiling delta grant; monthly-to-annual immediately without duplicate grant; schedule downgrade/annual-to-monthly. Reject stale preview and client amount.
  - Verify: sandbox/unit matrix covers every tier/interval pair, payment failure, SCA, proration, concurrent request, stale preview, and exact delta arithmetic.

- [ ] **Enforce Team downgrade seat blockers**
  - Files: `src/shared/lib/billing/subscription-changes.ts`, `src/shared/lib/billing/subscription-changes.test.ts`, `src/shared/lib/organizations/contracts.ts`, `src/modules/billing/PlanChangePreview.tsx`
  - Do: Before sending downgrade, query authoritative accepted members plus usable invitations; require one total and zero invitations, return owner-visible blocker DTOs linking `/settings/team`, and never evict/cancel automatically.
  - Verify: active/invited/concurrent final-seat tests prove Stripe receives no update until the invariant holds.

- [ ] **Implement cancellation and renewal-safe price migration**
  - Files: `src/shared/lib/billing/subscription-changes.ts`, `src/routes/api/billing/subscription/cancel.ts`, `src/shared/lib/billing/price-migrations.ts`, `src/shared/lib/billing/price-migrations.test.ts`
  - Do: Schedule owner cancellation at period end; version catalog Price changes, enforce notice/effective date, preserve annual term, and migrate at renewal without retroactive charge or indefinite grandfather promise.
  - Verify: Test Clocks show cancellation/update events and old/new Price at exact renewal; duplicate scheduler is no-op.

- [ ] **Implement seven-day dunning and recovery**
  - Files: `src/shared/lib/billing/dunning.ts`, `src/shared/lib/billing/dunning.test.ts`, `src/shared/lib/billing/worker.ts`, `src/shared/lib/repositories/entitlements.ts`
  - Do: Record first failure/grace end, keep access in grace, send deduplicated notices, block/freeze after seven days, preserve packs/data/export, restore only still-valid grants after payment, and suspend non-owner Team access without deleting membership.
  - Verify: boundary-time/Test Clock cases cover first/repeated failure, recovery before/at/after deadline, cancellation, late paid event, and no new premium reservation after block.

## 8. Packs, risk, refunds, and disputes

- [ ] **Build pack Checkout and successful grant**
  - Files: `src/shared/lib/billing/packs.ts`, `src/shared/lib/billing/packs.test.ts`, `src/routes/api/billing/checkout/credits.ts`, `src/routes/api/billing/checkout/credits.test.ts`
  - Do: Owner/active-paid only; use payment-mode immutable Price; reject promos; apply Denmark/readiness/rolling risk limits; grant exact units for 12 months only on success webhook; preserve but disable on subscription lapse.
  - Verify: success/decline/pending/duplicate/refund/lapse/reactivation/expiry and spoofed units/amount tests pass.

- [ ] **Implement capped auto-recharge and SCA recovery**
  - Files: `src/shared/lib/billing/auto-recharge.ts`, `src/shared/lib/billing/auto-recharge.test.ts`, `src/routes/api/billing/auto-recharge.ts`, `src/modules/billing/AutoRechargeSettings.tsx`
  - Do: Off by default; owner/recent-auth/active-paid; select pack/threshold/monthly cap ≤$1,000; enforce shared three-charge/$1,000 rolling day; record separate consent; prepare off-session method; issue credits only on success; pause and link on-session recovery when authentication/failure occurs.
  - Verify: concurrent threshold, duplicate worker, month/day rollover, cap, disabled/lapsed subscription, SCA, decline, payment-method replacement, and cancellation tests pass.

- [ ] **Add fraud and high-volume exception controls**
  - Files: `src/shared/lib/billing/risk.ts`, `src/shared/lib/billing/risk.test.ts`, `src/routes/api/admin/billing/risk-exceptions.ts`, `docs/operations/stripe-fraud.md`
  - Do: Consume Radar/3DS results, track failure/payment-method/dispute velocity, block only new purchases, and allow platform operator to issue time-bounded reasoned exceptions that never bypass successful payment or ledger rules.
  - Verify: abuse fixtures trigger review; unrelated data stays available; expired exception closes; operator/admin/org role matrix and audit tests pass.

- [ ] **Implement refund request and operator workflow**
  - Files: `src/shared/lib/billing/refunds.ts`, `src/shared/lib/billing/refunds.test.ts`, `src/routes/api/billing/refunds.ts`, `src/routes/api/admin/billing/refunds.ts`, `src/modules/admin/billing/RefundQueue.tsx`
  - Do: Allow unused-pack request; operator preview/decision for full/partial pack and subscription exceptions; set revised service end; create idempotent Stripe refund; revoke only eligible unused linked credits; preserve consumed history/unrelated packs; lock conflicts and expose repair state.
  - Verify: full/partial, provider timeout/failure, internal failure, duplicate/out-of-order webhook, concurrent consumption, and retry tests never over-refund/double-revoke.

- [ ] **Implement dispute freeze, outcome, and alerts**
  - Files: `src/shared/lib/billing/disputes.ts`, `src/shared/lib/billing/disputes.test.ts`, `src/shared/lib/billing/webhook-handlers.ts`, `src/modules/admin/billing/DisputeQueue.tsx`, `docs/operations/stripe-disputes.md`
  - Do: Freeze linked pack grant or immediately block disputed subscription without grace; preserve data/unrelated grants; restore still-valid state on win; revoke linked unused state/end entitlement on loss; alert evidence deadlines and reconcile reinstated funds.
  - Verify: pack/subscription win/loss/partial refund/funds-reinstated replay matrix passes and unrelated ledger hashes remain unchanged.

## 9. Customer and operator experiences

- [ ] **Replace billing summary API with the canonical organization DTO**
  - Files: `src/routes/api/billing/summary.ts`, `src/routes/api/billing/summary.test.ts`, `src/routes/api/plans/me.ts`, `src/shared/lib/billing/contracts.ts`
  - Do: Return role-minimized plan, period, payment/grace/scheduled state, seats, credit grants/expiry, usage, invoice links, billing contact, and capabilities. Keep `/api/plans/me` compatibility during migration then delegate to canonical service; serialize unlimited limits explicitly, not JSON `Infinity`.
  - Verify: Free/Pro/Pro Max/Team, manual/Stripe, owner/admin/member, A/B, past-due/canceled/disputed DTO snapshots pass.

- [ ] **Build complete organization billing settings**
  - Files: `src/routes/_dashboard/settings/billing.tsx`, `src/modules/billing/BillingSettingsPage.tsx`, `src/modules/billing/BillingSettingsPage.test.tsx`, `src/modules/billing/PlanChangePreview.tsx`, `src/modules/billing/CreditBalance.tsx`
  - Do: Replace manual copy with plan/change/cancel, grace/recovery, invoices/Portal, balance by source/expiry, usage, pack purchase, auto-recharge, verified billing email, 30/7/1 warnings, pending/refund/dispute states, and owner/admin/member controls. Preserve data-access messaging.
  - Verify: role/state snapshots, keyboard/screen-reader/mobile tests, forged client controls, and E2E Checkout-return paths pass.

- [ ] **Update pricing for the approved catalog**
  - Files: `src/routes/_landing/pricing.tsx`, `src/routes/_landing/pricing.test.tsx`, `src/shared/lib/billing-shared.ts`, `test/test-pricing-and-billing.mjs`
  - Do: Show Free/Pro/Pro Max/Team, monthly/annual, exact USD amounts, included credits, Team 10 seats, tax exclusion, pack table, expiry, no-rollover, plan-vs-pack distinction, and account-aware Checkout CTA. Remove stale $99 Team/manual-payment claims.
  - Verify: pricing snapshots and content tests assert exact catalog/terms and no unsupported promise.

- [ ] **Add verified billing contact management**
  - Files: `src/shared/lib/billing/billing-contact.ts`, `src/shared/lib/billing/billing-contact.test.ts`, `src/routes/api/billing/contact.ts`, `src/modules/billing/BillingContact.tsx`, `src/shared/lib/email.ts`
  - Do: Owner/recent-auth set and verify separate email; send invoices/receipts/renewal/failure while critical messages also reach owner; grant no membership/authority and audit changes with minimal data.
  - Verify: unverified/wrong-org/replayed token, admin/member mutation, delivery dedupe, redaction, and address-change tests pass.

- [ ] **Integrate billing into ownership transfer**
  - Files: `src/modules/dashboard/components/OrganizationDangerZone.tsx`, `src/shared/lib/organizations/ownership.ts`, `src/shared/lib/organizations/ownership.test.ts`, `src/shared/lib/email.ts`
  - Do: Preview masked method, next charge/date, continued-billing warning; preserve Customer/subscription/method; atomically move billing authority with ownership; notify both parties; allow optional method replacement before transfer. Never create a charge from transfer.
  - Verify: company/personal-card warning, stale transfer, concurrent billing mutation, authority revocation, notification, and no-card-detail leakage tests pass.

- [ ] **Integrate subscription-safe organization deletion**
  - Files: `src/shared/lib/organizations/deletion.ts`, `src/shared/lib/organizations/deletion.test.ts`, `src/modules/dashboard/components/OrganizationDangerZone.tsx`, `src/shared/lib/billing/subscription-changes.ts`
  - Do: Normal deletion immediately prevents renewal, retains paid access, schedules product deletion after period; immediate path warns forfeiture, cancels now, deletes product data, and retains only approved financial records. Canceling deletion never restores renewal automatically.
  - Verify: normal/immediate/cancel/re-subscribe, refund exception, worker race, financial retention, and tenant B isolation tests pass.

- [ ] **Build platform billing operations dashboard**
  - Files: `src/routes/_dashboard/admin/billing.tsx`, `src/modules/admin/billing/BillingOperationsPage.tsx`, `src/modules/admin/billing/BillingOperationsPage.test.tsx`, `src/routes/api/admin/billing/metrics.ts`
  - Do: Show readiness, configuration version, webhook backlog/dead letters/replay, grace, refunds, disputes, risk exceptions, reconciliation, credit invariants, cost/margin, and runbook links. Platform-admin only; raw payload and secrets never render.
  - Verify: operator/non-operator role tests, redaction fixtures, accessibility/mobile, and stale metrics states pass.

## 10. Reconciliation, migration, and release

- [ ] **Implement daily financial reconciliation**
  - Files: `src/shared/lib/billing/reconciliation.ts`, `src/shared/lib/billing/reconciliation.test.ts`, `src/routes/api/admin/billing/reconcile.ts`, `docs/operations/stripe-reconciliation.md`
  - Do: Page through provider Customers/subscriptions/invoices/payments/refunds/disputes and compare internal subscription/entitlement/grant state. Record mismatch/repair case, never fabricate success, support resumable cursor and idempotent safe repairs.
  - Verify: injected missing/extra/stale/duplicate fixtures are detected; rerun is no-op after repair; worker-role and timeout/resume tests pass.

- [ ] **Create accounting and margin export**
  - Files: `src/shared/lib/billing/accounting-export.ts`, `src/shared/lib/billing/accounting-export.test.ts`, `src/routes/api/admin/billing/accounting-export.ts`, `docs/operations/stripe-accounting.md`
  - Do: Export monthly gross, discounts, tax, refunds, disputes, Stripe fees, payout currency/FX/net, outstanding invoices, unexpired-credit liability, and provider cost by tier/feature. Exclude bank credentials and unrelated customer data.
  - Verify: balanced fixture totals reconcile to Stripe balance transactions and ledger; CSV/JSON schema and platform authorization tests pass.

- [ ] **Add financial notifications, metrics, and alerts**
  - Files: `src/shared/lib/billing/notifications.ts`, `src/shared/lib/billing/notifications.test.ts`, `src/shared/lib/email.ts`, `src/routes/api/admin/metrics/index.ts`, `docs/operations/stripe-alerts.md`
  - Do: Deduplicate renewal/grace/action-required/expiry 30-7-1/refund/dispute/reconciliation messages and expose checkout, recovery, webhook age, ledger invariant, auto-recharge, cost/margin, and country-gate metrics with critical SLO alerts.
  - Verify: time-travel tests prove one notification per policy window; injected critical condition alerts within target without PII/secrets.

- [ ] **Migrate manual entitlements without charging**
  - Files: `scripts/db/backfills/stripe-billing-legacy.ts`, `src/shared/lib/billing/legacy-migration.ts`, `src/shared/lib/billing/legacy-migration.test.ts`, `docs/operations/stripe-manual-migration.md`
  - Do: Import current organization periods/trials/promos as `legacy_manual`, support dry-run/resume/checksum/conflict report, create no Stripe objects, and offer voluntary Checkout. On paid activation atomically end overlapping manual authority without duplicate entitlement/grant.
  - Verify: dry-run leaves DB/provider unchanged; mixed fixtures preserve access and yield exactly one effective authority; rerun checksum is stable.

- [ ] **Retire legacy billing mutations after canonical cutover**
  - Files: `src/shared/lib/repositories/platform-billing.ts`, `src/routes/api/admin/plan-requests/index.ts`, `src/routes/_dashboard/admin/plan-requests.tsx`, `src/routes/api/me/plan-changes.ts`, `test/test-pricing-and-billing.mjs`
  - Do: Keep historical reads/export, disable new user-owned plan requests/approvals after migration flag, direct owners to Checkout, and ensure all gating uses organization entitlement. Preserve an audited operator grant path separate from paid Stripe state.
  - Verify: legacy mutation returns migration guidance, historical rows remain readable, manual grants still work through purpose-built operator API, and organization gating tests pass.

- [ ] **Reconcile dependent plan documents**
  - Files: `plans/pricing-and-billing/spec.md`, `plans/pricing-and-billing/plan.md`, `plans/pricing-and-billing/tasks.md`, `plans/calendar-scheduling-interview-intelligence/spec.md`, `plans/calendar-scheduling-interview-intelligence/plan.md`, `plans/calendar-scheduling-interview-intelligence/tasks.md`, `plans/team-accounts/spec.md`, `plans/team-accounts/plan.md`, `plans/team-accounts/tasks.md`
  - Do: Mark old pricing plan superseded with no executable Stripe tasks; make interview plan consume this platform and retain rate cards/reserve-settle integration; make Team billing owner-only/admin-read and add Team downgrade/lapse contracts. Preserve delivered/manual history without conflicting ownership.
  - Verify: `rg` finds one owner for Stripe adapter/ledger/refunds/reconciliation and no plan promises admin charge authority or duplicated Stripe implementation.

- [ ] **Certify Stripe sandbox and Test Clock lifecycle**
  - Files: `e2e/stripe-billing.spec.ts`, `test/security/stripe-billing-isolation.test.ts`, `test/fixtures/stripe/`, `docs/operations/stripe-sandbox-certification.md`, `.github/workflows/quality.yml`
  - Do: Run real sandbox objects and Test Clocks for all tier/interval/role/country/payment/grace/change/refund/dispute/pack/auto-recharge/ownership/deletion/migration states; include signed webhook duplicates/reordering, month-end/leap annual grants, RLS, accessibility, and browser flows.
  - Verify: `pnpm lint && pnpm type-check && pnpm test && pnpm security:boundaries && pnpm test:rls:local && pnpm test:migrations:local && pnpm build && pnpm playwright test e2e/stripe-billing.spec.ts` passes and evidence is attached.

- [ ] **Complete operational and privacy runbooks**
  - Files: `docs/operations/stripe-incident-response.md`, `docs/operations/stripe-secret-rotation.md`, `docs/operations/stripe-refunds.md`, `docs/operations/stripe-tax.md`, `docs/operations/stripe-backup-restore.md`, `plans/legal-and-compliance/spec.md`, `plans/legal-and-compliance/tasks.md`
  - Do: Document outage/kill switch, webhook recovery, API/webhook secret rotation with overlap, refund/dispute support, Denmark individual KYC/CVR/VAT gate, EU/OSS expansion, retention/deletion, accounting handoff, backup/restore, and processor/privacy disclosures. Keep personal KYC inside Stripe.
  - Verify: tabletop exercises for outage, leaked key, missing webhook, chargeback, tax-country mistake, restore, and deletion produce signed evidence and no unowned action.

- [ ] **Run live Denmark canary and staged rollout**
  - Files: `docs/operations/stripe-live-rollout.md`, `docs/operations/stripe-live-readiness.md`, `.env.example`
  - Do: Verify live catalog read-only, enable webhook ingestion, then internal account, then one voluntary Danish customer, then percentage rollout. Observe successful charge, invoice, tax result, grant, refund, payout/FX facts, reconciliation, and rollback. Keep EU countries disabled.
  - Verify: readiness checklist and canary evidence are complete; rollback disables new mutations while reads/webhooks/refunds/reconciliation continue; only then set plan status `implemented` and unblock provider-backed interview rollout.
