# App Reality — Ground Truth (2026-07-24)

This document is the single source of truth about what is ACTUALLY implemented in
BuilderHunt today. Every plan in `plans/` must be written against this reality, not
against what older specs (or older versions of this document) imagined. If a plan
contradicts this document, the plan is wrong.

> **2026-07-24 rewrite note**: the 2026-07-23 version had drifted materially in one day,
> almost entirely because of how much of `stripe-billing-platform` landed. It claimed
> "no Checkout, webhooks, credit ledger, or real payment processing exist yet" and
> "4/~40 tasks" — in fact ~60 billing modules, a Stripe webhook receipt endpoint, the
> credit ledger, and 19 `billing_*` tables all exist in code. It also misclassified
> `builder_notes` as legacy per-user, and its migration/table/test counts were roughly
> half of the real numbers. Every count below was re-derived by command
> (`ls drizzle/*.sql`, `grep -c '= pgTable('`, `pnpm test`), not carried forward.
>
> **2026-07-23 rewrite note**: the version before that (dated 2026-07-19) was
> significantly stale — written before `security-and-multitenancy` shipped Better Auth
> Organizations/RLS/tenant roles, before `team-accounts` completed, and before
> `semantic-search`/`ai-sourcing-sprints`/`proactive-discovery`/`ai-expansion` all landed.
> It still described a single-tenant, per-user, no-AI app.
>
> **Lesson worth acting on**: this file has now been materially stale at two consecutive
> checks. Treat every *count* and every "NOT implemented" claim here as needing
> re-verification against the code before a plan leans on it. The architecture and
> constraint sections age far better than the inventories.

## Stack

- **Framework**: TanStack Start (React 19, file-based routes in `src/routes/`, API routes
  as server route files under `src/routes/api/`). Router tree generated in `src/routeTree.gen.ts`.
- **DB**: PostgreSQL via Drizzle ORM (`src/shared/lib/db/schema.ts`, **86 migrations** in
  `drizzle/`, **95 tables** — verified 2026-07-27; two of those migrations, `0084`/`0085`, are
  still untracked working-tree WIP, so a clean checkout sees 84 and 92. These counts drift
  weekly: re-derive with `ls drizzle/*.sql | wc -l` and `grep -c 'pgTable(' src/shared/lib/db/schema.ts`
  rather than trusting this line). pgvector extension enabled (`builder_embeddings.embedding`, HNSW
  index). Multi-tenant: Better Auth Organizations, tenant-scoped RLS on every private table,
  non-owner runtime/auth/worker/platform database roles
  (`DATABASE_URL`/`DATABASE_AUTH_URL`/`DATABASE_WORKER_URL`/`DATABASE_PLATFORM_URL`), and a
  migration-mode gate (`TENANT_READ_MODE`/`TENANT_WRITE_MODE`/`TENANT_CANONICAL_READY`) — see
  `security-and-multitenancy` (17/19 tasks done; the remaining 2 are the canonical-cutover and
  legacy-schema-contraction tasks, correctly blocked on a real production observation window).
- **Cache/rate-limit**: Redis, optional (`src/shared/lib/redis.ts`, `REDIS_URL` read directly
  from `process.env`, not part of the validated `env` schema), used for search-result caching
  (`src/lib/search.ts`) and rate limiting (`src/shared/lib/rate-limit.ts`). In-memory fallbacks
  exist when unset.
- **Auth**: better-auth, email/password only (no OAuth providers) — but WITH the Organizations
  plugin: every session has an `activeOrganizationId`, every account gets a personal
  organization on sign-up (self-healing on first request if the bootstrap hook raced —
  see `better-auth.ts`'s `session.create.before` hook), and `requireTenantPrincipal` /
  `TenantPrincipal { userId, organizationId, role, requestId }` is the only sanctioned way a
  route resolves tenant scope (`src/shared/lib/auth/tenant-principal.ts`). Organization roles
  are `owner | admin | member` (`src/shared/lib/authorization/permissions.ts`'s `can()`).
  Platform admins are a SEPARATE, non-organizational allow-list (`ADMIN_USER_IDS` env, read
  directly from `process.env`, not the org role system — `src/shared/lib/auth/platform-admin.ts`).
- **Email**: Resend (`src/shared/lib/email.ts`), optional key; logs a dev-mode link instead of
  sending when `RESEND_API_KEY` is unset.
- **AI**: MiniMax M3 for server-side chat completions (`MINIMAX_API_KEY`, optional — server AI
  tasks 503 without it; Chrome on-device AI still works), a separate OpenAI-compatible
  embeddings endpoint (`AI_EMBEDDING_*`, never MiniMax — see `plans/_meta/ai-policy.md`), a
  versioned task registry (`src/shared/lib/ai/tasks.ts`, called via `ai(taskId, input)`), tenant-
  scoped budget/cache (`src/shared/lib/ai/budget.ts`, `ai/cache.ts`), and a kill switch
  (`AI_DISABLED`/`AI_DISABLED_TASKS`). Plan: `ai-expansion`, `complete`.
- **Validation**: zod everywhere; `src/shared/lib/env.ts` is the canonical env schema (fails
  closed on production misconfiguration, and — for Stripe billing specifically — on
  misconfiguration in every environment, not just production).
- **Tests**: vitest. **Tests are NOT co-located.** As of 2026-07-27 there are zero `*.test.ts`
  files under `src/`, and `vitest.config.ts` includes ONLY `tests/unit/**/*.{test,spec}.{ts,tsx}`.
  The tree is `tests/{unit,e2e,regression}`, with `tests/unit` mirroring `src/` path-for-path:
  `src/lib/score.ts` → `tests/unit/lib/score.test.ts`;
  `src/shared/lib/ai/tasks.ts` → `tests/unit/shared/lib/ai/tasks.test.ts`.
  Playwright specs live in `tests/e2e/*.spec.ts` (23 files); `tests/regression` holds the
  standalone `.mjs` harnesses (`pnpm test:a11y`). 258 unit test files.
  **This bullet previously said "pure-logic modules in `src/shared/lib/*.ts` have sibling
  `*.test.ts`", and that instruction is why plans across the backlog specify test paths vitest
  will never run** — a test written at the old path passes by not existing. If you are executing
  a plan written before 2026-07-27, translate its test paths before you create the file.
  Earlier on 2026-07-24 the suite had one failure — the migration-integrity check, because
  `drizzle/meta/0045_snapshot.json` was missing while `_journal.json` had 46 entries. It was
  fixed within the hour; every migration has a matching snapshot. Two things are worth
  keeping from that episode: grants-only migrations DO get a snapshot (`0044_snapshot.json`
  exists), so omitting one is a bug rather than a convention; and migration release gate 1 in
  `security-policy.md` ("migration files and Drizzle journal/snapshots agree") is enforced by
  a real test, so re-run it after hand-editing anything under `drizzle/meta/`.
  `scripts/db/verify-api-isolation-local.mjs`
  (`pnpm test:api-isolation:local`) exercises real route handlers against a disposable Postgres
  connected as the exact non-owner runtime roles — 86/86 checks as of 2026-07-23.
- **Deploy**: Docker (root `Dockerfile`, `server.prod.mjs`), Coolify on a Hetzner VPS.
  Push-to-deploy via Coolify API. `docker-compose.yml` for local Postgres (pgvector image
  required — a plain `postgres` image breaks migration `0013`'s `CREATE EXTENSION vector`)
  and Redis.
- **Package manager**: pnpm.

## Architecture conventions

- `src/lib/` — search domain: `search.ts` (federated orchestrator), `dedup.ts`, `score.ts`,
  `sources/*.ts` (one file per external source, all return `RawBuilder` from `sources/types.ts`),
  `semantic/` (embedding doc-building + write-through indexing), `discovery/` (proactive
  discovery worker), `sprints/` (AI sourcing sprints service + worker), `enrichment/` (stealth-
  scraping connector registry).
- `src/shared/lib/` — pure/shared logic, organized by domain:
  - `auth/` — better-auth config, tenant principal resolution, platform-admin, organization
    lifecycle (invitations, ownership transfer, deletion), personal-organization bootstrap.
  - `authorization/` — `permissions.ts`'s `can()`, the single source of role-based authorization
    (a boundary test forbids inline `.role === 'x'` comparisons outside an allowlist).
  - `organizations/` — `contracts.ts`, the ONLY surface non-foundation code may import from the
    security/team foundation (DTOs, never raw ORM rows or schema tables).
  - `repositories/` — tenant-scoped data access; every private-table query goes through
    `withTenantContext` (sets `app.organization_id`/`app.user_id` for RLS) or an explicit
    `authDb`/`workerDb`/`platformDb` connection for the narrow cases that need a different role.
  - `billing/` — the NEW Stripe billing platform module (catalog, provider contract + fake,
    Stripe client) — separate from the legacy `billing.ts`/`billing-shared.ts` (still serves
    existing manually-billed organizations).
  - `db/` — schema, per-role clients (`client.ts` = runtime/app role, `auth-db.ts`, `worker-db.ts`),
    `tenant-context.ts` (the `withTenantContext` RLS-scoping helper).
  - `ai/` — task registry, budget, cache, MiniMax/embedding clients.
  - Feature-pure modules: outreach, code-style, hygiene, onboarding, legal, tracked-builders,
    each ideally with a sibling `*.test.ts`.
- `src/modules/<feature>/components/` — feature UI (auth, builder-profile, dashboard, landing,
  search, admin, billing).
- `src/shared/components/` — cross-feature UI (e.g. `HygieneCard.tsx`, `TenantQueryProvider.tsx`
  for organization-scoped React Query cache invalidation).
- Routes: `_landing/*` public marketing, `_dashboard/*` authed app (org-scoped), `api/*` JSON
  endpoints, `api/admin/*` platform-admin-only.
- `server/security.mjs` — **outside `src/` on purpose**. It is the single implementation of the
  security headers and the CSRF mutation-origin gate, imported directly by the production
  entrypoint `server.prod.mjs`. It lives in plain ESM because the runtime Docker stage copies
  `server.prod.mjs` and `server/` but NOT `src/`, so a TypeScript module could not be imported
  there. Tests: `test/security/http-security.test.ts`; types: `server/security.d.mts`. Enforcement
  is at the wrapper because it must also cover paths the app handler never sees (static assets,
  the 403 itself, and the 500 emitted when `app.fetch` throws). A parallel copy previously lived
  at `src/shared/lib/security/headers.ts`, tested but imported by nothing while the shipped
  enforcement was an untested inline duplicate; that copy was deleted 2026-07-24. **Do not
  reintroduce a second copy** — a stricter per-route CSP means a named variant export there.

## Database tables (schema.ts, 68 tables, all EXISTING — verified 2026-07-24)

**Auth/organizations** (better-auth + organization lifecycle): `auth_users`, `auth_sessions`,
`auth_accounts`, `auth_verifications`, `organizations`, `organization_members`,
`organization_invitations`, `organization_deletion_requests`.

**Builder identity** (global public identity vs. tenant-private tracking, split from the
legacy per-user model): `builder_identities` (global, unique `(source, sourceId)`),
`builder_source_snapshots` (versioned raw snapshots), `organization_builders` (tenant-private
tracking + private metadata, unique `(organizationId, builderIdentityId)`), `builder_claims`,
`published_builder_profiles`, `builder_claim_requests`, `builder_profile_views`.

**Legacy per-user cache** (still exists for migration evidence; NOT the live tracking path —
`organization_builders` is): `builders` (per-user, `userId` NOT NULL, dual-written alongside
`organization_builders` by `trackOrganizationBuilder`).

**Tenant-private, org-scoped, and LIVE** (previously misfiled above as "legacy per-user"):
`saved_queries`, `alerts`, `alert_triggers`, `builder_notes`. All four carry `organization_id`
(`NOT NULL` since `drizzle/0081_wakeful_butterfly.sql`) and have RLS enabled + FORCED
(`drizzle/0008_tenant_rls.sql`).
`builder_notes` specifically is the live tenant notes path via `listOrganizationBuilderNotes`
in `src/shared/lib/repositories/organization-builders.ts`, with a composite tenant FK
`builder_notes_organization_builder_fk`. **Caveat that matters for new work**: its
`builder_id` still references the legacy `builders` table's id space, not
`organization_builders` — so notes are org-scoped but not yet re-keyed onto the canonical
tracking table.

**Known dead-ish surfaces** (exist in schema, effectively unused at runtime — check before
building on them): `builder_source_snapshots` has **no runtime writer** (its only writer is
the one-shot backfill `scripts/db/backfills/builders.ts`) and no `builderhunt_app` grant;
`organization_plan_changes` has no writer. `builder_identities.first_seen_at` is written only
by `trackOrganizationBuilder`, so it measures *when a tenant tracked someone*, not when the
person was first observed — it is not a market time series.

**Onboarding**: `onboarding_progress`, `onboarding_selected_builders`.

**Public/trust**: `incidents`, `changelog`, `roadmap_items`, `roadmap_votes`.

**Privacy/legal**: `user_consents`, `data_export_requests`, `deletion_requests`.

**Billing (legacy, per-user, still live for existing manual customers)**: `plans` (PK =
`user_id`), `plan_changes`, `plan_requests`.

**Billing (canonical, per-organization)**: `organization_entitlements`, `organization_plan_changes`
(schema exists but is currently dead code — nothing writes to it yet).

**Billing (Stripe platform, 19 tables — ALL EXIST)**: `billing_customers`,
`billing_subscriptions`, `billing_checkout_attempts`, `billing_credit_grants`,
`billing_credit_reservations`, `billing_credit_allocations`, `billing_ledger_entries`,
`billing_auto_recharge_rules`, `billing_refunds`, `billing_disputes`, `billing_risk_events`,
`billing_risk_exceptions`, `billing_webhook_events`, `billing_reconciliation_runs`,
`billing_provider_usage`, `billing_notification_log`, `billing_contacts`,
`billing_terms_acceptances`, `billing_seller_profiles`.

**Abuse and usage integrity** (plan `abuse-and-usage-integrity`, header still says `pending` but
17/33 tasks are done — treat it as partially-implemented): `abuse_signals`, `account_risk`,
`session_signals`, `user_devices`, `seat_usage_daily`. Logic in `src/shared/lib/abuse/`
(anomalies, anti-automation, device, email-hygiene, linked-accounts, risk, session-guard,
signals — all with sibling tests). The decayed combined-signal risk score in
`src/shared/lib/abuse/risk.ts` is the reusable scoring/decay precedent for any new scoring
feature.

**Organization deletion**: `organization_deletion_financial_records` (in addition to
`organization_deletion_requests`).

**Migration tooling** (owner-role only, never touched by the app runtime): `migration_backfill_runs`,
`migration_backfill_conflicts`.

**Semantic search / AI**: `builder_embeddings` (global, pgvector HNSW index, written via
`publicDb`/app role), `discovery_state` (proactive-discovery worker cursor, singleton row).

**AI sourcing sprints**: `sourcing_sprints`, `sprint_results`.

**Public profile enrichment (stealth-scraping)**: `enrichment_jobs`, `enrichment_evidence`,
`builder_processing_restrictions` (platform-only, no organization_id — subject-restriction
records referenced across every organization's evidence for an identity).

**IMPORTANT**: `builders` (legacy) is still per-user (`userId` NOT NULL) — but it is no longer
the canonical tracking store. `organization_builders` is. New features should read/write
`organization_builders` under `withTenantContext`, not `builders`.

**Security reality**: RLS is enabled and FORCED on every tenant-private table, with explicit
per-role (`builderhunt_app`/`builderhunt_worker`/`builderhunt_platform`/`builderhunt_auth`)
policies — verified against the exact non-owner roles via `pnpm test:rls:local` and
`pnpm test:api-isolation:local` (86/86 as of 2026-07-23). `organization_id` is `NOT NULL` on all
seven tenant-private tables since `drizzle/0081_wakeful_butterfly.sql`; the read path is a
separate switch and still defaults to `legacy` — see constraint 1 below. Five real,
previously-undiscovered permission/logic bugs were found and fixed this way in the 2026-07-23
session alone (see `01-security-and-multitenancy/tasks.md` task 15's progress notes) — a
reasonable prior for treating any *newly-exercised* code path as suspect until proven
against the real roles, not just the DB owner.

## Implemented features (DO NOT re-plan as new; plans should mark these done)

- **Federated search** across 12 sources: github, hn, devto, reddit, lobsters, stackoverflow,
  npm, huggingface, gitlab, codeberg, hashnode, sourcehut (`src/lib/sources/`). Memory+Redis
  cached, deduped, scored. UI: `_dashboard/search` with `PersonResultCard`.
- **Semantic search** (plan: `semantic-search`, `complete`): global `builder_embeddings` table
  (pgvector), write-through indexing from every search/track request
  (`src/lib/semantic/index-writer.ts`), `/api/search/semantic`, degrades to keyword search on
  any embedding/provider failure.
- **Proactive discovery worker** (plan: `proactive-discovery`, `implemented`): background
  discovery matrix (`src/lib/discovery/`), admin-triggered like the alerts worker
  (`/api/admin/discovery/run-worker`), seeds the semantic index cold-start.
- **AI sourcing sprints** (plan: `ai-sourcing-sprints`, `implemented`): organization-scoped saved
  query variants re-executed by a background worker until a result quota
  (`src/lib/sprints/`, `sourcing_sprints`/`sprint_results` tables), tier-gated (free: 0, pro: 3,
  team: 10 concurrent active sprints), `/sprints` dashboard pages.
- **AI profile enrichment** (plan: `ai-profile-enrichment`, `partially-implemented`, phases 1/2/4
  shipped, phase 3 deferred): `GET/POST /api/builders/$builderId/enrichment` — writes to
  `organization_builders.privateMetadata.aiEnrichment` (adapted from the original per-user
  `builders.metadata` target once the identity split landed), gated on entitlement + AI budget.
- **Outreach v1 + v2 AI upgrade** (plan: `outreach-generator`, `complete`): v1 rule-based
  generator (`src/shared/lib/outreach.ts`, 3 tones, frozen fallback rung) PLUS an AI-upgraded
  rung on top via the `ai-expansion` task registry. UI:
  `src/modules/builder-profile/components/OutreachCopilot.tsx`.
- **Teams/organizations** (plans: `security-and-multitenancy` 17/19, `team-accounts` 9/9 done):
  Better Auth Organizations, invite/accept/decline, role management (owner/admin/member),
  ownership transfer, seat limits (`organization_entitlements.seat_limit`, accepted members +
  usable invitations count against it), organization deletion (grace period + immediate paths),
  `/settings/team` UI, `OrganizationSwitcher`. **This is fully implemented** — do not re-plan.
- **Multi-tenant security foundation** (plan: `security-and-multitenancy`, `in_progress`,
  17/19): RLS on every tenant table, non-owner runtime/auth/worker/platform DB roles, tenant
  principal resolution, centralized `can()` authorization, builder identity split (global vs.
  tenant tracking), organization entitlements, resumable backfills, dual-write/shadow-compare
  infrastructure, platform-admin auth, HTTP/secrets/AI tenant boundary hardening. Remaining:
  canonical-reads cutover and legacy-schema contraction, both correctly blocked pending a real
  production observation window.
- **Builder tracking** (track/untrack from search, `/api/builders/track`, `/api/me/builders`,
  `tracked-builders.ts`), notes per builder, recent builders, recommendations endpoint — now
  organization-scoped via `organization_builders`, dual-written to legacy `builders` during the
  migration window.
- **Exports**: `/exports` page + `/api/export/builders` (CSV of an organization's tracked
  builders).
- **Smart alerts v1**: `alerts` + `alert_triggers` tables, worker (`src/lib/alerts/worker.ts`),
  admin run-worker endpoint, `/alerts` dashboard page, test-trigger endpoint. Email via Resend.
- **RSS feeds**: public per-saved-search feed `/api/feeds/$searchId.xml`, rate limited.
- **Claimable profiles**: claim request + verify endpoints (subject-scoped, not org-scoped —
  a verified claim belongs to the claiming user, `builder_claims.subjectUserId`), gist/bio
  verification, published profile with claimed topics/open-to-status/bio
  (`published_builder_profiles`), evidence-provenance and processing-restriction (subject
  rights) endpoints under `/api/me/builder/$builderId/*`.
- **Public profile enrichment / stealth-scraping** (plan: `claimable-profiles` +
  its own enrichment tasks, `partially-implemented`): connector-based evidence collection
  (`enrichment_jobs`/`enrichment_evidence`), review workflow, subject-initiated processing
  restriction with cross-organization cascade.
- **Onboarding**: `onboarding_progress`, `onboarding_selected_builders` (source-opaque
  `builderRef`, no FK — onboarding picks are frequently never tracked), status/complete/skip
  endpoints, `/onboarding` routes.
- **Billing v1 (manual, no Stripe)**: `plans` table (legacy, per-user, migration-evidence only,
  still serves existing customers), `organization_entitlements` (canonical, per-org),
  `PLAN_LIMITS`/`PLAN_PRICING` in `billing-shared.ts` (free/pro/team: $0/$19/$99 — the LEGACY
  price, deliberately not matching the new Stripe catalog's $199 Team price yet; existing
  subscribers keep their contracted price until migration), limit enforcement (`billing.ts`,
  `repositories/entitlements.ts`), plan-change requests + admin approval (`plan_requests`,
  admin UI).
- **Stripe billing platform** (plan: `stripe-billing-platform`, `in_progress`, ~29/40 sections
  done, 49/51 task checkboxes): **this is now a large, largely-built subsystem** —
  `src/shared/lib/billing/` holds ~60 modules, each with a sibling test, including
  `catalog.ts` (immutable catalog incl. Pro Max), `rate-cards.ts`, `feature-authorization.ts`,
  `credits.ts` / `reservations.ts` (the credit ledger), `checkout.ts`, `portal.ts`,
  `refunds.ts`, `disputes.ts`, `dunning.ts`, `auto-recharge.ts`, `annual-grants.ts`,
  `reconciliation.ts`, `accounting-export.ts`, `notifications.ts`, `risk.ts`,
  `legacy-migration.ts`, `price-migrations.ts`, `webhook-inbox.ts`, plus `provider.ts`, a
  `real-provider.ts`, a deterministic `fake-provider.ts` and a shared
  `provider-contract-suite.ts`. Routes exist: `src/routes/api/webhooks/stripe.ts` (signature
  verification + inbox), `src/routes/api/billing/*` (checkout, portal, subscription,
  auto-recharge, refunds, disputes, contact, summary), `src/routes/api/admin/billing/*`
  (reconcile, refunds, disputes, risk-exceptions, metrics, accounting-export, configuration,
  events, `run-worker`), and admin pages `_dashboard/admin/{billing,refunds,disputes}.tsx`.
  Payload encryption at rest exists (`src/shared/lib/crypto/webhook-payload.ts`, AES-256-GCM
  keyed on `WEBHOOK_PAYLOAD_ENCRYPTION_KEY`).
  **What is still genuinely absent is operational, not code**: `STRIPE_BILLING_ENABLED`
  defaults to `false` and is false everywhere, no Stripe account/Products/Prices exist, and
  every gate in `docs/operations/stripe-launch-register.md` is `_pending_`. Consequence for
  plans: no organization has a `billing_subscriptions` row, so a feature gated on a
  subscription ships dark. Supersedes `pricing-and-billing` (superseded).

  **Two gating surfaces are live and a plan must pick deliberately**: (a) the *entitlement*
  path — `organization_entitlements` + `resolveLegacyPlanTier` + `PLAN_LIMITS`, admin-granted,
  works today with Stripe off, correct for boolean/numeric capability gates (this is what the
  shipped sprints gate uses); (b) the *credit* path — a rate-card entry +
  `feature-authorization.ts` + `billing_credit_*`, correct when the feature has a real
  per-request marginal cost (LLM tokens, third-party API calls) that must be metered.
- **Legal & privacy**: `/legal/*` pages, consent API, data export requests, account deletion
  (org-aware: blocks a sole owner of a multi-member organization from deleting their account
  until ownership transfers; personal-org-only owners are never blocked).
- **Status & trust**: `/status` page, incidents (+admin), health endpoint, metrics (admin).
- **Changelog + roadmap**: public pages, votes, admin CRUD.
- **Landing/marketing**: redesigned landing + full dark/light theme across every public page
  (plan: `public-landing-pages`), `/pricing`, `/explore`, `/blog` (file-based posts in
  `content/posts/`, `blog.ts`), OG image endpoint, sitemap/robots.
- **Dashboard redesign**: dark/glass theme, motion, shadcn/ui primitive migration, consolidated
  user menu (account/team/billing/privacy/status/admin moved out of the topbar), consistent
  page-width shell across every `_dashboard/*` route.
- **Admin panel**: users, metrics, incidents, changelog, roadmap, plan-requests — all behind
  the platform-admin allow-list, centralized auth (`requirePlatformAdminPrincipal`), redacted
  audit trail on every mutation.
- **Code-style fingerprinting v1 (heuristic, NO LLM)**: `src/shared/lib/code-style.ts` —
  per-language heuristic vectors, stored per builder.
- **Project hygiene v1 (heuristic)**: `src/shared/lib/hygiene.ts` + `HygieneCard.tsx`.
- **Abuse and usage integrity** (plan: `abuse-and-usage-integrity`, header says `pending` but
  17/33 tasks are done — the header is stale): device-keyed sign-up rate limiting, disposable-domain
  blocking + plus-address normalization, linked-account clustering, impossible-travel / UA-change /
  seat-overuse anomaly detectors, a decayed combined-signal account risk score, session concurrency
  and idle/absolute timeout guards, per-seat daily quotas. Code in `src/shared/lib/abuse/*`,
  `src/shared/lib/repositories/{account-risk,abuse-signals,user-devices,seat-usage}.ts`,
  migrations `drizzle/0043`–`0045`. `ABUSE_ENFORCEMENT_MODE` defaults to `observe`, so detection
  is live but enforcement is not.

## NOT implemented (zero or near-zero code)

- Sources: bluesky, devpost, producthunt, indiehackers (plans exist, all `pending`/`blocked`).
- Sharing/activity feed (plan: `activity-feed`, `blocked` — depends on `shared-resources`).
- Shared searches/builder lists across an organization (plan: `shared-resources`, `blocked`).
- Team synergy analysis, portfolio builder, unified timeline, work-sample analysis / technical
  sandbox (plans: `team-synergy`, `portfolio-builder`, `unified-timeline`, `work-sample` — all
  `pending`).
- Calendar/scheduling/interview intelligence (plan: `calendar-scheduling-interview-intelligence`,
  `pending` — depends on `stripe-billing-platform`).
- Waitlist/launch gating (plan: `waitlist-launch`, `pending`).
- Solutions intelligence (plan: `solutions-intelligence`, `pending` — newly added, no
  implementation yet).
- **Everything in `plans/fase-2/`** (added 2026-07-24, all 10 `pending`, zero code):
  `hiring-pipeline-kanban`, `match-evidence-panel`, `saved-search-health`,
  `jd-to-candidates-matching`, `collaboration-graph`, `look-alike-sourcing`,
  `availability-signals`, `browser-extension-overlay`, `ats-integrations`,
  `talent-market-intelligence`. These live one directory deeper than the other plans, so their
  cross-plan links use `../../<plan>/` for phase-1 plans and `../<plan>/` for siblings.
- **Live** Stripe payment processing of any kind — `STRIPE_BILLING_ENABLED` is `false`
  everywhere; no Stripe account, Products, or Prices exist; no organization has a
  `billing_subscriptions` row. The *code* for Checkout, webhooks, Customer Portal, the credit
  ledger, refunds/disputes and reconciliation all exists — see "Stripe billing platform" above.
  Do not repeat the older claim that it does not.

## Env vars (env.ts today)

Required: `DATABASE_URL`, `APP_URL`, `VITE_APP_URL`, `BETTER_AUTH_SECRET`.

Database roles (optional, fall back to `DATABASE_URL` when unset — the role-separation cutover
in production is a deliberate, sign-off-gated step): `DATABASE_MIGRATION_URL`,
`DATABASE_AUTH_URL`, `DATABASE_WORKER_URL`, `DATABASE_PLATFORM_URL`.

Tenant migration gates: `TENANT_READ_MODE` (`legacy|shadow|canonical`), `TENANT_WRITE_MODE`
(`legacy|dual|canonical`), `TENANT_CANONICAL_READY` (`true|false`) — all default to the
most conservative legacy value.

Source tokens (optional): `GITHUB_TOKEN`, `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET`,
`STACKOVERFLOW_API_KEY`, `HUGGINGFACE_TOKEN`, `GITLAB_TOKEN`, `CODEBERG_API_URL`/
`CODEBERG_TOKEN`, `HASHNODE_API_KEY`, `SOURCEHUT_TOKEN`, `HACKERNEWS_API_URL`, `DEVTO_API_URL`.

Email (optional): `RESEND_API_KEY`.

AI (`ai-expansion`): `MINIMAX_API_KEY` (optional — server AI 503s without it),
`MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `AI_EMBEDDING_URL`/`AI_EMBEDDING_MODEL`/
`AI_EMBEDDING_API_KEY`/`AI_EMBEDDING_DIM`/`AI_EMBEDDING_TIMEOUT_MS`, `AI_DISABLED`,
`AI_DISABLED_TASKS`.

Proactive discovery: `DISCOVERY_CELLS_PER_RUN`, `DISCOVERY_DAILY_STUB_CAP`.

Public profile enrichment (disabled by default — see
`docs/operations/public-enrichment-source-register.md` before enabling anywhere):
`ENRICHMENT_ENABLED`, `ENRICHMENT_ALLOWED_CONNECTORS`, `ENRICHMENT_BATCH_SIZE`,
`ENRICHMENT_MAX_ATTEMPTS`, `ENRICHMENT_LEASE_SECONDS`, `ENRICHMENT_RAW_RETENTION_DAYS`,
`ENRICHMENT_ACCEPTED_RETENTION_DAYS`, `ENRICHMENT_USER_AGENT`.

Stripe billing (disabled by default — see `docs/operations/stripe-launch-register.md` before
enabling anywhere; fails closed in every environment, not just production, if enabled without
a fully valid configuration): `STRIPE_BILLING_ENABLED`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET_PREVIOUS` (webhook-secret rotation window),
`STRIPE_API_VERSION`, `WEBHOOK_PAYLOAD_ENCRYPTION_KEY` (64 hex chars / 32 bytes; **required**
when `STRIPE_BILLING_ENABLED=true`).

Cron authentication: `CRON_SECRET` (optional; `src/shared/lib/auth/cron.ts`).

Abuse and usage integrity (`abuse-and-usage-integrity`): `ABUSE_ENFORCEMENT_MODE`
(`observe|warn|enforce`, defaults `observe`), `ABUSE_ALLOWLIST_ASNS`,
`ABUSE_CROSS_TENANT_DENIAL_THRESHOLD`, `ABUSE_CROSS_TENANT_DENIAL_WINDOW_MINUTES`,
`SIGNUP_BLOCK_DISPOSABLE_EMAILS`, `SIGNUP_DEVICE_DAILY_LIMIT`, `SIGNUP_REQUIRE_VERIFIED_EMAIL`.

Session limits: `SESSION_IDLE_TIMEOUT_MINUTES`, `SESSION_ABSOLUTE_TIMEOUT_HOURS`,
`SESSION_MAX_CONCURRENT_FREE`, `SESSION_MAX_CONCURRENT_PRO`,
`SESSION_MAX_CONCURRENT_TEAM_PER_SEAT`.

Per-seat daily quotas: `SEAT_DAILY_SEARCHES`, `SEAT_DAILY_EXPORTS`, `SEAT_DAILY_MESSAGES`,
`SEAT_DAILY_REVEALS`.

`env.ts` declares **73 variables** as of 2026-07-24; the lists above are grouped, not exhaustive —
read `src/shared/lib/env.ts` when a plan adds one.

Read directly from `process.env`, NOT part of the validated `env` schema: `ADMIN_USER_IDS`
(platform-admin allow-list), `REDIS_URL` (optional; in-memory fallback when unset).

## Known structural constraints every plan must respect

1. `organization_id` is `NOT NULL` on all seven tenant-private tables — `alert_triggers`,
   `alerts`, `builder_notes`, `builders`, `onboarding_progress`, `onboarding_selected_builders`,
   `saved_queries` — since `drizzle/0081_wakeful_butterfly.sql`, which adopted leftover rows
   itself so a forgotten backfill could not take a release down. The schema half of the canonical
   cutover is DONE; only the legacy-column contraction remains open.
   **But the read path is a separate switch and is still legacy**: `TENANT_READ_MODE` defaults to
   `legacy` and `TENANT_CANONICAL_READY` to `false` (`src/shared/lib/env.ts:36-38`,
   `.env.example:33-34`), and `canonical` additionally requires `TENANT_CANONICAL_READY=true`
   (`resolveTenantReadMode` in `src/shared/lib/migration/tenant-flags.ts`). So a column being
   `NOT NULL` does not mean reads resolve canonically. Do not assume canonical read mode is live.
   (Updated 2026-07-27. The earlier text here said `organization_id` was "nullable, pending the
   canonical cutover" and that the cutover was blocked on a 24h zero-mismatch production window.
   Both are obsolete: the cutover shipped, and that readiness gate was itself removed because it
   could never be satisfied. Every plan written before this date inherited the stale hedge.)
2. `builders` (legacy, per-user) still exists and is still dual-written by
   `trackOrganizationBuilder` — but `organization_builders` (tenant-private, keyed by
   `(organizationId, builderIdentityId)`) is the canonical tracking store. New features read/
   write `organization_builders` under `withTenantContext`, never `builders` directly.
3. No background job runner exists. All **ten** workers run via an admin-triggered HTTP endpoint
   under `/api/admin/*/run-worker`, designed to be hit by an external cron (Coolify/VPS cron):
   `alerts.evaluate`, `sprints.execute`, `enrichment.refresh`, `discovery.crawl`,
   `embeddings.backfill`, `legal.retention`, `billing.reconcile`,
   `calendar.recurrence-materialization`, `calendar.reminder-delivery`, `status.snapshot`.
   Cron authentication is a shared helper (`CRON_SECRET`, `src/shared/lib/auth/cron.ts`).
   **Cadence is no longer a doc-comment**: workers are registered in `OPERATIONAL_SCHEDULES`
   (`src/shared/lib/operational-schedules.ts`) and wrapped in `withJobRun({ jobKey })`, which
   writes one `job_runs` row per run. `jobKey` is globally unique — two plans claiming the same
   key collide. New background work follows this pattern and registers itself; it does NOT
   invent a queue system.
   (Updated 2026-07-27: was "seven workers" listing only the first seven.)
4. Search results are ephemeral (cache TTL) — anything needing durable profiles must write
   through to `organization_builders`/`builder_identities` or a new global table.
5. The legacy manual billing system (`plans`, `plan_requests`) and the canonical
   `organization_entitlements` system currently diverge only by admin action
   (`setPlatformUserPlan` syncs both via a SECURITY DEFINER function). `stripe-billing-platform`
   is a THIRD, still-separate catalog/pricing system (Pro Max, $199 Team) that has not migrated
   any real organization yet — do not assume Stripe webhooks, Checkout, or credit balances exist
   anywhere in the runtime.
6. `organization_builders.creator_user_id` and `sourcing_sprints.creator_user_id` both
   `onDelete: 'restrict'` from `auth_users` — a hard-deleted user's creator reference is
   reassigned to a permanent sentinel row (`system-deleted-user`,
   `drizzle/0026_deleted_user_sentinel.sql`), never deleted outright, since these are
   organization-owned resources.
7. Any table/column a route or worker queries for the first time against the REAL non-owner
   runtime role (not the DB owner) should be treated as suspect until proven — five real
   permission/logic bugs (missing grants on `sourcing_sprints`/`builder_embeddings`/
   `discovery_state`, an RLS-silent-no-op in account hard-deletion, a raw-`execute()`
   Date-vs-string bug) were found this way in one session by extending
   `scripts/db/verify-api-isolation-local.mjs`, none of them caught by code review or the
   existing (owner-role-only) test suite.
8. **Several `RawBuilder` fields are synthesized by the source adapters, not fetched.** Any plan
   that presents source data as measured evidence must check the adapter first. Verified
   examples as of 2026-07-24: `stackoverflow.ts` sets `bio` to `"NN% accept rate"` and
   `metadata.lastSeen` to `Date.now()` (so every Stack Overflow result harvests full recency
   credit); `npm.ts` sets `bio` to `"Maintains <pkg> on npm"` and `followersCount` to
   `maxScore * 100000` (a 0–1 quality score rendered as a follower count); `hn.ts` sets
   `topics` to the query keywords (making any "matches your topic" claim circular) and `bio` to
   `Posted: "<title>"`; `lobsters.ts` has no `bio` at all; GitHub *repository* results use
   `repo.description` as the `bio`, and `bio` is declared on `GitHubSearchUser` but is not part
   of what `/search/users` returns. This is the same class of defect `project-hygiene` exists to
   fix, and it is not fully fixed. Treat `bio`, `followersCount`, `topics` and
   `metadata.lastSeen` as per-source-provenance fields, never as uniform measured facts.
9. Platform-admin authority (`ADMIN_USER_IDS`) is completely separate from organization roles —
   an organization owner has zero platform-admin capability, and vice versa. Never conflate the
   two, and never gate a platform-admin route on an organization role check.
