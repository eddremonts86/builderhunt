# Production Infrastructure (Self-Hosted, Lean)

> **Status**: `implemented`
> **Depends on**: [`security-and-multitenancy`](../01-security-and-multitenancy/spec.md) for database-role, RLS, restore, and tenant-aware production enforcement; existing non-database operations may proceed independently
> **Blocks**: [`waitlist-launch`](../../phase-1/54-waitlist-launch/spec.md), [`ai-expansion`](../21-ai-expansion/spec.md), [`semantic-search`](../22-semantic-search/spec.md)
> **Reality check**: Production is live: multi-stage `Dockerfile` + `server.prod.mjs` +
> `start.sh`, Coolify push-to-deploy on a Hetzner VPS, migrations via Coolify
> `post_deployment_command` (`drizzle-kit migrate`; runtime files are copied into the image —
> see Dockerfile comment), optional Redis (`src/shared/lib/redis.ts`) with in-memory
> fallbacks, Redis-backed rate limiting (`src/shared/lib/rate-limit.ts`), structured logging
> (`src/shared/lib/log.ts` + tests), in-process metrics + `/api/admin/metrics`, local
> `pg_dump` backup script (`scripts/db/backup.ts`). `VITE_SENTRY_DSN` exists in `.env` but is
> wired to **nothing** in `src/`.

## Problem

The app runs in production, but operational safety nets are incomplete: backups exist as a
script whose cron is unverified and which has no restore counterpart, there is no runbook,
the stray Sentry env var suggests error tracking that doesn't exist, and two incoming plans
(AI platform, semantic search) add production requirements (secrets, a pgvector Postgres
image) that must be handled deliberately.

## Goal

A boring, documented single-VPS production: verified daily backups with a tested restore
path, one consolidated cron list, a runbook, honest observability (structured logs +
metrics — no phantom Sentry), and the production groundwork for the AI plans (secret
management, pgvector image migration path).

## Non-goals

- No paid observability (Sentry/PostHog/Datadog/PagerDuty) for v1 — structured stdout logs +
  `/api/admin/metrics` + the status page are the launch answer. Revisit at real traffic.
- No multi-server, autoscaling, Kubernetes, CDN layer, or queue system (per
  `_meta/app-reality.md` constraint 3: background work = idempotent HTTP workers + VPS cron).
- No S3-compatible off-site backups at launch — local-disk daily dumps first; off-site is an
  explicit fast-follow task, not a blocker.

## Delivered (audited 2026-07-19)

- **Container build**: `Dockerfile` — node:22 slim, pnpm via corepack, multi-stage
  (deps → build → runtime), copies `drizzle/`, `drizzle.config.ts`, `scripts/` into the image
  specifically so Coolify's `post_deployment_command` can run `drizzle-kit migrate` + seeds.
- **Runtime**: `server.prod.mjs` (bridges the TanStack Start fetch handler to node http,
  loads `.env.docker`, static file serving), `start.sh` (env loader + exec).
- **Deploy**: Coolify on Hetzner, push-to-deploy via Coolify API (GitHub Actions →
  Coolify webhook). Local dev DB/Redis via `docker-compose.yml` (profiles: standalone).
- **Redis (optional)**: `src/shared/lib/redis.ts`; search caching (`src/lib/search.ts`) and
  rate limiting fall back to in-memory when `REDIS_URL` is unset.
- **Rate limiting**: `src/shared/lib/rate-limit.ts`, applied in `api/search/builders.ts`,
  `api/recommendations/index.ts`, `api/queries/index.ts`, `api/builders/$builderId/claim.ts`,
  `api/alerts/index.ts`.
- **Observability v1**: `src/shared/lib/log.ts` (JSON logs + `logged()` wrapper, 6 tests),
  `src/shared/lib/metrics.ts` (in-process counters), `GET /api/admin/metrics` (DB-derived
  stats + counters), shallow `GET /api/health` for container healthchecks (deep checks live
  in `/api/status`, deliberate split).
- **Backups (script only)**: `scripts/db/backup.ts` — `pg_dump | gzip` to `BACKUP_DIR`
  (default `/var/backups/builderhunt`), 30-day retention, `BACKUP_KEEP` env.
- **Worker pattern**: `POST /api/admin/alerts/run-worker` — the template all cron-driven work
  follows.

## Remaining work (each gap cited)

1. **Backup cron unverified + no restore script**: `scripts/db/` contains `backup.ts`,
   `create-db.ts`, `seed-admin.ts` — no `restore.ts`, and nothing in the repo proves the VPS
   crontab runs the backup. A backup that has never been restored is a hope, not a backup.
2. **No runbook**: `docs/` contains only `superpowers/` plan archives — no deploy/rollback/
   restore/cron documentation. Bus-factor 1.
3. **Phantom Sentry**: `.env`/`.env.example:25` define `VITE_SENTRY_DSN`, but no file in
   `src/` references Sentry and `env.ts` doesn't validate it. Either wire it or delete it —
   decision: **delete for v1** (lean scope), keep structured logs.
4. **Consolidated cron inventory**: crons now span backups + `api/admin/alerts/run-worker` +
   (incoming) `api/admin/legal/run-worker` (legal plan) + `api/admin/status/snapshot`
   (status plan). One documented crontab, one shared `CRON_SECRET` convention.
5. **Log rotation**: docker's default json-file driver is unbounded on a small VPS disk.
6. **NEW — AI secrets management** (from [`ai-expansion`](../21-ai-expansion/spec.md) /
   `_meta/ai-policy.md`): production env for `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`,
   `MINIMAX_MODEL`, `AI_EMBEDDING_URL`, `AI_EMBEDDING_MODEL`,
   `AI_EMBEDDING_API_KEY`, `AI_EMBEDDING_DIM`, `AI_EMBEDDING_TIMEOUT_MS`, `AI_DISABLED`,
   `AI_DISABLED_TASKS` — set via Coolify app env (never committed), with the kill-switch
   procedure (`AI_DISABLED=true` + redeploy/restart) documented in the runbook.
7. **NEW — pgvector production migration** (from
   [`semantic-search`](../22-semantic-search/spec.md)): the production Postgres is a Coolify
   database resource on a plain `postgres:16` image; pgvector requires switching that
   resource's image to `pgvector/pgvector:pg16` (same major — the data volume is
   compatible), then `CREATE EXTENSION vector`. Must happen with a fresh verified backup and
   a documented rollback (revert image; extension-less DB still runs if the migration hasn't
   applied). Local `docker-compose.yml` `db` service gets the same image swap for dev parity.

## Success metrics

- Restore drill completed: yesterday's production dump restored into a scratch DB with row
  counts matching (documented in the runbook, repeated monthly).
- Every cron job listed in one runbook section; each hits an idempotent endpoint that logs
  its run.
- Zero secrets in the repo; all production env managed in Coolify.
- pgvector switch executed with < 5 min DB downtime when semantic-search needs it.

## Resolved questions

- Sentry: removed for v1 (was never wired). Structured logs + metrics + status page suffice
  pre-traffic.
- Off-site backups: fast-follow after launch (Hetzner Storage Box or Cloudflare R2 — pick at
  implementation time; interface is "copy the newest dump after the local backup succeeds").
- Migrations on deploy: keep Coolify `post_deployment_command` running `drizzle-kit migrate`
  — no in-container entrypoint migration (avoids racing multiple containers).
