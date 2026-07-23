# App Reality — Ground Truth (2026-07-19)

This document is the single source of truth about what is ACTUALLY implemented in
BuilderHunt today. Every plan in `plans/` must be written against this reality, not
against what older specs imagined. If a plan contradicts this document, the plan is wrong.

## Stack

- **Framework**: TanStack Start (React 19, file-based routes in `src/routes/`, API routes
  as server route files under `src/routes/api/`). Router tree generated in `src/routeTree.gen.ts`.
- **DB**: PostgreSQL via Drizzle ORM (`src/shared/lib/db/schema.ts`, migrations in `drizzle/`).
  Plain `pgTable` — **no pgvector, organizations, tenant key, RLS policy, or runtime/migration
  database-role separation exists yet**.
- **Cache/rate-limit**: Redis, optional (`src/shared/lib/redis.ts`), used for search-result
  caching (`src/lib/search.ts`) and rate limiting (`src/shared/lib/rate-limit.ts`).
  In-memory fallbacks exist when `REDIS_URL` is unset.
- **Auth**: better-auth, email/password only (`src/shared/lib/auth/`). Session cookie based.
  Admins via `ADMIN_USER_IDS` env.
- **Email**: Resend (`src/shared/lib/email.ts`), optional key.
- **Validation**: zod everywhere; `src/shared/lib/env.ts` is the canonical env schema.
- **Tests**: vitest; pure-logic modules in `src/shared/lib/*.ts` have sibling `*.test.ts`.
- **Deploy**: Docker (root `Dockerfile`, `server.prod.mjs`), Coolify on a Hetzner VPS.
  Push-to-deploy via Coolify API. `docker-compose.yml` for local Postgres/Redis.
- **Package manager**: pnpm.

## Architecture conventions

- `src/lib/` — search domain: `search.ts` (federated orchestrator), `dedup.ts`, `score.ts`,
  `sources/*.ts` (one file per external source, all return `RawBuilder` from `sources/types.ts`).
- `src/shared/lib/` — pure/shared logic (billing, alerts, outreach, code-style, hygiene,
  onboarding, legal, status, tracked-builders…), each ideally a pure function module with tests.
- `src/modules/<feature>/components/` — feature UI (auth, builder-profile, dashboard, landing, search).
- `src/shared/components/` — cross-feature UI (e.g. `HygieneCard.tsx`).
- Routes: `_landing/*` public marketing, `_dashboard/*` authed app, `api/*` JSON endpoints.

## Database tables (schema.ts, all EXISTING)

`auth_users`, `auth_sessions`, `auth_accounts`, `auth_verifications`,
`builders` (per-user cache of externally-found profiles; unique `(userId, source, sourceId)`;
`metadata` jsonb; claim fields: `isClaimed`, `claimedByUserId`, `isVerified`, `openToStatus`,
`claimedTopics`), `saved_queries`, `alerts`, `alert_triggers`, `builder_notes`,
`builder_claim_requests`, `builder_profile_views`, `onboarding_progress`, `incidents`,
`changelog`, `roadmap_items`, `roadmap_votes`, `user_consents`, `data_export_requests`,
`deletion_requests`, `plans` (PK = `user_id`, 1:1 user↔plan), `plan_changes`, `plan_requests`.

**IMPORTANT**: `builders` rows are per-user (userId NOT NULL) — it is a tracked/search cache,
NOT a global profile store. Plans that assume a global builders index must account for this
(dedup across users, or a new global table, or relaxing userId).

**Not in schema**: organizations/teams, activity events, embeddings/vectors, sourcing sprints,
portfolios, work samples, AI enrichment columns (would go in `builders.metadata` jsonb).

**Security reality**: private access relies on manually repeated `userId` predicates. The global
Drizzle client is importable everywhere; public builder handlers can serialize full ORM rows; local
database examples use the `postgres` owner. `drizzle-kit check` passes for the single initial
migration, but no tenant A/B, direct-SQL RLS, database-role, migration-rehearsal, or restore test
exists. `_meta/security-policy.md` defines the required replacement architecture.

## Implemented features (DO NOT re-plan as new; plans should mark these done)

- **Federated search** across 12 sources: github, hn, devto, reddit, lobsters, stackoverflow,
  npm, huggingface, gitlab, codeberg, hashnode, sourcehut (`src/lib/sources/`). Memory+Redis
  cached, deduped, scored. UI: `_dashboard/search` with `PersonResultCard`.
- **Builder tracking** (track/untrack from search, `/api/builders/track`, `/api/me/builders`,
  `tracked-builders.ts`), notes per builder, recent builders, recommendations endpoint.
- **Exports**: `/exports` page + `/api/export/builders` (CSV of tracked builders).
- **Smart alerts v1**: `alerts` + `alert_triggers` tables, worker (`src/lib/alerts/worker.ts`),
  admin run-worker endpoint, `/alerts` dashboard page, test-trigger endpoint. Email via Resend.
- **RSS feeds**: public per-saved-search feed `/api/feeds/$searchId.xml`, rate limited.
- **Claimable profiles**: claim request + verify endpoints, claim fields on `builders`,
  `/api/builders/$builderId/claim`, gist/bio verification (`claim/verify.ts`).
- **Onboarding**: `onboarding_progress`, status/complete/skip endpoints, `/onboarding` routes.
- **Billing v1 (manual, no Stripe)**: `plans` table (legacy, per-user, migration-evidence only),
  `organization_entitlements` (canonical, per-org — see `security-and-multitenancy`),
  `PLAN_LIMITS`/`PLAN_PRICING` in `billing-shared.ts` (free/pro/team: $0/$19/$199), limit
  enforcement (`billing.ts`, `repositories/entitlements.ts`), plan-change requests + admin approval
  (`plan_requests`, admin UI). **No payment processor yet** — `stripe-billing-platform` plan is
  `in_progress` (dependency contracts pinned in `src/shared/lib/billing/`; see
  `docs/operations/stripe-launch-register.md` for launch gates). It supersedes `pricing-and-billing`.
- **Legal & privacy**: /legal/\* pages, consent API, data export requests, account deletion.
- **Status & trust**: /status page, incidents (+admin), health endpoint, metrics (admin).
- **Changelog + roadmap**: public pages, votes, admin CRUD.
- **Landing/marketing**: redesigned landing, /pricing, /explore, /blog (file-based posts in
  `content/posts/`, `blog.ts`), OG image endpoint, sitemap/robots.
- **Admin panel**: users, metrics, incidents, changelog, roadmap, plan-requests.
- **Outreach v1 (rule-based, NO LLM)**: `src/shared/lib/outreach.ts` — template generator,
  3 tones (casual/professional/geek), hook selection from bio/repos/topics.
  UI: `src/modules/builder-profile/components/OutreachCopilot.tsx`.
- **Code-style fingerprinting v1 (heuristic, NO LLM)**: `src/shared/lib/code-style.ts` —
  per-language heuristic vectors, stored per builder.
- **Project hygiene v1 (heuristic)**: `src/shared/lib/hygiene.ts` + `HygieneCard.tsx`.

## NOT implemented (zero code)

- Any LLM call, any AI API key, any embedding/vector infra.
- Sources: bluesky, devpost, producthunt, indiehackers.
- Teams/organizations of any kind; sharing; activity feed.
- Semantic search, AI enrichment persona cards, sourcing sprints workspace,
  work-sample analysis, technical sandbox, team synergy, portfolio builder,
  unified timeline, proactive discovery worker.
- Stripe/any payment processor; waitlist.

## Env vars (env.ts today)

Required: `DATABASE_URL`, `APP_URL`, `VITE_APP_URL`, `BETTER_AUTH_SECRET`.
Optional: `GITHUB_TOKEN`, `REDDIT_CLIENT_ID/SECRET`, `STACKOVERFLOW_API_KEY`,
`HUGGINGFACE_TOKEN`, `GITLAB_TOKEN`, `CODEBERG_API_URL/TOKEN`, `HASHNODE_API_KEY`,
`SOURCEHUT_TOKEN`, `RESEND_API_KEY`, `REDIS_URL`, `ADMIN_USER_IDS`.
**No AI keys exist yet** — the AI platform plan introduces them (see `ai-policy.md`).

## Known structural constraints every plan must respect

1. `plans.userId` is the primary key — organization billing requires the
   `security-and-multitenancy` entitlement migration before Team UI or shared resources.
2. `builders` is per-user — global features (semantic index, proactive discovery, public
   portfolios) need an explicit answer for the per-user vs global tension.
3. No background job runner exists. The alerts worker runs via an admin-triggered endpoint
   (`/api/admin/alerts/run-worker`) — designed to be hit by an external cron (Coolify/VPS cron).
   New background work should follow this same pattern (idempotent HTTP-triggered workers),
   NOT invent a queue system unless a plan explicitly justifies one.
4. Search results are ephemeral (cache TTL) — anything needing durable profiles must write
   through to `builders` or a new table.
5. All money is manual (admin approves plan changes). Do not assume Stripe webhooks exist.
6. `userId` is not a multi-tenant boundary. Before team/shared/private persisted expansion, implement
   `security-and-multitenancy`: Better Auth organizations, active tenant context, normalized public
   identity vs tenant tracking, organization entitlements, composite tenant FKs, non-owner runtime
   roles, and PostgreSQL RLS.
