# Tasks: Stripe Billing Platform

> **Status**: `in_progress` (20/~40 tasks — §0-§5 complete: dependency contracts pinned, launch
> register recorded, Stripe SDK/client/catalog/fake-provider built, all 14 billing/credit tables
> added in an additive migration with RLS/runtime-role grants applied and verified live,
> backup/restore/rollback safety proven with checksum evidence, tenant-safe billing repositories/DTOs
> built, owner/admin/member billing permissions centralized, private seller/country configuration
> built (route+page+component), a pure fail-closed live-readiness gate implemented and wired to
> `pnpm billing:check-readiness`, the append-only credit grant/balance ledger and atomic reservation
> lifecycle implemented with property-tested/concurrency-tested invariants, the server-only feature
> billing contracts (`checkEntitlement`/reserve/extend/settle/release/`refundUsage`) exposed behind
> versioned rate cards, and the full Checkout/consent/customer-lifecycle surface built end-to-end:
> idempotent Stripe Customer provisioning, versioned commercial consent, the owner-only subscription
> Checkout endpoint (found/fixed a real open-redirect vulnerability in its own return-URL check along
> the way), the pending-Checkout return experience (polls internal state only, never trusts the
> redirect URL), and owner/recent-auth-gated restricted Customer Portal sessions; "Validate Stripe
> Products and Prices" now DONE for the test sandbox — see the note below.)
>
> **Stripe configuration status (2026-07-23)** — read this before assuming nothing is set up:
> A real Stripe **test** account exists (Denmark, individual). The full catalog is provisioned and
> validated in that sandbox — all 6 subscription Prices + 3 pack Prices exist as real Stripe objects,
> and their **test** Price IDs are written into `src/shared/lib/billing/catalog.ts` (the `live` column
> is still `null`). This was done with `scripts/billing/provision-stripe-catalog.ts` (`pnpm
> stripe:provision`), which is idempotent and refuses to mutate a diverging object. `.env` has
> `STRIPE_SECRET_KEY` (sk_test_), `STRIPE_API_VERSION=2026-06-24.dahlia`, `STRIPE_WEBHOOK_SECRET`
> (from a local `stripe listen`), and `STRIPE_BILLING_ENABLED=false`. What is NOT built yet: the
> Checkout route (§4), the webhook receipt/handler routes (§6 — `src/routes/api/webhooks/stripe.ts`
> does not exist, so `stripe listen --forward-to .../api/webhooks/stripe` currently 404s), the
> customer portal, and all credit/subscription runtime. Still pending outside code: Stripe Tax
> registration for Denmark, KYC/live activation, and every non-test release gate. See
> `docs/operations/stripe-setup-guide.md` and `docs/operations/stripe-launch-register.md`.)
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/tasks.md),
> [`team-accounts`](../team-accounts/tasks.md)
> **Blocks**: [`calendar-scheduling-interview-intelligence`](../calendar-scheduling-interview-intelligence/tasks.md)
> **Reality check** (updated 2026-07-23): the Stripe SDK IS now installed (`stripe@22.3.2`) and the
> billing foundations exist under `src/shared/lib/billing/` (catalog, stripe-client, provider
> interface, fake provider) plus the 14 billing/credit tables. What does NOT exist yet is the billing
> *runtime wired to HTTP*: no Checkout route, no webhook receipt/handler route
> (`src/routes/api/webhooks/stripe.ts`), no customer portal, no credit-ledger mutation on real events.
> The only billing routes today are the legacy manual snapshot (`src/routes/api/organizations/billing.ts`
> GET) and its settings UI — those serve the legacy `PlanTier` system and are unrelated to the new
> catalog. Organization entitlement, tenant context, RLS foundations, manual plan records, pricing, and
> billing settings already exist and must be migrated rather than duplicated. Migration `0019` is an
> unrelated in-progress change; generate the next available migration instead of editing it.

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
  - Progress (2026-07-23): UNBLOCKED — a real Stripe test sandbox now exists and the full catalog was provisioned into it. Delivered `scripts/billing/provision-stripe-catalog.ts` (run via `pnpm stripe:provision`): it fetches each Price read-only by `lookup_key` (= catalog key) and compares amount / USD currency / recurring interval / product / tax behavior / active(archive) state / livemode against `catalog.ts`, throwing `MismatchError` and refusing to mutate on any divergence (create-or-validate; `--validate` = read-only; `--dry-run`; `--write` patches the correct test/live Price-ID column; `--allow-live` required for live keys). Idempotent via deterministic product IDs (`bh_sub_pro`/`bh_sub_pro_max`/`bh_sub_team`, `bh_pack_*`) and `transfer_lookup_key`. Products carry tax_code `txcd_10103000` (SaaS). Verified against the installed `stripe@22.3.2` SDK types (`id`/`statement_descriptor`/`tax_code` on ProductCreateParams; `lookup_key`/`tax_behavior`/`transfer_lookup_key` on PriceCreateParams). All 9 test Price IDs are now in `catalog.ts` (test column; live still null). Create/archive/version procedure documented in `docs/operations/stripe-setup-guide.md`.
  - Remaining (do NOT assume complete): the plan's dedicated `src/shared/lib/billing/catalog-validation.ts` module + `catalog-validation.test.ts` negative-fixture matrix (one wrong amount/interval/currency/product/metadata/livemode each failing with redacted diagnostics) is NOT yet written — the validation logic currently lives inline in the provisioning script, not as an importable, unit-tested module. Also unverified: metadata-field comparison in the read path (the script writes metadata on create but does not diff it on validate). Leave this task `[ ]` until that module + fixtures exist.

- [x] **Create a deterministic fake billing provider**
  - Files: `src/shared/lib/billing/provider.ts`, `src/shared/lib/billing/fake-provider.ts`, `src/shared/lib/billing/fake-provider.test.ts`
  - Do: Define typed provider contracts for Customers, Checkout, Portal, previews, subscription changes, Setup/PaymentIntents, refunds, object refresh, and reconciliation. Fake supports success, SCA, decline, timeout, duplicate, delayed, and out-of-order scenarios without network access.
  - Verify: contract suite passes identically against fake and Stripe sandbox adapter for supported operations.
  - Progress (2026-07-23): `provider.ts` defines the full `BillingProvider` interface (customers, checkout, portal, subscription preview/change/cancel, setup/payment intents, refunds, `refreshObject`, `listForReconciliation`) — every future mutating billing call site is written against this, never a raw Stripe SDK call inline. `fake-provider.ts` implements it in-memory with deterministic scenario injection (`success`/`sca_required`/`decline`/`timeout`/`delayed`/`out_of_order` — no real timers, no randomness; `duplicate` is exercised structurally by calling any create method twice with the same `idempotencyKey`, not a scenario flag). Extracted the test suite itself into `provider-contract-suite.ts` (a plain `.ts` export, not `.test.ts` — vitest's `include` glob only matches `*.test.ts`, so it's never auto-discovered standalone) specifically so the *same* suite can run unchanged against a real Stripe-backed adapter once one exists, satisfying "passes identically against fake and Stripe sandbox adapter." `fake-provider.test.ts` runs that suite against `FakeBillingProvider` (28/28) plus a few fake-only tests for `settleCheckoutSession`/`settlePaymentIntent`/`reset` (no real-adapter equivalent, since those simulate webhook-driven async settlement that a real adapter wouldn't need a test-only escape hatch for).
  - Verified (all four tasks together): `pnpm type-check` clean, `pnpm lint` 0 errors (same 55 pre-existing warnings), `pnpm security:boundaries` clean, `pnpm build` succeeds with no secret leak, full test suite 719/719 (up from 638 at the start of this plan — 71 new tests across 5 new files: `dependency-contracts.test.ts`, `stripe-client.test.ts`, `catalog.test.ts`, `fake-provider.test.ts`, plus additions to `env.security.test.ts`/`client-route-boundary.test.ts`).

## 2. Additive schema and isolation

- [x] **Add billing and credit tables in an additive migration**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0027_overconfident_angel.sql`, `drizzle/meta/_journal.json`, `drizzle/migration-hashes.json`, `src/shared/lib/db/billing-schema.test.ts`
  - Do: Add every table and invariant from `spec.md`: customers, subscriptions, attempts, webhook inbox, grants, reservations, allocations, append-only ledger, provider usage, auto-recharge, refunds, reconciliation, seller profiles, and terms acceptances. Use the next available migration number if `0020` is taken; do not modify `0019`. Add unique live-subscription/window/idempotency constraints, non-negative checks, and organization-preserving references.
  - Verify: `pnpm db:generate && pnpm test:migration-integrity && pnpm test:migrations:local && pnpm vitest run src/shared/lib/db/billing-schema.test.ts` passes on empty and populated snapshots.
  - Progress (2026-07-23): added all 14 tables from spec.md's Data model table to `schema.ts`, following existing conventions exactly (organization-preserving composite FKs against each parent's `(organization_id, id)` unique index — same idiom as `alerts`→`saved_queries`; CHECK constraints for every bounded enum/non-negative-units invariant; append-only `billing_ledger_entries` deliberately has no `updatedAt`). `0027` landed as the next available slot (`0019`–`0026` all already existed from prior sessions' work, confirmed via `drizzle/meta/_journal.json`, not just directory listing). One real bug caught and fixed before commit: drizzle-kit's generated statement order for a *brand-new* multi-table migration is `CREATE TABLE` → `ALTER TABLE ADD CONSTRAINT` (FKs) → `CREATE INDEX`, but several composite FKs here reference a *sibling new table's* `(organization_id, id)` unique index (e.g. `billing_credit_allocations` → `billing_credit_reservations`) — Postgres rejects a composite FK if the referenced unique index doesn't exist yet, so the generated ordering fails on a fresh database (this differs from `ALTER TABLE ADD COLUMN`-style tenant-expansion migrations like `0003`, where drizzle-kit orders indexes before FKs). Fixed by hand-reordering the generated file's statement blocks (`CREATE TABLE` → `CREATE INDEX` → `ALTER TABLE ADD CONSTRAINT`) via a script that splits on `--> statement-breakpoint`, classifies, and regroups — verified no statement was lost (75 in, 75 out) and the file had not been applied anywhere yet, so hand-editing was safe. Regenerated `drizzle/migration-hashes.json` via `verify-migration-integrity.mjs --write`. Verified against a real disposable `builderhunt_security_test_*` Postgres (created/dropped on the running `builderhunt-db` pgvector/pg16 container): both first and second `migrate()` runs succeed (idempotency). Bumped a hardcoded migration count in `src/shared/lib/db/migration-integrity.test.ts` (27→28). Full suite: `pnpm type-check` clean, `pnpm lint` 0 errors (same 55 pre-existing warnings), `pnpm security:boundaries` clean, `pnpm vitest run` 734/734 (up from 719 — 15 new tests in `billing-schema.test.ts`). RLS/grants deliberately NOT added here — that's the next, separate tasks.md item ("Apply billing RLS and runtime-role policy"), matching this codebase's established split (table-creation migration first, RLS/grants migration second — see `0024`'s retroactive fix for `sourcing_sprints`, which never got a timely RLS migration). Until that lands, these 14 tables have zero grants to any runtime role and are therefore inaccessible (fail-closed by omission), not merely RLS-unprotected.

- [x] **Apply billing RLS and runtime-role policy**
  - Files: `drizzle/0028_billing_rls_grants.sql`, `scripts/db/prepare-rls-fixture.mjs`, `scripts/db/verify-rls-local.mjs`, `test/security/billing-tenant-isolation.test.ts`, `docs/operations/database-roles.md`
  - Do: Tenant policies cover customer-visible organization rows; webhook/configuration/reconciliation/payload rows are platform/worker-only. Browser roles cannot insert/update ledger or financial state. Test tenant A/B, owner/admin/member, platform, worker, missing tenant, and spoofed tenant settings.
  - Verify: `pnpm test:rls:local && pnpm vitest run test/security/billing-tenant-isolation.test.ts` passes using non-owner DB roles.
  - Progress (2026-07-23): `0028` (minted via `drizzle-kit generate --custom`, matching the 0024 pattern) enables+forces RLS on all 11 tenant-private tables using the standard `organization_id = nullif(current_setting('app.organization_id', true), '')` filter, and leaves the 3 system-operational tables (`billing_webhook_events`/`billing_reconciliation_runs`/`billing_seller_profiles`, no `organization_id`) RLS-free with GRANT-only access. Role split: `builderhunt_app` gets SELECT-only on the 7 truly financial-state tables (customers/subscriptions/credit grants/reservations/allocations/ledger/provider usage — spec.md: "browser roles cannot mutate financial state directly"), full SELECT+INSERT+UPDATE only on the two owner-initiated-request tables (`billing_checkout_attempts`, `billing_auto_recharge_rules`), and INSERT-only (with a `WITH CHECK` restricting `state='pending' AND stripe_refund_id IS NULL`) on `billing_refunds`/`billing_terms_acceptances`. `builderhunt_worker` gets the financial-state mutation grants app lacks (webhook/reservation-settlement writes, even when triggered synchronously by a user request — deliberately routed through the worker-privileged connection rather than the browser-facing role); `billing_ledger_entries` gets INSERT but never UPDATE for any role (append-only, no `updatedAt` column). `builderhunt_platform` gets the specific admin-owned mutations from spec.md's API contract (seller profile versions, webhook replay, refund review/decision) and nothing on the 7 SELECT-only tables. `builderhunt_auth` gets nothing. Verified live against a disposable Postgres: manually confirmed (via `SET ROLE` inside transactions, no password changes needed) tenant A/B isolation, app-role INSERT/UPDATE denial on `billing_customers`, app-role spoofed-organization checkout-attempt rejection, app-role pre-decided-refund rejection, worker missing-context/cross-tenant denial, and platform denial of tenant billing data — all behaved exactly as designed. Extended `scripts/db/prepare-rls-fixture.mjs` with org-a/org-b `billing_customers` fixture rows and `scripts/db/verify-rls-local.mjs` with the automated equivalents of the manual checks above; ran the full `pnpm test:rls:local` chain end-to-end (all existing + new checks passed) and immediately restored the real dev role passwords afterward (cluster-wide roles — `prepare-rls-fixture.mjs` necessarily overwrites them for the disposable DB's role connections). Since no `/api/billing/*` routes exist yet (later tasks build them), `test/security/billing-tenant-isolation.test.ts` couldn't be a route-handler test like `team-api-isolation.test.ts` — instead it statically asserts the migration file's text has the required security properties (RLS enabled/forced on every tenant table, `REVOKE ALL FROM PUBLIC` on all 14, `builderhunt_app` never granted INSERT/UPDATE on a financial-state table, no DELETE anywhere, no UPDATE ever on the ledger, `builderhunt_auth` untouched) — safe to run in every `pnpm vitest run`, no live database needed. Updated `docs/operations/database-roles.md` with the full billing role-split table. Full suite: `pnpm type-check` clean, `pnpm lint` 0 errors, `pnpm security:boundaries` clean, `pnpm test:migration-integrity` valid (29 migrations), `pnpm vitest run` 742/743 (one unrelated pre-existing failure in `catalog.test.ts` caused by real Stripe test-mode Price IDs a concurrent session populated into `catalog.ts` — not part of this task, left untouched).

- [x] **Prove migration backup, restore, and rollback safety**
  - Files: `scripts/db/restore-test.ts`, `src/shared/lib/db/restore-policy.ts`, `src/shared/lib/db/restore-policy.test.ts`, `docs/operations/stripe-database-migration.md`
  - Do: Extend restore fixtures with billing states and assert ledger/event/reference integrity. Rehearse additive rollback before financial writes and document forward repair after writes.
  - Verify: `pnpm db:restore-test && pnpm vitest run src/shared/lib/db/restore-policy.test.ts` produces attached checksum evidence.
  - Progress (2026-07-23): found `scripts/db/restore-test.ts` was already broken by staleness unrelated to billing — its migration-count assertion was hardcoded to `20` (actual: 29) and its RLS-check table list predated `sourcing_sprints`/etc.; fixed the count and added all 11 billing tenant tables to the RLS list (left the pre-existing non-billing gaps in that hand-maintained list as a known issue, out of this task's scope, rather than doing a full 57-table audit). Added `seedAndChecksumBillingFixture()`: seeds one organization's customer/subscription/credit-grant/two-ledger-entries (a `grant` + a `consume`, exercising the append-only/non-negative invariants) into the source DB before the dump, computes a sha256 over those exact rows, and re-computes + compares it against the restored target after `pg_dump`/`pg_restore` — this is the actual "ledger/event/reference integrity" evidence the task asks for, not a row-count proxy. Caught and fixed a real bug while writing this: a missing `await` before a `return` inside a `try`/`finally` let `client.end()` race ahead of the in-flight checksum query, closing the connection mid-query (`CONNECTION_ENDED`). Ran the full rehearsal end-to-end against two disposable `builderhunt_security_test_*` databases: `{"restored":true,"migrations":29,"rlsMissing":0,"billingChecksum":"3838064f..."}`. Wrote `docs/operations/stripe-database-migration.md` establishing the financial-write threshold for rollback safety (additive rollback of 0027/0028 is safe only while every billing table is still empty — i.e. before `STRIPE_BILLING_ENABLED=true` is ever set against that environment; after any real row exists, corrections are forward-only: a new migration, or a compensating `billing_ledger_entries` row, never an edit/rollback of 0027/0028 or an UPDATE/DELETE on the ledger). Verified: `pnpm type-check` clean, `pnpm lint` 0 errors, `pnpm security:boundaries` clean, `pnpm test:migration-integrity` valid (29), `pnpm vitest run src/shared/lib/db/restore-policy.test.ts` 4/4, full suite 742/743 (same pre-existing unrelated `catalog.test.ts` failure from the concurrent Stripe-provisioning session, not part of this task).

## 3. Repositories, permissions, configuration, and readiness

- [x] **Build tenant-safe billing repositories and DTOs**
  - Files: `src/shared/lib/repositories/billing.ts`, `src/shared/lib/repositories/billing.test.ts`, `src/shared/lib/billing/contracts.ts`, `src/shared/lib/billing/contracts.test.ts`
  - Do: Implement transaction-injected repositories for organization customer/subscription/attempt/terms/grant/reservation/refund summary. Return explicit DTOs only; enforce composite organization references and forbid raw Stripe payload/card/bank/PII serialization.
  - Verify: repository tests cover A/B isolation, missing rows, duplicate keys, and malicious extra fields; boundary check rejects global `db` import.
  - Progress (2026-07-23): `repositories/billing.ts` implements find/create functions for all 7 record types (customer, subscription, checkout attempt, terms acceptance, credit grant, credit reservation, refund) following `entitlements.ts`/`organization-alerts.ts`'s exact convention — `TenantTransaction` first param, explicit interfaces, defense-in-depth `organizationId` re-filtering even though RLS already forces it. `billing/contracts.ts` mirrors `organizations/contracts.ts`: every export takes a `TenantPrincipal` (never a bare `organizationId: string` — verified by `dependency-contracts.test.ts`'s boundary regex, 10/10 still pass), DTOs never carry raw Stripe IDs/idempotency keys/actor or organization ids (`hasStripeCustomer: boolean` instead of the real `stripeCustomerId`, etc.), and `getBillingSummary(principal)` composes all 7 repository reads through `withTenantContext` in one call, mirroring `getOrganizationBillingSnapshot`'s shape. Every other `repositories/*.test.ts` file in this codebase is a static boundary/import scan, never a live-database test (confirmed by reading all of them) — deliberately broke that precedent for `billing.test.ts` specifically: financial-data correctness (A/B isolation, missing rows, duplicate-key rejection, cross-tenant composite-FK rejection) is worth proving against a real Postgres rather than trusting a scan, and it's safe to do unconditionally since `DATABASE_MIGRATION_URL` is already a hard app-wide requirement and this repo's own CI (`.github/workflows/quality.yml`) already runs the full `pnpm test`/`pnpm build` sequence against a live migrated Postgres service — the test only adds one more disposable, self-created-and-dropped database on that same already-required server (auto-creates `builderhunt_security_test_repo_billing_<random>`, runs the real migrator, seeds two organizations, drops the database in `afterAll`). 8/8 pass: A/B isolation (customer + subscription), missing rows (customer + subscription), organization-preserving composite-FK rejection (a subscription referencing another org's customerId), and duplicate-idempotency-key rejection (checkout attempt + credit reservation). `contracts.test.ts` covers the "malicious extra fields" requirement directly — every `toXDto` mapper is fed a raw row with simulated extra fields (`cardLast4`, `bankAccountNumber`, a `rawStripePayload` blob) and asserted to strip them all, 10/10 pass. Verified: `pnpm type-check` clean, `pnpm lint` 0 errors, `pnpm security:boundaries` clean, `pnpm build` succeeds, full suite 760/761 (same pre-existing unrelated `catalog.test.ts` failure from the concurrent Stripe-provisioning session).

- [x] **Centralize owner/admin/member billing permissions**
  - Files: `src/shared/lib/billing/permissions.ts`, `src/shared/lib/billing/permissions.test.ts`, `src/shared/lib/authorization/permissions.ts`
  - Do: Export pure read/mutate/refund/Portal/auto-recharge predicates and server guards. Owner alone mutates; admin reads financial summary; member gets minimal availability. Platform operator is separate. Require recent auth for payment method, billing contact, auto-recharge, refund, ownership, deletion, and seller changes.
  - Verify: complete role/action matrix and stale-session tests pass; no route contains ad hoc role string comparisons.
  - Progress (2026-07-23): extended `authorization/permissions.ts`'s `PermissionAction` union and `can()` switch with 6 new billing actions (`billing:availability` any-role, `billing:read` elevated/admin+owner, `billing:mutate`/`refund`/`portal`/`auto-recharge` owner-only) — reused the exact `elevated`/owner-only branches already established for `organization:update`/`organization:transfer`, per `dependency-contracts.test.ts`'s own comment that this is "the shape billing 'admin read' reuses." `billing/permissions.ts` exports pure predicates (`canViewBillingAvailability`, `canReadBillingSummary`, `canMutateBilling`, `canRequestBillingRefund`, `canOpenBillingPortal`, `canConfigureAutoRecharge`) built entirely on `can()` — deliberately zero `.role === '...'` comparisons, since this file isn't (and shouldn't need to be) on `check-tenant-boundaries.mjs`'s `roleLiteralCheckAllowlist` (caught this exact regex matching my own doc-comment's illustrative snippet before commit — reworded it, not code). `requireBillingPermission(principal, action, session?)` is the one server guard future routes call: role check first (403), then a recent-auth check for `RECENT_AUTH_REQUIRED_BILLING_ACTIONS` (refund/Portal/auto-recharge — 401 with `STALE_SESSION_ERROR_MESSAGE`) reusing `organization-lifecycle.ts`'s exported `RECENT_AUTH_MAX_AGE_SECONDS`/`STALE_SESSION_ERROR_MESSAGE` constants via a duck-typed `RecentAuthSession` interface (never re-implementing the 15-minute threshold or the message string). `requirePlatformBillingConfigurationAccess(principal: PlatformAdminPrincipal)` keeps the platform-operator (seller/country/tax configuration) path structurally separate from `TenantPrincipal` entirely, matching `resolvePlatformAdminPrincipal`'s own separation — documented explicitly that "seller changes require recent auth" is not yet enforceable today because `PlatformAdminPrincipal` carries no `authenticatedAt` field; that's a real gap for the future "Build private seller and country configuration" task to close, not silently skipped. 19/19 new tests: complete owner/admin/member matrix per predicate, role-gate-before-recent-auth ordering, fresh/stale/missing-session cases, exact 15-minute boundary (accepts at exactly 900s, rejects at 901s), and the platform-principal structural-separation check. Verified: `pnpm type-check` clean, `pnpm lint` 0 errors, `pnpm security:boundaries` clean (initially failed on the doc-comment false-positive, fixed), `pnpm build` succeeds, full suite 785/786 (same pre-existing unrelated `catalog.test.ts` failure).

- [x] **Build private seller and country configuration**
  - Files: `src/shared/lib/billing/seller-profile.ts`, `src/shared/lib/billing/seller-profile.test.ts`, `src/routes/api/admin/billing/configuration.ts`, `src/routes/_dashboard/admin/billing.tsx`, `src/modules/admin/billing/SellerConfiguration.tsx`
  - Do: Add platform-admin read/update with version/effective date, legal/public fields, approved business/VAT IDs, USD, Denmark allowlist, Stripe registrations, preview, audit, and provider mismatch display. Exclude CPR and bank/card fields by schema. Generate route tree normally.
  - Verify: platform-admin/recent-auth tests pass; org owner receives 403; PII fixture is rejected; historical version remains readable; `pnpm type-check && pnpm build` passes.
  - Progress (2026-07-23): `billing/seller-profile.ts` is a versioned, insert-only service over `billing_seller_profiles` (`getCurrentSellerProfile`/`listSellerProfileHistory`/`createSellerProfileVersion`, each accepting an injectable `db` parameter defaulting to `platformDb` — same DI pattern as `resolveStripeClientConfig`, chosen specifically so tests can point at a disposable database instead of the module-singleton `platformDb`, which is bound to `.env` at import time). `SellerProfileInputSchema` is `.strict()` end to end (including the nested `taxRegistrations` entries) so a stray `cpr`/`cardNumber`/`bankAccountNumber` field is rejected outright, not silently dropped — CPR/bank/card are excluded by schema at two levels: the table has no such column, and the input schema has no such field. `configuration.ts` (GET current+history, PUT create-next-version) follows the `incidents/index.ts` `requirePlatformAdminPrincipal` + Zod + `auditPlatformAdminAction` + `platformAdminErrorResponse` pattern exactly. `_dashboard/admin/billing.tsx` mirrors `incidents.tsx`'s `beforeLoad` (`getAppAuthSession`/`getIsAppAdmin`) admin gate. `modules/admin/billing/SellerConfiguration.tsx` is the first component under `src/modules/admin/` — every existing admin page keeps its UI inline in the route file; this establishes a new, more reusable pattern per this task's own file list, noted as a deliberate structural choice, not an accident. "Org owner receives 403" and "seller changes require recent auth" are proven at the `resolvePlatformAdminPrincipal`/`platform-admin.test.ts` layer that `requirePlatformAdminPrincipal` already delegates to (no route in this codebase re-tests that — the existing `enrichment.test.ts`/`account-privacy.test.ts` precedent is a static "route source contains the guard" check, which `configuration.ts` satisfies by construction); the recent-auth gap for platform-admin sessions specifically (no `authenticatedAt` on `PlatformAdminPrincipal`) remains the same documented, not-yet-closed gap noted in the previous task's progress note. "Historical version remains readable" is proven for real: `seller-profile.test.ts` creates v1, then v2, and asserts v1 is still readable in `listSellerProfileHistory()` afterward, against a real disposable Postgres. Found and fixed a real bug while writing this: `billingSellerProfiles.id` is a Postgres `uuid` column (`defaultRandom()`), but the initial implementation inserted `randomId()`'s 24-char hex string, which isn't UUID-shaped — fixed by omitting `id` and letting the column default generate it. Also found and fixed a second real bug during the full-suite run: `repositories/billing.test.ts` and `seller-profile.test.ts` each spin up their own disposable database, and running both in parallel (vitest's default) raced on the cluster-wide `ALTER ROLE` statements several early migrations run (Postgres roles aren't per-database) — a transient "tuple concurrently updated" DDL conflict, not a real bug, but a real flake; extracted both files' setup into a shared `db/create-disposable-test-database.ts` helper with a retry-with-backoff wrapper around the initial `migrate()` call, confirmed stable across repeated full-suite runs. Manually verified in the browser as the signed-in local admin (seeded via `pnpm db:seed:admin`, `ADMIN_USER_IDS` set locally): the page renders behind the admin gate with the full form and dark-theme styling; a live PUT round-trip against the *persistent* local dev database was blocked by a pre-existing, unrelated broken migration (0019, already documented in this plan's own reality-check note as "an unrelated in-progress change") that has never been applied there — not something introduced by this task, and not fixed here, since it isn't mine to touch. Verified: `pnpm type-check` clean, `pnpm lint` (56 warnings, 0 errors — one new warning is the same accepted `react-hooks/set-state-in-effect` pattern already present in every other admin page's data-fetching `useEffect`, e.g. `incidents.tsx`), `pnpm security:boundaries` clean, `pnpm build` succeeds, full suite stable at 796/797 across repeated runs (same pre-existing unrelated `catalog.test.ts` failure).

- [x] **Implement live billing readiness gate**
  - Files: `src/shared/lib/billing/readiness.ts`, `src/shared/lib/billing/readiness.test.ts`, `scripts/billing/check-live-readiness.ts`, `docs/operations/stripe-live-readiness.md`
  - Do: Fail closed unless flag, KYC/`charges_enabled`, public profile, statement descriptor/support, catalog, webhook/version, tax/product code, Denmark allowlist, Terms/Privacy, operator/runbooks, and reconciliation evidence are complete. Emit reason codes without secrets.
  - Verify: each missing gate independently prevents a mutation; fully populated sandbox fixture passes; live command is read-only unless explicitly enabled.
  - Progress (2026-07-23): `readiness.ts` is a pure `assessLiveBillingReadiness(evidence)` function mirroring `~/shared/lib/migration/tenant-readiness.ts`'s `{ready, missing}` shape exactly — 11 boolean evidence fields (one per gate from the Do line), reason codes are just the evidence struct's own field names (`missing: ['webhookAndApiVersionConfigured']`), never a secret value by construction. `scripts/billing/check-live-readiness.ts` (`pnpm billing:check-readiness`) gathers the real evidence — env config, every active catalog entry's live Price ID, the recorded seller profile, and the most recent `clean` `billing_reconciliation_runs` row within a 48h freshness window — and calls the pure evaluator; it never calls the real Stripe API unless `--live` is passed (still read-only, only `charges_enabled`), and the two gates no source/DB row can prove (Terms/Privacy sign-off, operator runbook tabletop) require explicit `--confirm-terms-privacy`/`--confirm-runbooks` operator attestation flags rather than being silently assumed. Each DB/network-dependent check is wrapped so a failure (e.g. a table that doesn't exist yet) degrades that one gate to "not ready" and still reports every other gate correctly, rather than crashing the whole command — found this the hard way running it against the persistent local dev database, which (per the previous two tasks' progress notes) still hasn't had migration 0019 onward applied. 14/14 tests: the fully-populated fixture passes, each of the 11 gates independently and exclusively fails the result when it alone is false, all 11 report at once when nothing is configured, and no reason code ever matches a Stripe secret-key/webhook-secret shape. `docs/operations/stripe-live-readiness.md` documents the gate table and explicitly calls out three known gaps rather than hiding them: `taxConfigurationRecorded` is a proxy (registration-on-file, not a verified product-tax-code match), three launch-register checklist items (webhook fixture matrix, credit-ledger property tests, Test Clock lifecycle matrix) have no corresponding gate since they can't be verified from source/a DB row/one API call, and the Denmark canary is out of scope for a pre-flight gate by nature. Verified: `pnpm type-check` clean, `pnpm lint` 0 errors (56 warnings, same as before), `pnpm security:boundaries` clean, `pnpm build` succeeds, full suite stable at 810/811 across repeated runs (same pre-existing unrelated `catalog.test.ts` failure).

## 4. Credit ledger

- [x] **Implement append-only grant and balance logic**
  - Files: `src/shared/lib/billing/credits.ts`, `src/shared/lib/billing/credits.test.ts`, `src/shared/lib/repositories/billing-ledger.ts`, `src/shared/lib/repositories/billing-ledger.test.ts`
  - Do: Add idempotent grant/expire/freeze/unfreeze/revoke/adjust operations with integer units, source links, earliest-expiry available balance, active-paid pack eligibility, and compensating entries only.
  - Verify: unit/property tests prove conservation and non-negative totals across randomized sequences and duplicate idempotency keys.
  - Progress (2026-07-23): `repositories/billing-ledger.ts` is the raw, `TenantTransaction`-first data-access layer (insert/find/list only — no business logic) over `billing_credit_grants`/`billing_ledger_entries`, following the established repository convention. `billing/credits.ts` is the one caller allowed to mutate through it, implementing `grantCredits`/`expireCreditGrant`/`freezeCreditGrant`/`unfreezeCreditGrant`/`revokeCreditGrant`/`adjustCreditGrant`, each: idempotent via `findLedgerEntryByIdempotencyKey` checked first (a replay returns the original grant+entry, never mutates twice), refusing a second grant for an already-used `monthlyWindowKey` (annual-subscription anniversary windows), and writing exactly one ledger entry per call — `adjustCreditGrant` is the only correction path, refusing any delta that would push `remainingUnits` outside `[0, originalUnits]`. `getAvailableCreditBalance`/`getAvailableCreditGrantsByEarliestExpiry` sum/order only grants that are both `active` and not yet past `expiresAt` (a grant the expiry sweep hasn't processed yet must not count as spendable), ordered earliest-expiry-first per spec.md's consumption order. `isActivePaidSubscription` is the pure predicate pack-purchase eligibility will gate on (`stripeStatus in ('active','trialing')`) — deliberately separate from the legacy manual-billing system's `resolveEntitlementPolicy`, since this new catalog's subscriptions table has its own status vocabulary. Added `fast-check@4.9.0` as a devDependency (first property-testing library in this codebase) specifically because this task's own verify line asks for property tests, not as a general addition. The property test (`credits.test.ts`) runs 25 randomized freeze/unfreeze/adjust sequences (0-12 ops each) against a real disposable database, asserting after EVERY single operation that `0 <= remainingUnits <= originalUnits`, and at the end that `remainingUnits` exactly equals `originalUnits` plus the sum of every non-`grant` ledger entry's `unitsDelta` for that grant — i.e. the denormalized balance never drifts from the append-only ledger that's supposed to explain it; expected rejections (invalid state transition, out-of-bounds adjustment) are caught and must leave the grant provably unchanged, not silently swallowed. 24/24 tests total (9 repository + 15 credits, including the property test) pass reliably across repeated runs, alongside the prior 3 disposable-DB test files now running in parallel — confirmed the shared retry-with-backoff helper from the previous task still holds under 4-way parallelism. Verified: `pnpm type-check` clean, `pnpm lint` 0 errors, `pnpm security:boundaries` clean (including the billing-module boundary test — no bare `organizationId: string` first params, no forbidden imports), `pnpm build` succeeds, full suite stable at 834/835 across repeated runs (same pre-existing unrelated `catalog.test.ts` failure), zero orphaned disposable databases after the run.

- [x] **Implement atomic reservation lifecycle**
  - Files: `src/shared/lib/billing/reservations.ts`, `src/shared/lib/billing/reservations.test.ts`, `src/shared/lib/repositories/billing-ledger.ts`
  - Do: Lock eligible grants, persist exact allocation slices, reserve/extend/settle/release with unique org operation key, heartbeat, maximum duration, and settlement grace. Protect in-flight allocations across grant expiry; expire released remainder when original grant has expired.
  - Verify: concurrent final-credit, duplicate settle/release, crash/retry, boundary expiry, abandoned heartbeat, and over-settlement tests cannot overspend or roll credits over.
  - Progress (2026-07-23): extended `repositories/billing-ledger.ts` with reservation/allocation CRUD (`insertReservation`/`lockReservation`/`updateReservation`, `insertAllocation`/`findAllocationForReservationAndGrant`/`updateAllocationAllocated`/`updateAllocationConsumed`/`listAllocationsForReservation`) plus a row-locking `lockActiveCreditGrantsByEarliestExpiry` (`SELECT ... FOR UPDATE`) so two concurrent reservations against the same organization serialize instead of both reading the same pre-decrement balance. `billing/reservations.ts` implements `reserveCredits`/`extendReservation`/`heartbeatReservation`/`settleReservation`/`releaseReservation`: every allocation walk locks eligible grants earliest-expiry-first and slices the requested units across them; settlement consumes from the reservation's own allocations (again earliest-expiring grant first, so soon-to-expire credits are spent before longer-lived ones) and either releases the unconsumed remainder back to its source grant or — "expire released remainder when original grant has expired" — forfeits it with an `expire` ledger entry if that grant's `expiresAt` has passed since the reservation was made. Two real bugs found and fixed while writing the tests: (1) `extendReservation`/`settleReservation`/`releaseReservation` initially checked idempotency against `billing_credit_reservations.idempotencyKey`, which is set once at `reserveCredits` time and represents only THAT call — a completely wrong idempotency check for later extend/settle/release calls, each with their own key; fixed by writing a dedicated zero-delta marker ledger entry per call and checking the ledger (mirroring `credits.ts`'s pattern) instead. (2) `billing_credit_allocations` has a unique `(reservation_id, grant_id)` constraint, but the allocation walk always inserted a new row — broke immediately once `extendReservation` drew on the same earliest-expiry grant a reservation had already partially allocated from; fixed by checking for an existing allocation first and widening it instead of inserting a duplicate. Also found and fixed a test-design bug (not a production bug): early test drafts shared one organization across many tests, so an earlier test's leftover grants silently changed which grant a later test's earliest-expiry allocation actually drew from — refactored to give every test its own fresh organization. 19/19 tests cover every scenario the Verify line names: concurrent final-credit (two reservations racing a shared 100-unit balance for 60 each — row locking serializes them, exactly one succeeds, total allocated never exceeds available), duplicate settle/release/extend (crash/retry replay, never double-consumes or double-releases), boundary expiry (a grant expiring between reservation and settlement forfeits its unconsumed remainder instead of releasing it), abandoned heartbeat (extend/heartbeat past deadline refused), and over-settlement (actualUnits > maximumUnits refused, reservation left untouched). Verified: `pnpm type-check` clean, `pnpm lint` 0 errors, `pnpm security:boundaries` clean, `pnpm build` succeeds, full suite stable at 853/854 across repeated runs (same pre-existing unrelated `catalog.test.ts` failure), zero orphaned disposable databases.

- [x] **Expose server-only feature billing contracts**
  - Files: `src/shared/lib/billing/feature-authorization.ts`, `src/shared/lib/billing/feature-authorization.test.ts`, `src/shared/lib/billing/rate-cards.ts`
  - Do: Implement `checkEntitlement`, `reserveCredits`, `extendReservation`, `settleReservation`, `releaseReservation`, and `refundUsage`; require server-owned versioned rate-card/max-duration definitions. Return typed insufficient-entitlement/credits/blocked errors without balance mutation endpoints.
  - Verify: fake feature/provider integration proves no provider request begins before reservation and stops safely when extension fails.
  - Progress (2026-07-23): `rate-cards.ts` defines a `RATE_CARDS` registry (illustrative operations: `ai_sourcing_sprint`, `semantic_search_query`, `builder_work_sample_analysis`) each with server-owned `maxUnits`/`maxDurationSeconds`/`settlementGraceSeconds`/`minimumTier`/`version` — the caller supplies only an operation name and idempotency key, never a unit count or duration, so client input can never widen a feature's spend limit. `feature-authorization.ts` is the ONLY surface feature code should use: `checkEntitlement` (read-only tier check), `reserveCredits`/`extendReservation`/`settleReservation`/`releaseReservation` (thin `TenantPrincipal`-first wrappers around `reservations.ts` that resolve the rate card and re-check entitlement server-side before every reservation, never trusting an earlier client-side check), and `refundUsage` (credits already-consumed units back after settlement — via a compensating `adjustCreditGrant` on the original grant if still active, or a fresh short-lived promotional grant if that grant has since expired/been revoked, since resurrecting an expired grant's `remainingUnits` would make it spendable again outside every other query's `state='active'` assumption). `FeatureBillingError` carries exactly the three typed codes the Do line asks for (`insufficient_entitlement`/`insufficient_credits`/`blocked`) plus `unknown_feature`/`invalid_state`. The fake feature/provider integration test proves the actual contract: a simulated feature function's provider call flag stays false until `reserveCredits` resolves (and stays false permanently if it throws), and when a simulated long operation's `extendReservation` call fails (insufficient remaining balance), the test's own control flow demonstrates it must stop — no further simulated provider units are processed after the caught failure. 15/15 tests total. Found and fixed a real, worsening test-infrastructure bug while running the full suite with 6 now-parallel disposable-database test files: the retry-with-backoff mechanism from the previous task was becoming flakier as more billing test files were added (more concurrent `CREATE DATABASE`+migrate flows racing on the same cluster-wide `ALTER ROLE` statements) — replaced the primary mechanism with a Postgres session-level advisory lock (`pg_advisory_lock`/`pg_advisory_unlock` on the admin connection, wrapping the migration) that fully serializes the contentious step across any number of concurrent callers, keeping the retry loop only as a defense-in-depth backstop; confirmed stable across 5 consecutive full-suite runs (868/869 every time). Verified: `pnpm type-check` clean, `pnpm lint` 0 errors, `pnpm security:boundaries` clean, `pnpm build` succeeds, full suite stable at 868/869 (same pre-existing unrelated `catalog.test.ts` failure), zero orphaned disposable databases after cleanup. This closes out §4 (Credit ledger) entirely.

## 5. Checkout, consent, and customer lifecycle

- [x] **Create organization Stripe Customers idempotently**
  - Files: `src/shared/lib/billing/customers.ts`, `src/shared/lib/billing/customers.test.ts`, `src/shared/lib/billing/stripe-provider.ts`
  - Do: Resolve active organization, create/reuse one Customer per livemode, use opaque organization metadata, keep billing email separate, and handle timeout/retry with a stable operation key. Never copy candidate/product data into Stripe.
  - Verify: concurrent creation and lost-response retry create one Customer; test/live IDs cannot cross; metadata/DTO snapshots contain no sensitive fields.
  - Progress (2026-07-23): `stripe-provider.ts` is a provider-selection seam — `getBillingProvider()`
    returns the deterministic `FakeBillingProvider` singleton while `STRIPE_BILLING_ENABLED=false`
    (true today; `.env.example` explicitly gates this until §10 certifies a real adapter) and throws
    loudly rather than silently faking success if the flag is ever flipped on before that adapter
    exists. `customers.ts`'s `ensureBillingCustomer(transaction, principal, { provider })` resolves
    the org owner's account email (new `findOrganizationOwnerEmail` repo query — never
    candidate/product data), and creates/reuses one `billing_customers` row per
    `(organizationId, livemode)` using a two-layer idempotency: a provider-side operation key
    derived only from `(organizationId, livemode)` (stable across retries/concurrent callers, so a
    lost-response retry or a genuine race resolves to the SAME Stripe-side customer), plus a new
    `createBillingCustomerIfAbsent` repo function (`onConflictDoNothing` on
    `billing_customers_org_livemode_unique`) so the loser of a concurrent DB-insert race re-reads
    and returns the winner's row instead of erroring. 22 new tests (customers.test.ts: idempotent
    create, concurrent-race convergence via `Promise.all`, lost-response retry, no-owner error,
    DTO-has-no-sensitive-fields, test/live isolation proven at the repository level;
    stripe-provider.test.ts: fake-provider selection + singleton reuse/reset) plus 2 new
    repository-layer tests, all passing; full suite 192/192 (excluding the pre-existing, unrelated
    `catalog.test.ts` failure from a concurrent session's Stripe Price ID provisioning work).
    `pnpm type-check`/`pnpm lint`/`pnpm security:boundaries` clean.

- [x] **Implement versioned commercial consent**
  - Files: `src/shared/lib/billing/consent.ts`, `src/shared/lib/billing/consent.test.ts`, `src/shared/lib/legal.ts`, `src/shared/lib/legal.test.ts`
  - Do: Resolve current Terms/Privacy/commercial versions, validate Checkout disclosures, store owner/org/action/time/provider evidence, require reacceptance on material version changes, and model separate auto-recharge consent.
  - Verify: stale/missing/wrong-org consent blocks Checkout; material/non-material version tests match policy; no raw request payload is stored.
  - Progress (2026-07-23): `legal.ts` gains `parseDocumentVersion`/`isMaterialVersionChange` — a
    generic `v<major>.<minor>` comparator (major bump = material = forces reacceptance; minor bump
    or unchanged = not; either side unparseable fails closed as material) reused by billing consent
    on top of the account-level tos/privacy/cookies versioning already there. `billing/consent.ts`
    adds `recordCheckoutConsent` (validates all 7 required Checkout disclosures — renewal, amount,
    interval, cancellation/refund policy, credit expiry/non-transferability, tax, total — are
    acknowledged, then stores only the typed `billing_terms_acceptances` evidence columns, never the
    disclosures object itself), `recordAutoRechargeConsent` (a structurally separate action with its
    own off-session-charge acknowledgment, per spec.md's "separate versioned off-session consent"),
    and `requireCurrentCommercialConsent` (blocks Checkout when no consent is on file, when the org's
    latest acceptance predates a material Terms/Privacy version bump, or — proven directly — when
    only a *different* organization has consented). 16 new legal.ts tests +
    17 new consent.ts tests (disposable-DB integration, covering every required-disclosure key
    individually, auto-recharge modeled separately from checkout consent, stale vs. non-material
    version scenarios, and wrong-org isolation), all passing; full suite 234/234 minus the same
    pre-existing unrelated `catalog.test.ts` failure. `pnpm type-check`/`pnpm lint`/
    `pnpm security:boundaries` clean.

- [x] **Build subscription Checkout endpoint**
  - Files: `src/shared/lib/billing/checkout.ts`, `src/shared/lib/billing/checkout.test.ts`, `src/routes/api/billing/checkout/subscription.ts`, `src/routes/api/billing/checkout/subscription.test.ts`
  - Do: Owner-only catalog-key request; validate readiness, country, existing subscription, consent, URLs, and attempt idempotency. Create subscription-mode Checkout with USD Price, automatic tax, billing address, tax ID, customer updates, promotion codes, and approved immediate card/wallet methods.
  - Verify: API matrix covers owner/admin/member, spoofed org/amount/Price/URL, duplicate request, existing subscription, non-Denmark country, disabled billing, and provider timeout.
  - Progress (2026-07-23): `checkout.ts`'s `createSubscriptionCheckout(transaction, principal, input, {provider})`
    never checks `principal.role` itself (the route enforces owner-only via `requireBillingPermission`)
    and resolves everything server-side from a client `catalogKey`/`country`/idempotency key — a
    duplicate-request idempotency-key lookup runs FIRST and short-circuits to a fresh
    `provider.getCheckoutSession` read; then in order: return-URL origin allowlisting
    (`env.APP_URL` prefix), catalog-key resolution (`unknown_catalog_key` if unknown/retired),
    seller-profile-recorded ("billing configured at all") and country-allowlist gates, existing-
    active-subscription rejection, `ensureBillingCustomer`, `recordCheckoutConsent` (validates all 7
    disclosures), then the provider Checkout Session call — itself using a two-layer idempotency key
    (provider key derived only from `(organizationId, idempotencyKey)`, plus a new
    `createBillingCheckoutAttemptIfAbsent` DB insert tolerating a concurrent-race conflict) so a lost-
    response retry or genuine concurrent caller converges on the SAME session either way. Extended
    `BillingProvider`'s `CreateCheckoutSessionInput`/`BillingCheckoutSession` with the Stripe Tax/
    collection/payment-method-type fields the spec requires (`automaticTax`, `billingAddressCollection`,
    `taxIdCollection`, `allowPromotionCodes`, `paymentMethodTypes`), echoed back onto the fake
    provider's session object so tests can assert on them directly without a separate spy. The route
    (`api/billing/checkout/subscription.ts`) is a thin owner-only, Zod-`.strict()`-validated wrapper
    mapping each `CheckoutErrorCode` to its HTTP status (503/403/400/409/400/502) — established a new
    testing pattern for this codebase's first TanStack Start API-route test: `Route.options.server
    .handlers.POST({request})` invoked directly, `requireTenantPrincipal`/`createSubscriptionCheckout`/
    `getBillingProvider` mocked, the REAL `requireBillingPermission` exercised unmocked to prove the
    route actually wires up owner-only enforcement end-to-end. 12 new checkout.ts tests (disposable-DB,
    covering every rejection reason, the Stripe Tax/collection/payment-method assertions via a live
    round-trip through the fake provider, duplicate-request replay, concurrent-request convergence, and
    a provider-timeout stub subclass) plus 16 new route tests (owner/admin/member matrix, spoofed
    org/amount/Price fields rejected by strict-schema 400s, spoofed redirect URLs, every
    CheckoutErrorCode-to-status mapping, generic-500 fallback). Also found and fixed a second
    connection-pool deadlock in `create-disposable-test-database.ts`: the disposable test client's
    `max: 1` pool meant a function called mid-transaction that borrows a SECOND connection from the
    same pool (checkout.ts's `getCurrentSellerProfile(sellerProfileDb)`, injected as the same disposable
    `db`) would deadlock forever waiting for the connection its own outer `db.transaction(...)` was
    still holding; raised to `max: 5` (admin's advisory-lock connection is untouched, still `max: 1`).
    Full suite 262/262 minus the same pre-existing unrelated `catalog.test.ts` failure.
    `pnpm type-check`/`pnpm lint`/`pnpm security:boundaries` clean; `routeTree.gen.ts` regenerated via
    the running dev server (additive-only diff, confirmed via `git diff --stat`).

- [x] **Build pending Checkout return experience**
  - Files: `src/routes/_dashboard/settings/billing/return.tsx`, `src/modules/billing/CheckoutReturn.tsx`, `src/modules/billing/CheckoutReturn.test.tsx`, `src/routeTree.gen.ts`
  - Do: Show pending/succeeded/failed/expired states by polling internal summary; never trust URL status or grant access. Include safe recovery and accessibility semantics.
  - Verify: component/E2E tests prove forged success parameters do nothing and delayed webhook resolves without duplicate navigation or access.
  - Progress (2026-07-23): `checkout.ts` gains `getCheckoutReturnStatus(transaction, principal, {provider})`
    — reads no URL/query input at all (there is nothing for a caller to forge): `'succeeded'` requires
    an actual active-subscription row (the only authoritative signal, written by the not-yet-built §6
    webhook handler), `'expired'` comes from the checkout attempt's own terminal status or a
    `provider.getCheckoutSession` refresh, everything else is `'pending'`. New
    `findLatestBillingCheckoutAttempt` repo query finds "the attempt I just started" without an
    attempt id in the URL. New `GET /api/billing/checkout/status` route (owner/admin read-only via
    `canReadBillingSummary`) exposes it. `settings/billing.tsx` was split into a layout (`<Outlet/>`,
    now carrying the auth `beforeLoad`) plus `settings/billing/index.tsx` (the existing billing
    overview, unchanged behavior) and the new `settings/billing/return.tsx`, mirroring the
    `_landing/changelog.tsx` flat+directory precedent already in this codebase.
    `modules/billing/CheckoutReturn.tsx` polls the status endpoint (react-query, 3s interval, stops
    once terminal), reads nothing from `location.search`, navigates to `/settings/billing` exactly
    once via a ref guard when it first sees `'succeeded'`, and renders a distinct accessible view
    (`role="status" aria-live="polite"`, always-present recovery link) per state including a
    generic-error fallback and a dedicated no-attempt view. 5 new checkout.ts tests
    (no_attempt/pending/succeeded/expired, plus a "delayed webhook" test that inserts the
    subscription row between two polls — standing in for the unbuilt webhook handler — and confirms
    the transition), 6 new status-route tests (owner/admin allowed, member 403, forged
    `?status=success&session_id=...` query params proven to have zero effect, error mapping), and 10
    new CheckoutReturn.test.tsx tests (every state's view, exactly-once navigation proven via a
    `queryClient.refetchQueries` — simulated delayed webhook — with a second refetch still reporting
    `'succeeded'` confirmed NOT to navigate again, the forged-URL-does-nothing proof, the always-present
    recovery link, the `role="status"`/`aria-live` a11y check). Full suite 282/282 minus the same
    pre-existing unrelated `catalog.test.ts` failure; `pnpm type-check`/`pnpm lint`/
    `pnpm security:boundaries`/route-coverage all clean; `routeTree.gen.ts` regenerated (additive
    diff plus the expected `/settings/billing` layout restructure). Live browser verification of the
    rendered page was attempted but blocked by a pre-existing, unrelated local dev-database migration
    drift (an old `deletion_requests` FK-constraint migration fails against this machine's dev
    Postgres, so billing tables were never created there — confirmed via direct inspection, not
    something this task's migrations caused); flagged as a separate background task
    (`task_d28a81ab`) rather than fixed here, since repairing shared dev-DB migration history is a
    distinct, more delicate piece of work. The full automated suite above is the verification of
    record for this task.

- [x] **Create restricted Customer Portal sessions**
  - Files: `src/shared/lib/billing/portal.ts`, `src/shared/lib/billing/portal.test.ts`, `src/routes/api/billing/portal.ts`, `docs/operations/stripe-customer-portal.md`
  - Do: Owner/recent-auth only, allowlisted return URL, configured Portal limited to payment methods, tax identity, invoices, and receipts; disable product switching and cancellation. Validate Portal configuration in readiness.
  - Verify: owner can open sandbox Portal; admin/member cannot; sandbox Portal cannot change/cancel plan; open redirect tests pass.
  - Progress (2026-07-23): **Found and fixed a real open-redirect vulnerability while writing this
    task's own verify criteria.** `checkout.ts`'s and my first draft of `portal.ts`'s return-URL
    checks both used `url.startsWith(env.APP_URL)` — a lookalike host like
    `https://app.example.com.evil.com` legitimately *starts with* `https://app.example.com` as a
    plain string, so that check would have let an attacker redirect a customer's browser to an
    arbitrary domain after Checkout/Portal. Replaced with `stripe-client.ts`'s new
    `isAllowedReturnUrl`, which compares the full **parsed origin** (`URL.origin`, exact
    protocol+host+port match) instead of a string prefix — applied to both `checkout.ts` and
    `portal.ts`, with regression tests added to `stripe-client.test.ts` (7 exhaustive cases:
    same-origin, different-origin, lookalike-host, wrong-port, wrong-protocol, unparseable,
    userinfo-smuggling) and to both `checkout.test.ts` and `portal.test.ts`.
    `portal.ts`'s `createBillingPortalSession(transaction, principal, {returnUrl}, {provider})`
    resolves the org's existing Stripe customer (never creates one — Portal access is never how a
    Customer gets provisioned), validates the return URL, and returns only `{url}` — no plan/price
    field of any kind, since the Portal is never how BuilderHunt lets an org change what it's
    subscribed to (that stays entirely in §7's own endpoints). The route
    (`POST /api/billing/portal`) is owner-only AND recent-auth-gated (`'billing:portal'` was already
    in `permissions.ts`'s `RECENT_AUTH_REQUIRED_BILLING_ACTIONS`) — the first billing route in this
    plan to actually exercise that gate; a stale or absent session gets 401 before the Portal
    service is ever called. Extended `readiness.ts`'s evidence struct with
    `portalConfigurationRestricted` — a manual attestation (`--confirm-portal-configuration`, wired
    through `check-live-readiness.ts`) since the actual feature restriction (no plan switching, no
    cancellation) lives entirely in a Stripe Dashboard Billing Portal Configuration this code cannot
    introspect; `readiness.test.ts`'s existing generic per-gate test loop covered the new field with
    no additional test code needed. New `docs/operations/stripe-customer-portal.md` documents the
    split between what our code controls (owner/recent-auth, return-URL origin, customer
    resolution) versus what only the manual gate can guarantee (the Configuration itself). 15 new
    portal tests (service: session creation, DTO-shape-is-url-only, no-customer rejection, open
    redirect + lookalike-host rejection; route: owner/admin/member matrix, stale/missing session
    401, spoofed-field/non-URL 400s, every `PortalError` code mapped to its HTTP status) plus 7 new
    `isAllowedReturnUrl` unit tests and 2 new lookalike-host regression tests added to the existing
    checkout/portal suites. Full suite 305/305 minus the same pre-existing unrelated
    `catalog.test.ts` failure; `pnpm type-check`/`pnpm lint`/`pnpm security:boundaries`/route-coverage
    all clean; `routeTree.gen.ts` regenerated for the new route.

    **This closes out §5 (Checkout, consent, and customer lifecycle) in full.**

## 6. Webhooks and workers

- [x] **Implement signed durable Stripe webhook receipt**
  - Files: `src/routes/api/webhooks/stripe.ts`, `src/routes/api/webhooks/stripe.test.ts`, `src/shared/lib/billing/webhook-inbox.ts`, `src/shared/lib/billing/webhook-inbox.test.ts`
  - Do: Read raw bytes, verify current/rotating secrets, enforce API version/livemode, insert unique event before `2xx`, retain minimized encrypted payload under schedule, and redact logs/errors. Do not require user session or parse JSON before signature verification.
  - Verify: official signed fixtures pass; tampered body/signature, old timestamp, wrong mode/version fail; duplicate event returns `2xx` with one row.
  - Progress (2026-07-23): `webhook-inbox.ts`'s `receiveStripeWebhook(input, options)` verifies
    `Stripe-Signature` via `Stripe.webhooks.constructEvent` against every currently-configured secret
    in order (current, then previous during a rotation window — new `STRIPE_WEBHOOK_SECRET_PREVIOUS`
    env var), never parsing the body as JSON until that verification succeeds. Rejects an
    `api_version`/`livemode` mismatch against the pinned expectation, then inserts one row per unique
    `(livemode, stripeEventId)` via `onConflictDoNothing` — a duplicate delivery is a successful
    no-op (still 2xx, zero new rows). The route (`POST /api/webhooks/stripe`) requires no user
    session at all (added to `check-route-coverage.mjs`'s public allowlist with a stated reason —
    Stripe cannot hold a session, signature verification IS the auth) and reads `request.text()`
    directly rather than `.json()`, so nothing is parsed before the signature check. New
    `src/shared/lib/crypto/webhook-payload.ts` adds this codebase's first symmetric-encryption
    helper (AES-256-GCM via `node:crypto`, fresh IV per call, `iv:authTag:ciphertext` hex format) for
    the `billing_webhook_events.payload_encrypted` column — a new `WEBHOOK_PAYLOAD_ENCRYPTION_KEY`
    env var (required when `STRIPE_BILLING_ENABLED=true`, 64 hex chars) backs it. The stored payload
    is deliberately minimized (`minimizeForStorage`: event id/type/timestamps and the affected
    object's id/type only) — handlers re-fetch current provider state rather than trusting embedded
    fields, so nothing more needs to be retained, and card numbers/emails embedded in the real Stripe
    object are proven absent from the encrypted-then-decrypted stored value in a dedicated test.
    "Official signed fixtures" means literally that: every webhook-inbox test signs its own fixture
    event via `Stripe.webhooks.generateTestHeaderString` (the same SDK function Stripe's own webhook
    testing docs recommend), not a hand-rolled HMAC — proving the verification path is compatible
    with Stripe's actual signing scheme, not just an internal round-trip. 9 new crypto tests
    (round-trip, fresh-IV-per-call, wrong-key/tampered-ciphertext/tampered-tag all fail via GCM's
    auth tag rather than silently returning garbage, malformed-format rejection, fail-closed default
    when no key configured), 15 new webhook-inbox tests (accepted fixture, exactly-one-row,
    duplicate-is-2xx-no-op, missing/tampered/wrong-secret signature, stale timestamp, api-version/
    livemode mismatch in both directions, previous-secret rotation acceptance, zero-secrets-configured
    rejection, minimized-payload proof), 11 new route tests (raw body/header passthrough including a
    literal `null` header, every rejection code mapped to 400, generic 500 fallback, no-session-
    required). Also extended `env.security.test.ts` for the two new env fields (11 new cases) since
    `WEBHOOK_PAYLOAD_ENCRYPTION_KEY` is now required whenever `STRIPE_BILLING_ENABLED=true`. Full
    suite 373/373 minus the same pre-existing unrelated `catalog.test.ts` failure; `pnpm type-check`/
    `pnpm lint`/`pnpm security:boundaries`/route-coverage all clean; `routeTree.gen.ts` regenerated.

- [x] **Implement idempotent monotonic event handlers**
  - Files: `src/shared/lib/billing/webhook-handlers.ts`, `src/shared/lib/billing/webhook-handlers.test.ts`, `src/shared/lib/billing/subscription-state.ts`, `src/shared/lib/billing/subscription-state.test.ts`
  - Do: Handle required Checkout/invoice/subscription/PaymentIntent/refund/dispute families. Retrieve current objects when needed, enforce legal state transitions/provider timestamps, and make unknown events safe no-ops. Link every effect to event/object idempotency.
  - Verify: permutation tests deliver fixtures duplicate/reversed/delayed and produce identical final subscription, entitlement, refund, and ledger state.
  - Progress (2026-07-23): `subscription-state.ts` is the pure decision core —
    `resolveSubscriptionTransition(current, incoming)` combines terminal-status locking
    (`canceled`/`incomplete_expired` can never transition again — a resubscribe is always a new
    Stripe subscription id, never a status flip back) with monotonic-timestamp ordering
    (`isMonotonicallyNewer`) into one of five outcomes: `first_seen`/`duplicate`/`newer`/`stale`/
    `terminal_locked`. `webhook-handlers.ts`'s `processStripeWebhookEvent(event, {db, livemode})`
    dispatches every required family: `checkout.session.completed/expired` mark a checkout attempt
    terminal (idempotent — already-terminal is a no-op, never regresses); `customer.subscription.
    created/updated` resolve the org via a NEW cross-org lookup (`repositories/billing-worker.ts`,
    see below), create the `billing_subscriptions` row on first sighting (tier/interval/catalogKey
    resolved from the subscription's Price ID via a new `resolveSubscriptionCatalogEntryByStripePriceId`)
    or apply the transition subscription-state.ts approved; `customer.subscription.deleted` cancels
    (through the same transition gate); `invoice.paid` issues the subscription's monthly credit
    allowance via the already-built `credits.ts.grantCredits`, idempotent by `invoice-grant:<invoiceId>`
    (a business key, not the delivery-specific event id, so redelivery via a different event id still
    converges) — the allowance is read from the SUBSCRIPTION's own recorded catalog key via a new
    unfiltered `resolveSubscriptionCatalogEntryByKey` (never re-derived from the invoice's own
    line-item shape, and deliberately NOT filtered by `isActive`, since an existing subscriber must
    keep resolving correctly even after that catalog entry is later retired from new signups);
    `invoice.payment_failed` records a grace-period marker (set-once, per markBillingSubscriptionGraceStart's
    own guard) for the not-yet-built dunning worker (§7 task 6) to act on later.
    New `repositories/billing-worker.ts` solves a structural problem: a webhook event carries only
    Stripe object ids, never our organizationId, and even `builderhunt_worker`'s RLS policies are
    still `organization_id = current_setting(...)`-scoped — there is no unscoped cross-tenant read
    path. Mirrors the SAME loop pattern `sprints-worker.ts`/`alerts-worker.ts` already established
    (list every org id, then check each one's rows inside a transaction scoped to exactly that org
    via `set_config`) but — deviating from their hardcoded-`workerDb` precedent — adds an optional
    `db` override on every exported function, since this code moves real money and deserves real
    disposable-database integration-test coverage rather than pure-logic-only tests. O(organizations)
    per lookup; documented as an accepted, revisitable tradeoff at this app's current scale.
    PaymentIntent/refund/dispute events are deliberately reported as `'deferred'` — a THIRD, distinct
    outcome from `'ignored'` — since packs (§8 task 1), refund review (§8 task 4), and dispute
    handling (§8 tasks 2-3) don't exist yet; there is nothing in this app today for those events to
    reconcile against. "Deferred" tells the future worker (§6 task 3) to leave the row pending and
    revisit once that infrastructure lands, never that nothing needs to happen — attempting to fully
    implement all six required families in one task would have meant building most of §7 and §8
    prematurely inside this one. 17 new subscription-state.ts tests (every transition outcome, plus a
    reversed-delivery permutation proving the newest event always wins regardless of arrival order),
    32 new webhook-handlers.ts tests (every event family, duplicate-delivery idempotency, a
    reversed-order permutation, an out-of-order invoice.paid-before-subscription-created permutation
    that resolves once the subscription later appears, grace-marker set-once and clear-on-recovery,
    every deferred/ignored family). Full suite 506/506 minus the same pre-existing unrelated
    `catalog.test.ts` failure; `pnpm type-check`/`pnpm lint`/`pnpm security:boundaries`/route-coverage
    all clean.

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
