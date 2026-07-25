# Operations Runbook

The single entry point for "how do I operate this thing in production." Deploy mechanics
already have a dedicated, detailed doc — this file covers the rest (backup/restore, the
consolidated cron table, env var inventory, observability, and incident basics) and links out
rather than duplicating.

Companion docs: [`operations/deploy-runbook.md`](./operations/deploy-runbook.md) (deploy flow,
Coolify setup, env var inventory, workers/cron table, rollback, troubleshooting — read this
first for anything deploy-shaped), [`operations/database-migrations.md`](./operations/database-migrations.md),
[`operations/database-roles.md`](./operations/database-roles.md).

---

## 1. Deploy + rollback

Covered in full in [`operations/deploy-runbook.md`](./operations/deploy-runbook.md). The
short version: `git push` → Coolify builds the Dockerfile → `post_deployment_command` runs
`pnpm deploy:db` (the migration/role-provisioning orchestrator, `scripts/deploy/orchestrate.mjs`)
→ release live. Rollback = redeploy the previous image in Coolify; migrations are forward-only,
never edited after shipping.

## 2. Backup + restore

- **Daily backup** (`scripts/db/backup.ts`): `pg_dump --no-owner --no-acl --clean --if-exists`,
  gzipped, written to `BACKUP_DIR` (default `/var/backups/builderhunt`), 30-day retention
  (`BACKUP_KEEP`).
- **Restore** (`scripts/db/restore.ts`, new): mirrors `backup.ts`'s conventions.
  ```sh
  # Restore the newest backup in BACKUP_DIR into a scratch DB (safe, no --force needed):
  pnpm tsx scripts/db/restore.ts --target postgresql://user:pass@host/builderhunt_restore_test

  # Restore a specific file:
  pnpm tsx scripts/db/restore.ts --file /var/backups/builderhunt/builderhunt-20260101-....sql.gz --target <url>

  # Restore over DATABASE_URL itself (destructive — requires explicit confirmation):
  pnpm tsx scripts/db/restore.ts --force
  ```
  Prints row counts for `auth_users`/`builders`/`saved_queries` after restoring so a drill has
  an immediate correctness signal. **Live-verified 2026-07-25**: backed up the local dev DB,
  restored into a scratch database, row counts matched the source exactly (83/19/4). The
  rehearsal also caught a real pre-existing duplicate-row data-integrity issue in the local
  auth_accounts table (unrelated to this script) — worth remembering: a restore drill is a
  legitimate way to discover latent data problems, not just a mechanism test.
- **VPS backup cron** — not yet installed (requires SSH access to the production host; see
  `docs/runbook.md`'s pending-decisions note at the bottom). Once access is confirmed, add:
  ```
  0 3 * * * cd /path/to/app && DATABASE_URL=$DATABASE_URL pnpm tsx scripts/db/backup.ts >> /var/log/builderhunt-backup.log 2>&1
  ```
  Verify the next morning: a dated `.sql.gz` < 24h old exists, the log shows success, and a
  restore drill from that exact file passes (same command as above).
- **Off-site copy** (Phase 5, fast-follow, not blocking): after a successful local dump, copy
  it off-host (Hetzner Storage Box via rsync/sftp, or an S3-compatible bucket). Not implemented
  yet — the local backup + 30-day retention is the current safety net.

## 3. Consolidated cron / scheduled-job table

Every worker below already exists and is documented in detail (per-endpoint env, kill
switches) in [`operations/deploy-runbook.md`](./operations/deploy-runbook.md#workers--scrapers).
This table is just the operational cadence in one place:

| Cadence | Command |
|---|---|
| Daily 03:00 | `pnpm tsx scripts/db/backup.ts` (see §2 — not yet cron'd on the VPS) |
| Every 5 min | `curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" https://builderhunt.dev/api/admin/status/snapshot` |
| Hourly | `.../api/admin/devpost/run-worker` (dark in prod — see `plans/phase-1/devpost-integration`) |
| Per-plan cadence | `.../api/admin/discovery/run-worker`, `.../api/admin/enrichment/run-worker`, `.../api/admin/embeddings/run-worker`, `.../api/admin/alerts/run-worker`, `.../api/admin/billing/run-worker`, `.../api/admin/legal/run-worker`, `.../api/admin/sprints/run-worker` |

Every `run-worker` endpoint accepts either a platform-admin session or
`x-cron-secret: $CRON_SECRET` / `Authorization: Bearer $CRON_SECRET` (`tryCronPrincipal`) — the
latter is what an actual VPS crontab uses.

## 4. Env var inventory

`src/shared/lib/env.ts` is the schema of record — every variable the app reads is validated
there (optional vs. required, defaults, format). The critical subset for a fresh deploy is
tabulated in [`operations/deploy-runbook.md`](./operations/deploy-runbook.md#required-environment-variables-coolify-app-env--never-committed).
Never commit real values — `.env.example` documents the shape with empty/placeholder values.

## 5. Observability

- **Logs**: structured JSON via `src/shared/lib/log.ts`.
- **Metrics**: in-process counters, `GET /api/admin/metrics` (platform-admin only).
- **Health**: `GET /api/health` (shallow, container healthcheck) vs. `GET /api/status`
  (deep — DB, Redis, uptime history; public page at `/status`).
- **Error tracking**: structured logs only for v1 — no Sentry or other third-party error
  tracking/analytics provider is wired up or referenced anywhere in `src/` (confirmed via
  `grep -ri sentry src/`, which returns only the privacy page's own disclosure that no such
  provider has access to user data — consistent, not a stale claim). The phantom
  `VITE_SENTRY_DSN` line that used to sit in `.env.example`/`.env` referencing a provider
  `env.ts` never validated has been removed.
- **Docker log rotation** — not yet applied on the VPS (requires host access; see the
  pending-decisions note below). Procedure once access is confirmed: set the json-file driver
  limits for the app container, either in Coolify's container config or
  `/etc/docker/daemon.json`:
  ```json
  { "log-opts": { "max-size": "50m", "max-file": "5" } }
  ```
  then restart the daemon/container in a maintenance window. Verify: `docker inspect <app> |
  grep -A4 LogConfig` shows the limits; `/var/lib/docker/containers/*/*.log` disk usage stays
  bounded afterward.

## 6. AI production groundwork (plan: ai-expansion)

Coolify app env needs (once a real key is available): `MINIMAX_API_KEY` (secret),
`MINIMAX_BASE_URL` (default `https://api.minimax.io`), `MINIMAX_MODEL=MiniMax-M3`,
`AI_EMBEDDING_URL`, `AI_EMBEDDING_MODEL`, `AI_EMBEDDING_API_KEY`, `AI_EMBEDDING_DIM=1536`,
`AI_EMBEDDING_TIMEOUT_MS=30000`. Leave `AI_DISABLED`/`AI_DISABLED_TASKS` unset for normal
operation. **Kill-switch drill**: set `AI_DISABLED=true` in Coolify → restart → every
`/api/ai/*` route and every AI-backed feature (persona cards, outreach drafts, team-synergy,
etc.) degrades to its rule-based fallback instead of 500ing — this is the exact mechanism
this session's `team-synergy` plan relies on for its baseline rung, and was live-verified
locally (no `MINIMAX_API_KEY` in this dev environment) as part of that plan's own testing:
every AI-gated endpoint returned its documented `degraded: true` fallback rather than erroring.
**Not yet done in production**: setting a real `MINIMAX_API_KEY` — this requires a real
provider account/credential a human must create and paste into Coolify; cannot be fabricated
or obtained autonomously (per this session's standing safety constraints). `git grep
MINIMAX_API_KEY` shows only `env.ts` and docs referencing the variable name, never a value.

## 7. pgvector (plan: semantic-search / production-infrastructure Phase 4)

**Already done** — confirmed via the Coolify API (`GET /api/v1/databases`) that the production
`builderhunt-db` resource's image is already `pgvector/pgvector:pg16`, not `postgres:16-alpine`
(this matches a hard lesson from a prior incident: creating the `vector` extension on a plain
Postgres image rolls back every migration in that batch, per `drizzle/0013_polite_night_thrasher.sql`).
`docker-compose.yml`'s local `db` service already uses the same image for dev parity. Rollback,
if ever needed: revert the Coolify database resource's image back to `postgres:16-alpine` — the
data volume is compatible between the two since they share the same Postgres major version;
anything relying on the `vector` extension (semantic search) would need to fall back to its
keyword-search path, which it already does when the extension/embeddings resource is
unreachable.

## 8. Incident basics

1. Check `GET /api/status` (public) and `GET /api/admin/metrics` (platform-admin) first —
   most incidents show up as a red status card or an obvious metric spike/drop.
2. `docker logs <app-container>` (or the Coolify UI's log viewer) for the actual stack trace.
3. Cross-reference against [`operations/deploy-runbook.md`](./operations/deploy-runbook.md#troubleshooting--the-usual-breaks)'s
   troubleshooting table — most production breaks so far have been one of: role password not
   provisioned, `DATABASE_*_URL` mismatch, lockfile drift, or the pgvector extension missing.
4. Open an incident on `/admin/incidents` (internal status-and-trust admin tool) so it's
   visible on the public `/status` page and there's a durable record for the postmortem.
5. For a suspected data problem: don't guess — run a restore drill (§2) against a scratch DB
   to inspect a known-good snapshot before touching production data.

---

## Pending decisions (require a human / production access this session doesn't have)

- **VPS backup cron install** (§2) and **Docker log rotation** (§5) both require SSH access to
  the production Hetzner host to execute, not just document — flagged here rather than
  executed autonomously, since both are live changes to the shared production host, not a
  code change reviewable in a PR.
- **Real `MINIMAX_API_KEY`** (§6) — needs an actual MiniMax provider account and credential; a
  human must create and paste it into Coolify.
