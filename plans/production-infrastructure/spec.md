# Feature: Production Infrastructure (Self-Hosted, No Paid Services)

## Scope (v1: bootstrap mode)

**No external paid services.** No Sentry, PostHog, Cloudflare Pro, UptimeRobot, PagerDuty, Datadog, etc.

v1 uses:
- **Redis** self-hosted (free, single container)
- **Structured logs** to stdout (consumed by journald / docker logs)
- **In-process metrics** at `/api/admin/metrics` (admin-only)
- **Health check** enhanced with all dependencies
- **Manual incident workflow** in `/admin/incidents` (no PagerDuty)
- **DB backups** to local disk + cron (no S3/R2)

When revenue justifies it, swap any of these for hosted equivalents. The interfaces stay the same.

## What we DO get (no cost)

### 1. Redis (self-hosted, single container)

**Why**: shared cache across instances, rate limiting, future job queue
**Container**: `redis:7-alpine`, 50MB RAM
**Use cases**:
- Cache `searchBuilders` results (5min TTL)
- Rate limiting (key per IP+endpoint, INCR + EXPIRE)
- Future: BullMQ for background jobs

**Files**:
- `src/shared/lib/redis.ts` — singleton client
- `src/lib/search.ts` — replace in-memory cache with Redis
- `src/shared/lib/rate-limit.ts` — Redis-backed limiter

### 2. Health check with all dependencies

`/api/health` returns:
```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 12345,
  "checks": {
    "db": "ok",
    "redis": "ok",
    "memory": "ok"
  }
}
```

Use this for: docker healthcheck, load balancer, status page.

### 3. Structured logging

`src/shared/lib/log.ts` — JSON-formatted logs to stdout:
```ts
log.info('search_executed', { userId, query, resultsCount, durationMs })
log.error('api_failure', { route, error: err.message, stack: err.stack })
```

In production, `docker logs` captures them. We can grep for errors. Later, ship to Loki/CloudWatch (cheap or free tier).

### 4. Admin metrics

`/api/admin/metrics` — admin-only:
- Active users (DAU, WAU, MAU)
- # of searches/day
- # of saved searches
- Cache hit rate
- p50/p95/p99 response times
- Top error messages (last 24h)

Computed in real-time from the DB and in-memory counters. No external service.

### 5. Manual incident workflow

`/admin/incidents`:
- Create incident: title, severity (minor/major/critical), description
- Status: investigating → identified → monitoring → resolved
- Affected components (db, redis, search, etc.)
- Public status page reads from this

No auto-detection. Admin notices via logs, user reports, or metrics. v2 can add auto-detection if needed.

### 6. DB backups to local disk

`scripts/db/backup.ts`:
- `pg_dump` → gzip → write to `/var/backups/builderhunt/`
- Cron: daily at 03:00 UTC
- Retention: 30 daily
- Restore drill: monthly

**No off-site backup** in v1. The single-disk failure mode is acceptable for bootstrap. When we have paying customers, add S3/R2 with versioning (free tiers available).

## What we DO NOT get (deferred)

- **Sentry** (error tracking with stack traces, source maps, alerts) → use stdout logs + admin metrics
- **PostHog / Plausible / GA** (product analytics) → use server-side event tracking in DB
- **Cloudflare** (CDN, DDoS protection) → use the server's nginx/Cloudflare-free-DNS-only
- **UptimeRobot** (uptime monitoring) → use a simple cron from another host that hits `/api/health`
- **PagerDuty** (incident alerts) → use email/Slack webhooks directly (free tier of Discord/Slack)

## Why this is OK for v1

At 0-1000 users:
- Error rate is low enough that grepping logs is fine
- Traffic is low enough that single-server Redis + Postgres is enough
- Incidents are rare enough that manual detection is fine
- Backup is to local disk; if the server dies, we lose the backup too — but we'd know quickly and have the data in git (schemas) and the source APIs (rebuild)

At 1000+ users or with paying customers:
- Add Sentry (free tier: 5k events/month)
- Add off-site backups (Cloudflare R2 free tier: 10GB)
- Add UptimeRobot (free tier: 50 monitors)
- These can be added incrementally, the interfaces are designed for swap.

## Implementation

### Phase 1: Redis + health

- [ ] Add `redis:7-alpine` to `docker-compose.yml`
- [ ] `pnpm add ioredis`
- [ ] `src/shared/lib/redis.ts` — singleton client
- [ ] Add `REDIS_URL` to env (default `redis://localhost:6379`)
- [ ] Refactor `src/lib/search.ts` to use Redis
- [ ] `src/shared/lib/log.ts` — structured logger
- [ ] Enhance `src/routes/api/health.tsx` — check DB, Redis, memory

### Phase 2: Rate limiting + metrics

- [ ] `src/shared/lib/rate-limit.ts` — Redis-backed
- [ ] Apply to public endpoints (search, recommendations, RSS)
- [ ] `src/shared/lib/metrics.ts` — in-process counters (searches, errors, cache hits)
- [ ] `src/routes/api/admin/metrics.ts` — admin-only metrics endpoint
- [ ] `src/shared/lib/events.ts` — server-side event tracking (track in DB)

### Phase 3: Incident management + backups

- [ ] `src/routes/api/admin/incidents.ts` — CRUD
- [ ] `src/routes/_dashboard/admin/incidents.tsx` — admin UI
- [ ] `scripts/db/backup.ts` — pg_dump to local
- [ ] Cron: `0 3 * * *` for backups
- [ ] Document restore procedure in `docs/runbook.md`

### Phase 4: Migration path

When we outgrow this:
- Add Sentry: replace `log.error` calls with `Sentry.captureException`
- Add PostHog: replace `trackEvent` calls with `posthog.capture`
- Add Cloudflare: point DNS to CF, enable caching/proxy
- Add UptimeRobot: point at /api/health from UR dashboard

The interfaces stay the same. The implementations change.

## Success metrics

- **Uptime**: 99% acceptable (single server, monthly restarts)
- **p95 response time**: < 500ms
- **Mean time to detect incident**: < 1h (manual via user reports + log review)
- **Backup success rate**: > 95% (one failure in 30 days acceptable)

## Out of scope (v1)

- Multi-region / multi-server
- Auto-scaling
- Kubernetes
- SOC2 / ISO27001
- DDoS mitigation beyond nginx defaults

## Estimated effort: 2 days
