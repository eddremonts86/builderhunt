# Plan: Production Infrastructure

> **Status**: `implemented`
> **Depends on**: [`security-and-multitenancy`](../01-security-and-multitenancy/plan.md) for database-role, RLS, restore, and tenant-aware production enforcement; existing non-database operations may proceed independently
> **Blocks**: [`waitlist-launch`](../54-waitlist-launch/spec.md), [`ai-expansion`](../21-ai-expansion/spec.md), [`semantic-search`](../22-semantic-search/spec.md)
> **Reality check**: Docker/Coolify/Hetzner deploy, optional Redis, rate limiting, structured
> logs, metrics, and a local backup script are all live (see spec). Remaining work is
> operational hardening plus production groundwork for the AI plans.

## Phases

### Phase 0 — Delivered (2026-07)

Dockerfile + server.prod.mjs + start.sh, Coolify push-to-deploy, migrations via
`post_deployment_command`, Redis-optional caching + rate limiting, log.ts/metrics.ts,
health/status split, `scripts/db/backup.ts`.

### Phase 1 — Backup safety (launch-blocking, ~half a day)

Restore script, verified daily backup cron on the VPS, one successful restore drill,
documented in the runbook. Nothing else in this plan matters if this is broken.

### Phase 2 — Runbook + hygiene (launch-blocking, mostly writing)

`docs/runbook.md` (deploy, rollback, migrations, backup/restore, consolidated cron table,
kill-switches), delete the phantom `VITE_SENTRY_DSN`, configure docker log rotation on the
VPS.

### Phase 3 — AI production groundwork (when `ai-expansion` starts)

MiniMax env vars into Coolify (staging values first if a preview env exists), kill-switch
drill (`AI_DISABLED=true`), runbook section. No code here — `env.ts` changes belong to
`ai-expansion`.

### Phase 4 — pgvector image migration (when `semantic-search` starts, before its migrations)

Fresh backup → switch Coolify DB resource image `postgres:16` → `pgvector/pgvector:pg16` →
restart → `CREATE EXTENSION vector` → verify app healthy → same swap in local
`docker-compose.yml`. Documented rollback: revert image (extension DDL only exists after
semantic-search's migration runs).

### Phase 5 — Fast-follows (post-launch)

Off-site backup copy (Hetzner Storage Box or R2), optional external uptime pinger. Explicitly
not launch-blocking.

## Risks

| Risk                                                            | Likelihood | Mitigation                                                                                                                                       |
| --------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backup cron silently dies                                       | Medium     | Backup script exits non-zero on failure; cron wraps with a log line; runbook includes a "check newest dump age" one-liner; restore drill monthly |
| Single-disk failure loses DB + local backups                    | Low-Med    | Accepted for launch (documented); Phase 5 off-site copy closes it                                                                                |
| pgvector image swap corrupts data                               | Low        | Same Postgres major (volume-compatible); fresh verified backup immediately before; rollback = revert image                                       |
| Coolify post_deployment_command drift (migrations stop running) | Low        | Runbook records the exact command; deploy checklist includes checking migration output in deploy logs                                            |
| Secrets leak via .env files in image                            | Low        | `.env.docker` is created empty in the image; real values injected by Coolify env; runbook forbids committing env files                           |

## Rollback

- App deploys: Coolify redeploy of the previous image (documented in runbook).
- DB: restore newest dump via `scripts/db/restore.ts` (Phase 1).
- pgvector: revert the DB resource image; app runs unchanged until semantic-search migrations
  exist.
