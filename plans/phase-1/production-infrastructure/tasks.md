# Tasks: Production Infrastructure

> **Status**: `partially-implemented`
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/tasks.md) for database-role, RLS, restore, and tenant-aware production enforcement; existing non-database operations may proceed independently
> **Blocks**: [`waitlist-launch`](../waitlist-launch/spec.md), [`ai-expansion`](../ai-expansion/spec.md), [`semantic-search`](../semantic-search/spec.md)
> **Reality check**: Deploy pipeline and observability v1 delivered (checked below).
> Remaining: backup safety, runbook, Sentry cleanup, log rotation, AI secrets, pgvector.

## Phase 0 — Delivered (audited against repo, 2026-07-19)

- [x] **Multi-stage Dockerfile (pnpm, runtime drizzle/scripts for post-deploy migrate)** — `Dockerfile`
- [x] **Production server bridge + env loading** — `server.prod.mjs`, `start.sh`
- [x] **Coolify push-to-deploy on Hetzner (API-triggered)** — Coolify app; migrations run via
      `post_deployment_command` (`drizzle-kit migrate`, see Dockerfile comment)
- [x] **Local dev services** — `docker-compose.yml` (postgres:16-alpine + redis:7-alpine,
      healthchecks, standalone profile)
- [x] **Optional Redis client with graceful fallback** — `src/shared/lib/redis.ts`; search
      cache (`src/lib/search.ts`); `REDIS_URL` optional in `src/shared/lib/env.ts`
- [x] **Redis-backed rate limiting on public endpoints** — `src/shared/lib/rate-limit.ts`,
      applied in `api/search/builders.ts`, `api/recommendations/index.ts`, `api/queries/index.ts`,
      `api/builders/$builderId/claim.ts`, `api/alerts/index.ts`
- [x] **Structured JSON logging + tests** — `src/shared/lib/log.ts`, `log.test.ts`
- [x] **In-process metrics + admin endpoint** — `src/shared/lib/metrics.ts`,
      `src/routes/api/admin/metrics/index.ts`
- [x] **Shallow container health endpoint (deep checks in /api/status by design)** —
      `src/routes/api/health.tsx`
- [x] **Local backup script (pg_dump→gzip, 30-day retention)** — `scripts/db/backup.ts`
- [x] **HTTP-cron worker template** — `src/routes/api/admin/alerts/run-worker.ts`

## Phase 1 — Backup safety

- [ ] **Restore script**
  - Files: `scripts/db/restore.ts` (new)
  - Do: Mirror `backup.ts` conventions: args `--file <path>` (default: newest in
    `BACKUP_DIR`) and `--target <db-url>` (default `DATABASE_URL`, refuse to restore over it
    without `--force`). gunzip → `psql` apply. Print row counts of `auth_users`, `builders`,
    `saved_queries` after restore.
  - Verify: `pnpm tsx scripts/db/backup.ts` then restore into a scratch DB
    (`postgresql://…/builderhunt_restore_test`) — row counts match the source.

- [ ] **Install + verify the backup cron on the VPS**
  - Files: none (ops; recorded in `docs/runbook.md` by the next task)
  - Do: On the Hetzner VPS add
    `0 3 * * * cd /path/to/app && DATABASE_URL=… pnpm tsx scripts/db/backup.ts >> /var/log/builderhunt-backup.log 2>&1`
    (or run inside the app container via `docker exec` — pick what Coolify makes durable and
    write it down). Confirm `pg_dump` client version matches server major.
  - Verify: Next morning `/var/backups/builderhunt/` contains a dated `.sql.gz` < 24h old;
    the log shows success; a restore drill from that file passes.

## Phase 2 — Runbook + hygiene

- [ ] **Write the operations runbook**
  - Files: `docs/runbook.md` (new)
  - Do: Sections: (1) deploy + rollback via Coolify (previous-image redeploy), incl. the
    exact `post_deployment_command` and how to read migration output; (2) backup/restore
    procedures + drill schedule; (3) **consolidated cron table** — backup 03:00, alerts
    worker (`POST /api/admin/alerts/run-worker`), legal purge worker
    (`POST /api/admin/legal/run-worker`, from `legal-and-compliance`), status snapshot
    (`POST /api/admin/status/snapshot` every 5 min, from `status-and-trust`), each with its
    auth header convention; (4) env var inventory referencing `src/shared/lib/env.ts` as the
    schema of record; (5) incident basics (check `/api/status`, `docker logs`, `/admin/metrics`,
    open incident on `/admin/incidents`). Note: Coolify app UUID lives in the deploy workflow
    secrets — do not hardcode it in docs.
  - Verify: A cold read of the runbook is enough to perform a deploy rollback and a restore
    drill without asking questions.

- [ ] **Remove the phantom Sentry env var**
  - Files: `.env.example`, `.env` (local only)
  - Do: Delete the `VITE_SENTRY_DSN` line (`.env.example:25`) — nothing in `src/` references
    Sentry and `env.ts` never validated it. Add a one-line "error tracking: structured logs
    only for v1" note to the runbook's observability section.
  - Verify: `grep -ri sentry src/ .env.example` returns only the legal/privacy page if
    anything (and that page must not claim Sentry as a processor — cross-check with
    `legal-and-compliance` Phase 3 task).

- [ ] **Docker log rotation on the VPS**
  - Files: none (ops; document in `docs/runbook.md`)
  - Do: Set the json-file driver limits for the app container (Coolify container config or
    `/etc/docker/daemon.json`: `"log-opts": {"max-size": "50m", "max-file": "5"}`) and
    restart the daemon/container in a maintenance window.
  - Verify: `docker inspect <app> | grep -A4 LogConfig` shows the limits; disk usage of
    `/var/lib/docker/containers/*/​*.log` stays bounded.

## Phase 3 — AI production groundwork (with `ai-expansion`)

- [ ] **MiniMax secrets into Coolify + kill-switch drill**
  - Files: none (Coolify env UI/API; runbook section in `docs/runbook.md`)
  - Do: When `ai-expansion` lands its `env.ts` schema, set in the Coolify app environment:
    `MINIMAX_API_KEY` (secret), `MINIMAX_BASE_URL` (default `https://api.minimax.io`),
    `MINIMAX_MODEL=MiniMax-M3`, `AI_EMBEDDING_URL`, `AI_EMBEDDING_MODEL`,
    `AI_EMBEDDING_API_KEY`, `AI_EMBEDDING_DIM=1536`, `AI_EMBEDDING_TIMEOUT_MS=30000`, and leave
    `AI_DISABLED`/`AI_DISABLED_TASKS` unset. Document the kill-switch: set `AI_DISABLED=true`
    in Coolify → restart → verify `/api/ai/*` returns disabled. Never commit any of these.
  - Verify: After deploy, an authed call to an AI endpoint succeeds; setting
    `AI_DISABLED=true` + restart disables it; `git grep MINIMAX_API_KEY` shows only
    `env.ts`/docs, no values.

## Phase 4 — pgvector production migration (with `semantic-search`, BEFORE its migrations)

- [ ] **Switch production Postgres to the pgvector image**
  - Files: `docker-compose.yml` (dev parity), `docs/runbook.md` (procedure); production
    change happens in Coolify
  - Do: (1) Run a backup + restore-drill (Phase 1 scripts) the same day. (2) In Coolify,
    change the database resource image `postgres:16-alpine` → `pgvector/pgvector:pg16`
    (same major — the data volume is compatible) and restart. (3)
    `CREATE EXTENSION IF NOT EXISTS vector;` as superuser (semantic-search's migration may
    also do this; extension creation needs the image regardless). (4) Update the `db` service
    image in `docker-compose.yml` to `pgvector/pgvector:pg16` for dev parity. (5) Record the
    rollback (revert image) in the runbook.
  - Verify: App healthy after restart (`/api/status` db ok); `SELECT extversion FROM
pg_extension WHERE extname='vector'` returns a version; local `pnpm db:up` still works.

## Phase 5 — Fast-follows (post-launch, not blocking)

- [ ] **Off-site backup copy**
  - Files: `scripts/db/backup.ts`, `docs/runbook.md`
  - Do: After a successful local dump, copy it off-host — pick Hetzner Storage Box (rsync/sftp)
    or Cloudflare R2 (S3 API) at implementation time; env-configured, skipped when unset.
    Retention: 14 remote copies.
  - Verify: Remote listing shows today's dump; delete the local file and restore from the
    remote copy in a drill.
