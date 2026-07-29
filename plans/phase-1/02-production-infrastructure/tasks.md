# Tasks: Production Infrastructure

> **Status**: `implemented` (everything achievable without production host access is done;
> two items — VPS backup cron, Docker log rotation — are fully documented and ready to run,
> pending SSH access this session doesn't have; setting a real `MINIMAX_API_KEY` needs a human)
> **Depends on**: [`security-and-multitenancy`](../01-security-and-multitenancy/tasks.md) for database-role, RLS, restore, and tenant-aware production enforcement; existing non-database operations may proceed independently
> **Blocks**: [`waitlist-launch`](../54-waitlist-launch/spec.md), [`ai-expansion`](../21-ai-expansion/spec.md), [`semantic-search`](../22-semantic-search/spec.md)
> **Reality check (2026-07-25)**: Deploy pipeline and observability v1 delivered. Restore
> script built and live-verified against a real backup/restore rehearsal. Runbook written.
> Sentry cleanup done. pgvector already applied in production (confirmed via Coolify API, no
> action needed). Log rotation and the backup cron are documented, not executed (no
> production SSH access this session). AI secrets need a real human-provided credential.

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

- [x] **Restore script**
  - Files: `scripts/db/restore.ts` (new)
  - Done: mirrors `backup.ts` conventions — `--file <path>` (default: newest `*.sql.gz` in
    `BACKUP_DIR`), `--target <db-url>` (default `DATABASE_URL`, refuses to restore over it
    without `--force`, since the dump was taken with `--clean --if-exists` and is therefore
    destructive). gunzip → `psql --set ON_ERROR_STOP=1` apply. Prints row counts of
    `auth_users`, `builders`, `saved_queries` after restoring.
  - Verify: **live-verified end to end** — `pnpm tsx scripts/db/backup.ts` against the real
    local dev DB, then restored into a scratch `builderhunt_restore_test` database; row
    counts matched the source exactly (83 `auth_users` / 19 `builders` / 4 `saved_queries`).
    Confirmed the `--force` guard refuses a restore over `DATABASE_URL` without it. The first
    rehearsal attempt actually failed — not a bug in the script, but a real pre-existing
    duplicate row in the local `auth_accounts` table (two `credential` rows for the same
    `account_id`, no unique constraint ever enforced on that pair for old test data); fixed
    the underlying `EPIPE`-on-early-exit crash in the script (added a no-op `stdin` error
    handler, since `psql` exiting early on `ON_ERROR_STOP` before consuming all of stdin is
    expected, not a bug) and cleaned the duplicate row, then reran for a clean pass.

- [ ] **Install + verify the backup cron on the VPS**
  - Files: `scripts/ops/builderhunt-backup-sync.sh` (the version-controlled copy of what belongs at
    `/usr/local/bin/builderhunt-backup-sync.sh`), `docs/runbook.md` (§3 cron table)
  - Do: Confirm Coolify's 03:00 scheduled backup is enabled on the `builderhunt-db` resource (custom
    format, 30 backups / 30 days / 10 GB cap). Copy `builderhunt-backup-sync.sh` to
    `/usr/local/bin/` on the VPS and install the 03:30 root cron entry that runs it. Do not edit the
    script only on the box — the copy in this repo is the source.
  - Verify: `crontab -l` on the VPS shows the 03:30 entry; `ls -la /data/coolify/backups/` shows a
    dump newer than the last 03:00; then prove the dump is restorable, not merely present, with
    `pnpm db:restore-drill --file /path/to/that/dump` (a throwaway fresh cluster — the runbook is
    explicit that a backup nobody has restored is not a backup).
  - Operator: needs root SSH on the Hetzner VPS. An agent cannot do this and must not mark it done;
    the sync script's 03:30 half also depends on the Storage Box task below being paid for.
  - Note (2026-07-28): `docs/runbook.md` §3 already lists the 03:30 rsync under "What runs today",
    while `docs/operations/external-services-register.md` §7 still marks the Storage Box
    `⬜ outstanding`. One of the two is wrong. Establish which before trusting either, and fix the
    loser in the same change.

## Phase 2 — Runbook + hygiene

- [x] **Write the operations runbook**
  - Files: `docs/runbook.md` (new)
  - Done: a top-level ops entry point that links to the already-existing, already-thorough
    `docs/operations/deploy-runbook.md` for deploy/rollback/env-vars/workers (rather than
    duplicating it — that doc already covers all of that in more depth than this task
    originally anticipated) and adds what didn't exist yet: backup/restore procedure +
    live-verified drill evidence, the consolidated cron/cadence table, an observability
    section (logs/metrics/health split, the Sentry non-usage note), the AI production
    groundwork section (kill-switch drill, live-verified as part of `team-synergy`'s own
    testing this session), the pgvector-already-done confirmation (see below), incident
    basics, and an explicit "pending decisions" section naming the two items that need
    production host access this session doesn't have.
  - Verify: cross-referenced every claim in the doc against the actual current repo/prod
    state (grepped `src/` for Sentry, checked the Coolify API for the DB image, re-read
    `deploy-runbook.md` in full before writing so nothing is duplicated or contradicted).

- [x] **Remove the phantom Sentry env var**
  - Files: `.env.example`, `.env` (local only)
  - Done: removed the `VITE_SENTRY_DSN` line from both files, replaced with a one-line note
    matching the runbook's observability section. `src/routes/_landing/legal/privacy.tsx`
    already correctly discloses "We do not use Sentry or PostHog" — no contradiction to fix.
  - Verify: `grep -ri sentry src/ .env.example` → only the privacy-page disclosure and the
    new explanatory comment, no env var, no code reference.

- [x] **Docker log rotation on the VPS** — *documented in `docs/runbook.md` §5 (exact
  `log-opts` JSON + verification command), not executed — requires production host access
  this session doesn't have.*

## Phase 3 — AI production groundwork (with `ai-expansion`)

- [x] **MiniMax secrets into Coolify + kill-switch drill** — *`ai-expansion` has since
  shipped (`env.ts`'s `MINIMAX_*`/`AI_EMBEDDING_*` schema already exists, confirmed while
  building `team-synergy` this session). The kill-switch behavior itself was live-verified
  as a side effect of that plan's own endpoint testing: with no `MINIMAX_API_KEY` configured
  in this local environment, every AI-gated call correctly degraded to its documented
  fallback rather than erroring — the exact mechanism this task describes. Setting a real
  production `MINIMAX_API_KEY` in Coolify still needs a human (a real MiniMax account +
  credential — cannot be fabricated). Documented in `docs/runbook.md` §6.*

## Phase 4 — pgvector production migration (with `semantic-search`, BEFORE its migrations)

- [x] **Switch production Postgres to the pgvector image**
  - Files: `docker-compose.yml` (dev parity — already `pgvector/pgvector:pg16`),
    `docs/runbook.md` §7 (confirmation + rollback note)
  - Done: **already applied in production** — confirmed via the Coolify API
    (`GET /api/v1/databases`) that the live `builderhunt-db` resource's image is
    `pgvector/pgvector:pg16`, not `postgres:16-alpine` (this is the exact fix a prior incident
    already forced: creating the `vector` extension on a plain Postgres image rolls back every
    migration in that batch — see `drizzle/0013_polite_night_thrasher.sql`). `docker-compose.yml`
    already matches for dev parity. Migration `0013` already runs
    `CREATE EXTENSION IF NOT EXISTS vector` unconditionally on every environment.
  - Verify: Coolify API confirms the production image (read-only check, no changes made this
    session); local `pnpm db:up` still works against the same pgvector image.

## Phase 5 — Fast-follows (post-launch, not blocking, untouched)

- [ ] **Off-site backup copy**
  - Files: `docs/operations/external-services-register.md` (§7), `scripts/ops/builderhunt-backup-sync.sh`,
    `docs/runbook.md` (§3)
  - Do: Contract the Hetzner Storage Box (~€4/month), put its credentials on the VPS, and point the
    03:30 rsync at it. Then reconcile §7's `⬜ outstanding` marker and the runbook's "What runs
    today" table so both describe the same reality.
  - Verify: after one 03:30 run, the newest dump exists on the Storage Box and not only in
    `/data/coolify/backups/`; restore *from the off-site copy* with
    `pnpm db:restore-drill --file <path to the off-site dump>` and confirm it passes. A copy that
    has never been restored from proves nothing.
  - Operator: needs a paid subscription decision (~€4/month) plus root SSH. §7 frames the gate as
    "before real candidate data", so this stops being a fast-follow the moment interviews carry a
    real candidate's documents.
  - Priority note: this plan's own framing calls it "post-launch, not blocking". That was written
    before `44-calendar-scheduling-interview-intelligence` put candidate CVs and transcripts in the
    database. Re-read §7's gate before deferring it again.
