# App Reality — Ground Truth (2026-07-23)

This document is the single source of truth about what is ACTUALLY implemented in
BuilderHunt today. Every plan in `plans/` must be written against this reality, not
against what older specs (or older versions of this document) imagined. If a plan
contradicts this document, the plan is wrong.

> **2026-07-23 rewrite note**: the previous version of this file (dated 2026-07-19) was
> significantly stale — written before `security-and-multitenancy` shipped Better Auth
> Organizations/RLS/tenant roles, before `team-accounts` completed, and before
> `semantic-search`/`ai-sourcing-sprints`/`proactive-discovery`/`ai-expansion` all landed.
> It still described a single-tenant, per-user, no-AI app. Every claim below was
> re-verified against the current codebase (`schema.ts`, `env.ts`, `plans/*/tasks.md`
> status headers) rather than carried forward from the old text.

## Stack

- **Framework**: TanStack Start (React 19, file-based routes in `src/routes/`, API routes
  as server route files under `src/routes/api/`). Router tree generated in `src/routeTree.gen.ts`.
- **DB**: PostgreSQL via Drizzle ORM (`src/shared/lib/db/schema.ts`, 27 migrations in
  `drizzle/`, 43 tables). pgvector extension enabled (`builder_embeddings.embedding`, HNSW
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
- **Tests**: vitest; pure-logic modules in `src/shared/lib/*.ts` have sibling `*.test.ts`.
  719 tests across 90 files (`pnpm test`, 2026-07-23). `scripts/db/verify-api-isolation-local.mjs`
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

## Database tables (schema.ts, 43 tables, all EXISTING)

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
`organization_builders` by `trackOrganizationBuilder`), `saved_queries`, `alerts`,
`alert_triggers`, `builder_notes`.

**Onboarding**: `onboarding_progress`, `onboarding_selected_builders`.

**Public/trust**: `incidents`, `changelog`, `roadmap_items`, `roadmap_votes`.

**Privacy/legal**: `user_consents`, `data_export_requests`, `deletion_requests`.

**Billing (legacy, per-user, still live for existing manual customers)**: `plans` (PK =
`user_id`), `plan_changes`, `plan_requests`.

**Billing (canonical, per-organization)**: `organization_entitlements`, `organization_plan_changes`
(schema exists but is currently dead code — nothing writes to it yet).

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
`pnpm test:api-isolation:local` (86/86 as of 2026-07-23). `organization_id` is still nullable on
most tenant tables pending the canonical cutover (task 17/18 of `security-and-multitenancy`,
blocked on a real 24h zero-mismatch production observation window). Five real,
previously-undiscovered permission/logic bugs were found and fixed this way in the 2026-07-23
session alone (see `security-and-multitenancy/tasks.md` task 15's progress notes) — a
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
- **Stripe billing platform** (plan: `stripe-billing-platform`, `in_progress`, 4/~40 tasks):
  dependency contracts pinned, launch decision register (`docs/operations/stripe-launch-register.md`,
  every gate `_pending_` — no Stripe account exists yet), Stripe SDK pinned + lazy fail-closed
  client (`src/shared/lib/billing/stripe-client.ts`), new immutable catalog with Pro Max added
  (`src/shared/lib/billing/catalog.ts` — separate from and NOT reconciled with the legacy
  `PLAN_PRICING` except where intentionally matching), deterministic fake billing provider for
  tests. **No Checkout, webhooks, credit ledger, or real payment processing exist yet.**
  Supersedes `pricing-and-billing` (superseded).
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
- Stripe Checkout, webhooks, Customer Portal, credit ledger, refunds/disputes, reconciliation —
  see "Stripe billing platform" above; only the dependency/catalog/fake-provider foundation
  exists.
- Live Stripe payment processing of any kind — `STRIPE_BILLING_ENABLED` is `false` everywhere;
  no Stripe account, Products, or Prices exist.

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
`STRIPE_WEBHOOK_SECRET`, `STRIPE_API_VERSION`.

Read directly from `process.env`, NOT part of the validated `env` schema: `ADMIN_USER_IDS`
(platform-admin allow-list), `REDIS_URL` (optional; in-memory fallback when unset).

## Known structural constraints every plan must respect

1. `organization_id` is nullable on most tenant tables and both tenant migration modes default
   to `legacy` in `.env.example` — canonical-mode cutover requires a real 24h zero-mismatch
   production observation window (`security-and-multitenancy` tasks 17/18, correctly blocked).
   Do not assume canonical mode is live.
2. `builders` (legacy, per-user) still exists and is still dual-written by
   `trackOrganizationBuilder` — but `organization_builders` (tenant-private, keyed by
   `(organizationId, builderIdentityId)`) is the canonical tracking store. New features read/
   write `organization_builders` under `withTenantContext`, never `builders` directly.
3. No background job runner exists. Every worker (alerts, discovery, sprints, embeddings,
   enrichment) runs via an admin-triggered HTTP endpoint under `/api/admin/*/run-worker`,
   designed to be hit by an external cron (Coolify/VPS cron or Stripe's future worker). New
   background work should follow this same pattern, NOT invent a queue system.
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
8. Platform-admin authority (`ADMIN_USER_IDS`) is completely separate from organization roles —
   an organization owner has zero platform-admin capability, and vice versa. Never conflate the
   two, and never gate a platform-admin route on an organization role check.
